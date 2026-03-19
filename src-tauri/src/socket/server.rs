use std::fs::OpenOptions;
use std::io::Write as IoWrite;
use std::path::Path;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixListener;
use tauri::{AppHandle, Emitter, Manager};

use crate::state::AppState;
use super::protocol::{SocketCommand, SocketResponse};
use super::SOCKET_PATH;

struct SocketLogger {
    file: std::fs::File,
}

impl SocketLogger {
    fn open() -> Option<Self> {
        let project_tmp = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tmp");
        let log_path = if project_tmp.is_dir() {
            project_tmp.join("herd-socket.log").to_string_lossy().to_string()
        } else {
            "/tmp/herd-socket.log".to_string()
        };
        log::info!("Socket traffic logging to {log_path}");
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .ok()
            .map(|file| Self { file })
    }

    fn log(&mut self, direction: &str, data: &str) {
        let now = chrono::Local::now().format("%H:%M:%S%.3f");
        let _ = writeln!(self.file, "[{now}] {direction} {}", data.trim());
    }
}

type SharedLogger = Arc<Mutex<Option<SocketLogger>>>;

pub async fn start(state: AppState, app_handle: AppHandle) {
    let path = Path::new(SOCKET_PATH);
    if path.exists() {
        let _ = std::fs::remove_file(path);
    }

    let listener = match UnixListener::bind(SOCKET_PATH) {
        Ok(l) => l,
        Err(e) => {
            log::error!("Failed to bind Unix socket at {SOCKET_PATH}: {e}");
            return;
        }
    };

    let logger: SharedLogger = Arc::new(Mutex::new(SocketLogger::open()));
    log::info!("Socket server listening on {SOCKET_PATH}");

    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                let state = state.clone();
                let app = app_handle.clone();
                let logger = logger.clone();
                tokio::spawn(async move {
                    handle_connection(stream, state, app, logger).await;
                });
            }
            Err(e) => {
                log::error!("Socket accept error: {e}");
            }
        }
    }
}

async fn handle_connection(
    stream: tokio::net::UnixStream,
    state: AppState,
    app: AppHandle,
    logger: SharedLogger,
) {
    let (reader, mut writer) = stream.into_split();
    let mut lines = BufReader::new(reader).lines();

    while let Ok(Some(line)) = lines.next_line().await {
        if let Ok(mut guard) = logger.lock() {
            if let Some(ref mut l) = *guard {
                l.log(">>>", &line);
            }
        }

        let response = match serde_json::from_str::<SocketCommand>(&line) {
            Ok(cmd) => handle_command(cmd, &state, &app),
            Err(e) => SocketResponse::error(format!("Parse error: {e}")),
        };

        let mut resp_json = serde_json::to_string(&response).unwrap_or_default();

        if let Ok(mut guard) = logger.lock() {
            if let Some(ref mut l) = *guard {
                l.log("<<<", &resp_json);
            }
        }

        resp_json.push('\n');
        if writer.write_all(resp_json.as_bytes()).await.is_err() {
            break;
        }
    }
}

fn handle_command(
    cmd: SocketCommand,
    state: &AppState,
    app: &AppHandle,
) -> SocketResponse {
    match cmd {
        SocketCommand::SpawnShell { x: _, y: _, width: _, height: _, parent_session_id: _ } => {
            match crate::commands::new_window(app.clone(), None) {
                Ok(window_id) => {
                    let snapshot = crate::tmux_state::snapshot(state);
                    let pane_id = snapshot
                        .ok()
                        .and_then(|snapshot| {
                            snapshot
                                .windows
                                .iter()
                                .find(|window| window.id == window_id)
                                .and_then(|window| window.pane_ids.first().cloned())
                        })
                        .unwrap_or(window_id);
                    SocketResponse::success(Some(serde_json::json!({
                        "session_id": pane_id,
                    })))
                }
                Err(e) => SocketResponse::error(e),
            }
        }

        SocketCommand::DestroyShell { session_id } => {
            match crate::tmux_state::kill_pane(&session_id) {
                Ok(()) => {
                    let _ = crate::tmux_state::emit_snapshot(app);
                    SocketResponse::success(None)
                }
                Err(e) => SocketResponse::error(e),
            }
        }

        SocketCommand::ListShells => {
            match crate::tmux_state::snapshot(state) {
                Ok(snapshot) => {
                    let list: Vec<serde_json::Value> = snapshot
                        .windows
                        .iter()
                        .filter_map(|window| {
                            let pane = snapshot.panes.iter().find(|pane| pane.window_id == window.id)?;
                            Some(serde_json::json!({
                                "id": pane.id,
                                "pane_id": pane.id,
                                "window_id": window.id,
                                "session_id": window.session_id,
                                "title": window.name,
                                "command": pane.command,
                            }))
                        })
                        .collect();
                    SocketResponse::success(Some(serde_json::json!(list)))
                }
                Err(e) => SocketResponse::error(e),
            }
        }

        SocketCommand::SendInput { session_id, input } => {
            match state.with_control(|ctrl| ctrl.writer.send_input_by_id(&session_id, input.as_bytes())) {
                Ok(()) => SocketResponse::success(None),
                Err(e) => SocketResponse::error(e),
            }
        }

        SocketCommand::ReadOutput { session_id } => {
            match state.with_control(|ctrl| ctrl.read_output(&session_id)) {
                Ok(output) => {
                    SocketResponse::success(Some(serde_json::json!({ "output": output })))
                }
                Err(e) => SocketResponse::error(e),
            }
        }

        SocketCommand::SetTitle { session_id, title } => {
            match crate::tmux_state::set_pane_title(&session_id, &title) {
                Ok(()) => {
                    let _ = crate::tmux_state::emit_snapshot(app);
                    SocketResponse::success(None)
                }
                Err(e) => SocketResponse::error(e),
            }
        }

        SocketCommand::SetReadOnly { session_id, read_only } => {
            let payload = serde_json::json!({
                "session_id": session_id,
                "read_only": read_only,
            });
            let _ = app.emit("shell-read-only", payload);
            SocketResponse::success(None)
        }

        SocketCommand::DomQuery { js } => {
            // Execute JS in the real Tauri webview. Result is written to a file
            // via the __write_dom_result Tauri command, then read back here.
            if let Some(webview) = app.webview_windows().values().next() {
                let result_file = "/tmp/herd-dom-result.json";
                let _ = std::fs::remove_file(result_file);

                let wrapped = format!(
                    r#"(function() {{
                        try {{
                            const __r = (function(){{ {js} }})();
                            const __s = JSON.stringify(__r === undefined ? null : __r);
                            window.__TAURI_INTERNALS__.invoke('__write_dom_result', {{ result: __s }});
                        }} catch(e) {{
                            window.__TAURI_INTERNALS__.invoke('__write_dom_result', {{ result: JSON.stringify("ERR:" + e.message) }});
                        }}
                    }})()"#
                );
                if let Err(e) = webview.eval(&wrapped) {
                    return SocketResponse::error(format!("eval failed: {e}"));
                }

                for _ in 0..40 {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                    if let Ok(data) = std::fs::read_to_string(result_file) {
                        let _ = std::fs::remove_file(result_file);
                        match serde_json::from_str::<serde_json::Value>(&data) {
                            Ok(val) => return SocketResponse::success(Some(val)),
                            _ => return SocketResponse::success(Some(serde_json::json!(data))),
                        }
                    }
                }

                SocketResponse::success(Some(serde_json::json!(null)))
            } else {
                SocketResponse::error("No webview found".into())
            }
        }

        SocketCommand::DomKeys { keys } => {
            // Simulate keyboard events in the real Tauri webview
            if let Some(webview) = app.webview_windows().values().next() {
                // keys format: "i", "Escape", "Shift+Escape", "a", etc.
                let js = format!(
                    r#"(function() {{
                        const keys = {keys_json};
                        for (const k of keys.split(' ')) {{
                            let key = k, shiftKey = false, ctrlKey = false;
                            if (k.includes('+')) {{
                                const parts = k.split('+');
                                key = parts[parts.length - 1];
                                shiftKey = parts.includes('Shift');
                                ctrlKey = parts.includes('Ctrl');
                            }}
                            const ev = new KeyboardEvent('keydown', {{
                                key: key, code: 'Key' + key.toUpperCase(),
                                shiftKey, ctrlKey, bubbles: true, cancelable: true
                            }});
                            window.dispatchEvent(ev);
                        }}
                    }})()"#,
                    keys_json = serde_json::to_string(&keys).unwrap_or_default(),
                );
                let _ = webview.eval(&js);
                std::thread::sleep(std::time::Duration::from_millis(200));
                SocketResponse::success(None)
            } else {
                SocketResponse::error("No webview found".into())
            }
        }

        SocketCommand::TmuxPaneCreated { tmux_session: _, parent_session_id: _, title: _ } => {
            // No longer needed — control mode detects panes automatically
            SocketResponse::success(None)
        }
    }
}

pub fn cleanup() {
    let path = Path::new(SOCKET_PATH);
    if path.exists() {
        let _ = std::fs::remove_file(path);
    }
}
