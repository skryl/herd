mod commands;
mod persist;
mod runtime;
mod socket;
mod state;
mod tmux;
mod tmux_control;
mod tmux_state;

use tauri::{Listener, Manager};
use state::AppState;

const DEFAULT_WEBVIEW_ZOOM: f64 = 1.5;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::get_tmux_state,
            commands::get_layout_state,
            commands::save_layout_state,
            commands::new_session,
            commands::kill_session,
            commands::select_session,
            commands::rename_session,
            commands::new_window,
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

            // Ensure tmux server and session exist
            let already_running = tmux::is_running();
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
            let herd_sock_env = format!("HERD_SOCK={}", runtime::socket_path());

            if !already_running {
                match tmux::output(&[
                    "new-session",
                    "-d",
                    "-s",
                    runtime::session_name(),
                    "-x",
                    "80",
                    "-y",
                    "24",
                    "-e",
                    &herd_sock_env,
                    &shell,
                ]) {
                    Ok(output) if output.status.success() => {
                        log::info!("Created tmux session '{}'", runtime::session_name())
                    }
                    Ok(output) => log::error!(
                        "Failed to create tmux session: {}",
                        String::from_utf8_lossy(&output.stderr).trim()
                    ),
                    Err(error) => log::error!("Failed to create tmux session: {error}"),
                }
            } else {
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
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(s) = app.try_state::<AppState>() {
                    s.save();
                }
                socket::server::cleanup();
                // Don't kill tmux — sessions survive restarts
            }
        });
}
