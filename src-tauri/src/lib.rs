mod commands;
mod persist;
mod socket;
mod state;
mod tmux;
mod tmux_control;

use tauri::{Manager, Emitter, Listener};
use state::AppState;

const SESSION_NAME: &str = "herd";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
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
            commands::spawn_log_shell,
            commands::tmux_restart,
            commands::tmux_tree,
            commands::save_tile_state,
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
            let server = tmux::server_name();
            let already_running = tmux::is_running();
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
            let herd_sock_env = format!("HERD_SOCK={}", socket::SOCKET_PATH);

            if !already_running {
                // Create the session with a real shell
                let status = std::process::Command::new("tmux")
                    .args(["-L", server, "new-session", "-d",
                           "-s", SESSION_NAME, "-x", "80", "-y", "24",
                           "-e", &herd_sock_env,
                           &shell])
                    .status();
                match status {
                    Ok(s) if s.success() => log::info!("Created tmux session '{SESSION_NAME}'"),
                    _ => log::error!("Failed to create tmux session"),
                }
            } else {
                log::info!("tmux server already running, reconnecting");
                let has_session = std::process::Command::new("tmux")
                    .args(["-L", server, "has-session", "-t", SESSION_NAME])
                    .status()
                    .map(|s| s.success())
                    .unwrap_or(false);
                if !has_session {
                    let _ = std::process::Command::new("tmux")
                        .args(["-L", server, "new-session", "-d",
                               "-s", SESSION_NAME, "-x", "80", "-y", "24",
                               "-e", &herd_sock_env,
                               &shell])
                        .status();
                }
            }

            // Prevent tmux from dying when last window closes
            let _ = std::process::Command::new("tmux")
                .args(["-L", server, "set", "-g", "status", "off"])
                .status();
            // Fast shell for teammate windows — no .zshrc means no init delay,
            // so Claude's send-keys won't race with shell startup
            let _ = std::process::Command::new("tmux")
                .args(["-L", server, "set", "-g", "default-command", "zsh --no-rcs"])
                .status();
            // exit-empty off: keep server alive even with 0 sessions
            let _ = std::process::Command::new("tmux")
                .args(["-L", server, "set", "-g", "exit-empty", "off"])
                .status();
            // When last window in session closes, don't destroy — create a new one
            let _ = std::process::Command::new("tmux")
                .args(["-L", server, "set-hook", "-g", "session-closed",
                       &format!("run-shell 'tmux -L {} new-session -d -s {} -e \"{}\" {}'",
                                server, SESSION_NAME, herd_sock_env, shell)])
                .status();

            // Start control mode connection
            let handle = app.handle().clone();
            match tmux_control::TmuxControl::start(SESSION_NAME, handle.clone()) {
                Ok(control) => {
                    let state = app.state::<AppState>();
                    state.set_control(control);
                    log::info!("tmux control mode connected to '{SESSION_NAME}'");
                }
                Err(e) => {
                    log::error!("Failed to start tmux control mode: {e}");
                }
            }

            // Auto-reconnect -CC when it crashes
            {
                let state_reconnect = app.state::<AppState>().inner().clone();
                let handle_reconnect = app.handle().clone();
                app.handle().listen("tmux-cc-disconnected", move |_| {
                    log::info!("tmux -CC disconnected, reconnecting in 1s...");
                    let state = state_reconnect.clone();
                    let handle = handle_reconnect.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_secs(1));
                        match tmux_control::TmuxControl::start(SESSION_NAME, handle) {
                            Ok(control) => {
                                state.set_control(control);
                                log::info!("tmux -CC reconnected");
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
