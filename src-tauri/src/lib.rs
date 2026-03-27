mod agent;
mod browser;
mod cli;
mod commands;
mod db;
mod network;
mod persist;
mod runtime;
mod session_config;
mod socket;
mod state;
mod tile_registry;
mod tile_message;
mod tmux;
mod tmux_control;
mod tmux_state;
mod work;

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

use tauri::{Listener, Manager};
use state::AppState;

const DEFAULT_WEBVIEW_ZOOM: f64 = 1.5;

fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn cli_shim_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join(".local/bin/herd"))
}

fn ensure_cli_shim() -> Result<(), String> {
    let Some(shim_path) = cli_shim_path() else {
        return Ok(());
    };
    let parent = shim_path
        .parent()
        .ok_or_else(|| "failed to resolve herd shim directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;

    let executable = std::env::current_exe()
        .map_err(|error| format!("failed to resolve current executable: {error}"))?;
    let script = format!(
        "#!/bin/sh\nexec {} \"$@\"\n",
        shell_single_quote(&executable.to_string_lossy())
    );

    let needs_write = match fs::read_to_string(&shim_path) {
        Ok(current) => current != script,
        Err(_) => true,
    };
    if needs_write {
        fs::write(&shim_path, script)
            .map_err(|error| format!("failed to write {}: {error}", shim_path.display()))?;
    }

    let mut permissions = fs::metadata(&shim_path)
        .map_err(|error| format!("failed to read {} metadata: {error}", shim_path.display()))?
        .permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&shim_path, permissions)
        .map_err(|error| format!("failed to chmod {}: {error}", shim_path.display()))?;

    Ok(())
}

fn connect_tmux_control(
    handle: tauri::AppHandle,
    state: &AppState,
    preferred_session: Option<String>,
) -> Result<String, String> {
    let mut last_error: Option<String> = None;
    let preferred_session = preferred_session.filter(|session| !session.trim().is_empty());

    if let Some(target) = preferred_session.clone() {
        match tmux_control::TmuxControl::start(&target, handle.clone()) {
            Ok(control) => {
                state.set_control(control);
                state.set_last_active_session(Some(target.clone()));
                return Ok(target);
            }
            Err(error) => {
                log::warn!("Failed to attach tmux control mode to '{target}': {error}");
                last_error = Some(error);
            }
        }
    }

    let fallback_session = match tmux_state::ensure_default_session() {
        Ok(name) => name,
        Err(error) => {
            log::error!("Failed to ensure a tmux session exists: {error}");
            runtime::session_name().to_string()
        }
    };

    if preferred_session.as_deref() == Some(fallback_session.as_str()) {
        return Err(last_error.unwrap_or_else(|| "failed to start tmux control mode".to_string()));
    }

    match tmux_control::TmuxControl::start(&fallback_session, handle) {
        Ok(control) => {
            state.set_control(control);
            state.set_last_active_session(Some(fallback_session.clone()));
            Ok(fallback_session)
        }
        Err(error) => Err(last_error.unwrap_or(error)),
    }
}

fn run_gui() {
    tauri::Builder::default()
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            browser::browser_extension_pages,
            browser::get_agent_browser_install_status,
            browser::set_agent_browser_install_declined,
            browser::install_agent_browser_runtime,
            browser::browser_webview_sync,
            browser::browser_webview_navigate,
            browser::browser_webview_load,
            browser::browser_webview_reload,
            browser::browser_webview_back,
            browser::browser_webview_forward,
            browser::browser_webview_hide,
            browser::browser_webview_preview,
            commands::get_tmux_state,
            commands::get_layout_state,
            commands::get_agent_debug_state,
            commands::get_work_items,
            commands::send_root_message_command,
            commands::send_direct_message_command,
            commands::send_public_message_command,
            commands::create_work_item,
            commands::delete_work_item,
            commands::approve_work_item,
            commands::improve_work_item,
            commands::read_work_stage_preview,
            commands::connect_network_tiles,
            commands::disconnect_network_port,
            commands::set_network_port_settings,
            commands::get_claude_menu_data_for_pane,
            commands::save_layout_state,
            commands::new_session,
            commands::kill_session,
            commands::select_session,
            commands::rename_session,
            commands::set_session_root_cwd,
            commands::set_session_browser_backend,
            session_config::list_saved_session_configurations,
            session_config::save_session_configuration,
            session_config::load_session_configuration,
            session_config::delete_session_configuration,
            commands::new_window,
            commands::spawn_agent_window,
            commands::spawn_browser_window,
            commands::split_pane,
            commands::kill_window,
            commands::kill_pane,
            commands::select_window,
            commands::resize_window,
            commands::rename_window,
            commands::set_pane_title,
            commands::create_pty,
            commands::destroy_pty,
            commands::write_pty,
            commands::read_pty_output,
            commands::resize_pty,
            commands::tmux_status,
            commands::read_log_tail,
            commands::clear_debug_logs,
            commands::sync_panes,
            commands::redraw_all_panes,
            commands::__write_dom_result,
            commands::__resolve_test_driver_request,
            commands::__set_test_driver_state,
            commands::spawn_log_shell,
            commands::tmux_restart,
            commands::tmux_tree,
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            if let Err(error) = ensure_cli_shim() {
                log::warn!("Failed to refresh ~/.local/bin/herd shim: {error}");
            }

            // Ensure tmux server and session exist
            let already_running = tmux::is_running();
            let mut seeded_session_id: Option<String> = None;

            if !already_running {
                match crate::commands::create_session_with_root_agent(
                    app.handle().clone(),
                    Some(runtime::session_name()),
                ) {
                    Ok(session_id) => {
                        seeded_session_id = Some(session_id);
                        log::info!("Created tmux session '{}'", runtime::session_name())
                    }
                    Err(error) => log::error!("Failed to create tmux session: {error}"),
                }
            } else {
                let _ = crate::tmux_state::set_session_env(
                    runtime::session_name(),
                    "HERD_SOCK",
                    runtime::socket_path(),
                );
                let _ = crate::tmux_state::ensure_session_root_cwd(runtime::session_name());
                log::info!("tmux server already running, reconnecting");
            }

            if let Some(webview) = app.get_webview_window("main") {
                if let Err(error) = webview.set_zoom(DEFAULT_WEBVIEW_ZOOM) {
                    log::warn!("Failed to set default webview zoom: {error}");
                }
            }

            let _ = tmux::output(&["set", "-g", "status", "off"]);
            let _ = tmux::output(&["set", "-g", "default-command", "zsh --no-rcs"]);
            let _ = tmux::output(&["set", "-g", "exit-empty", "off"]);
            // Start control mode connection
            let handle = app.handle().clone();
            let state = app.state::<AppState>();
            match connect_tmux_control(handle.clone(), state.inner(), state.last_active_session()) {
                Ok(attach_session) => {
                    log::info!("tmux control mode connected to '{attach_session}'");
                    let reuse_primary_pane = !already_running && seeded_session_id.is_none();
                    if let Ok(snapshot) = crate::tmux_state::snapshot(state.inner()) {
                        for session in snapshot.sessions {
                            let _ = crate::tmux_state::set_session_env(
                                &session.id,
                                "HERD_SOCK",
                                runtime::socket_path(),
                            );
                            if seeded_session_id.as_deref() == Some(session.id.as_str()) {
                                continue;
                            }
                            if let Err(error) = crate::commands::ensure_root_agent_for_session(
                                app.handle().clone(),
                                session.id.clone(),
                                reuse_primary_pane && session.id == attach_session,
                            ) {
                                log::warn!("Failed to ensure root agent for session {}: {error}", session.id);
                            }
                        }
                    }
                    if let Err(error) = crate::commands::reconcile_tmux_tile_registry(app.handle().clone()) {
                        log::warn!("Failed to reconcile tmux tile registry: {error}");
                    }
                    let _ = crate::tmux_state::emit_snapshot(&app.handle());
                }
                Err(e) => {
                    log::error!("Failed to start tmux control mode: {e}");
                }
            }

            // Auto-reconnect -CC when it crashes
            {
                let state_reconnect = app.state::<AppState>().inner().clone();
                let handle_reconnect = app.handle().clone();
                app.handle().listen("tmux-cc-disconnected", move |event| {
                    if state_reconnect.is_shutting_down() {
                        log::info!("Ignoring tmux -CC disconnect while Herd is shutting down");
                        return;
                    }
                    let disconnected_pid = serde_json::from_str::<i32>(event.payload()).ok();

                    if let Some(pid) = disconnected_pid {
                        if state_reconnect.current_control_pid() != Some(pid) {
                            log::info!("Ignoring stale tmux -CC disconnect from pid {pid}");
                            return;
                        }
                    }

                    log::info!("tmux -CC disconnected, reconnecting in 1s...");
                    let state = state_reconnect.clone();
                    let handle = handle_reconnect.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_secs(1));

                        if state.is_shutting_down() {
                            log::info!("Skipping tmux -CC reconnect because Herd is shutting down");
                            return;
                        }

                        if let Some(pid) = disconnected_pid {
                            if state.current_control_pid() != Some(pid) {
                                log::info!("Skipping stale tmux -CC reconnect for pid {pid}");
                                return;
                            }
                        }

                        let emit_handle = handle.clone();
                        let preferred_session = state.last_active_session();
                        match connect_tmux_control(handle, &state, preferred_session) {
                            Ok(session_name) => {
                                log::info!("tmux -CC reconnected to '{session_name}'");
                                if let Err(error) = crate::commands::reconcile_tmux_tile_registry(emit_handle.clone()) {
                                    log::warn!("Failed to reconcile tmux tile registry after reconnect: {error}");
                                }
                                let _ = crate::tmux_state::emit_snapshot(&emit_handle);
                            }
                            Err(e) => log::error!("tmux -CC reconnect failed: {e}"),
                        }
                    });
                });
            }

            // Start socket server
            let state = app.state::<AppState>().inner().clone();
            let handle2 = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                socket::server::start(state, handle2).await;
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if let Some(state) = window.try_state::<AppState>() {
                    if state.is_shutting_down() {
                        return;
                    }
                    state.begin_shutdown();
                }
                let app = window.app_handle();
                for (label, webview) in app.webviews() {
                    if label == "main" {
                        continue;
                    }
                    let _ = webview.close();
                }
                app.exit(0);
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            match event {
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                    if let Some(s) = app.try_state::<AppState>() {
                        s.begin_shutdown();
                        s.save();
                    }
                    socket::server::cleanup();
                    // Don't kill tmux — sessions survive restarts
                }
                _ => {}
            }
        });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run_entry(args: Vec<String>) {
    if cli::is_cli_invocation(&args) {
        if let Err(error) = cli::run(args) {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }

    run_gui();
}
