use std::fs::OpenOptions;
use std::io::Write as IoWrite;
use std::path::Path;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixListener;
use tauri::{AppHandle, Emitter, Manager};

use crate::state::AppState;
use crate::{runtime, tmux};

use super::protocol::{SocketCommand, SocketResponse, TestDriverRequest};

struct SocketLogger {
    file: std::fs::File,
}

impl SocketLogger {
    fn open() -> Option<Self> {
        let log_path = runtime::socket_log_path().to_string();
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

fn test_driver_enabled() -> bool {
    runtime::test_driver_enabled()
}

fn tmux_control_client_alive(control_pid: Option<libc::pid_t>) -> bool {
    let Some(control_pid) = control_pid else {
        return false;
    };

    let output = match tmux::output(&["list-clients", "-F", "#{client_pid}\t#{client_control_mode}"]) {
        Ok(output) if output.status.success() => output,
        _ => return false,
    };

    let control_pid = control_pid.to_string();
    String::from_utf8_lossy(&output.stdout).lines().any(|line| {
        let mut parts = line.split('\t');
        matches!(
            (parts.next(), parts.next()),
            (Some(client_pid), Some("1")) if client_pid == control_pid
        )
    })
}

fn test_driver_status(state: &AppState) -> serde_json::Value {
    serde_json::json!({
        "enabled": test_driver_enabled(),
        "frontend_ready": state.test_driver_frontend_ready(),
        "bootstrap_complete": state.test_driver_bootstrap_complete(),
        "runtime_id": runtime::runtime_id(),
        "tmux_server_name": runtime::tmux_server_name(),
        "socket_path": runtime::socket_path(),
        "tmux_server_alive": tmux::is_running(),
        "control_client_alive": tmux_control_client_alive(state.current_control_pid()),
    })
}

fn wait_for<F>(timeout_ms: u64, mut predicate: F, description: &str) -> Result<(), String>
where
    F: FnMut() -> bool,
{
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    while Instant::now() <= deadline {
        if predicate() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    Err(format!("timed out waiting for {description}"))
}

fn request_timeout_ms(request: &TestDriverRequest) -> u64 {
    match request {
        TestDriverRequest::WaitForIdle { timeout_ms, .. }
        | TestDriverRequest::WaitForReady { timeout_ms }
        | TestDriverRequest::WaitForBootstrap { timeout_ms } => timeout_ms.unwrap_or(10_000),
        _ => 10_000,
    }
}

fn forward_test_driver_request(
    state: &AppState,
    app: &AppHandle,
    request: TestDriverRequest,
) -> SocketResponse {
    if !state.test_driver_frontend_ready() {
        return SocketResponse::error("frontend test driver is not ready".into());
    }

    let request_id = state.next_test_driver_request_id();
    let (sender, receiver) = mpsc::channel();
    if let Err(error) = state.register_test_driver_request(&request_id, sender) {
        return SocketResponse::error(error);
    }

    let emit_result = app.emit("test-driver-request", serde_json::json!({
        "request_id": request_id,
        "request": request,
    }));
    if let Err(error) = emit_result {
        state.cancel_test_driver_request(&request_id);
        return SocketResponse::error(format!("emit test-driver-request failed: {error}"));
    }

    match receiver.recv_timeout(Duration::from_millis(request_timeout_ms(&request))) {
        Ok(Ok(data)) => SocketResponse::success(Some(data)),
        Ok(Err(error)) => SocketResponse::error(error),
        Err(_) => {
            state.cancel_test_driver_request(&request_id);
            SocketResponse::error("timed out waiting for test-driver response".into())
        }
    }
}

fn handle_test_dom_query(js: String, app: &AppHandle) -> SocketResponse {
    if let Some(webview) = app.webview_windows().values().next() {
        let result_file = runtime::dom_result_path().to_string();
        let _ = std::fs::remove_file(&result_file);

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
        if let Err(error) = webview.eval(&wrapped) {
            return SocketResponse::error(format!("eval failed: {error}"));
        }

        for _ in 0..40 {
            std::thread::sleep(Duration::from_millis(50));
            if let Ok(data) = std::fs::read_to_string(&result_file) {
                let _ = std::fs::remove_file(&result_file);
                match serde_json::from_str::<serde_json::Value>(&data) {
                    Ok(value) => return SocketResponse::success(Some(value)),
                    Err(_) => return SocketResponse::success(Some(serde_json::json!(data))),
                }
            }
        }

        SocketResponse::success(Some(serde_json::json!(null)))
    } else {
        SocketResponse::error("No webview found".into())
    }
}

fn handle_test_dom_keys(keys: String, app: &AppHandle) -> SocketResponse {
    if let Some(webview) = app.webview_windows().values().next() {
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
        std::thread::sleep(Duration::from_millis(200));
        SocketResponse::success(None)
    } else {
        SocketResponse::error("No webview found".into())
    }
}

pub async fn start(state: AppState, app_handle: AppHandle) {
    let path = Path::new(runtime::socket_path());
    if path.exists() {
        let _ = std::fs::remove_file(path);
    }

    let listener = match UnixListener::bind(runtime::socket_path()) {
        Ok(l) => l,
        Err(e) => {
            log::error!("Failed to bind Unix socket at {}: {e}", runtime::socket_path());
            return;
        }
    };

    let logger: SharedLogger = Arc::new(Mutex::new(SocketLogger::open()));
    log::info!("Socket server listening on {}", runtime::socket_path());

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
        SocketCommand::SpawnShell { x: _, y: _, width: _, height: _, parent_session_id, parent_pane_id } => {
            let before = match crate::tmux_state::snapshot(state) {
                Ok(snapshot) => snapshot,
                Err(e) => return SocketResponse::error(e),
            };

            let target_session_id = parent_pane_id
                .as_ref()
                .and_then(|pane_id| {
                    before
                        .panes
                        .iter()
                        .find(|pane| &pane.id == pane_id)
                        .map(|pane| pane.session_id.clone())
                })
                .or(parent_session_id.clone())
                .or(before.active_session_id.clone());

            let parent_window_id = parent_pane_id
                .as_ref()
                .and_then(|pane_id| {
                    before
                        .panes
                        .iter()
                        .find(|pane| &pane.id == pane_id)
                        .map(|pane| pane.window_id.clone())
                });

            match crate::commands::new_window_detached(app.clone(), target_session_id) {
                Ok(window_id) => {
                    if let Some(parent_window_id) = parent_window_id.clone() {
                        state.set_window_parent(&window_id, Some(parent_window_id));
                        let _ = crate::tmux_state::emit_snapshot(app);
                    }
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
                        .unwrap_or_else(|| window_id.clone());
                    SocketResponse::success(Some(serde_json::json!({
                        "session_id": pane_id,
                        "window_id": window_id,
                        "parent_window_id": parent_window_id,
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

        SocketCommand::ExecInShell { session_id, shell_command } => {
            match crate::tmux_state::respawn_pane_shell_command(&session_id, &shell_command) {
                Ok(()) => {
                    let _ = crate::tmux_state::emit_snapshot(app);
                    SocketResponse::success(None)
                }
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
            match crate::commands::set_pane_title(app.clone(), session_id, title) {
                Ok(()) => SocketResponse::success(None),
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

        SocketCommand::SetTileRole { session_id, role } => {
            let payload = serde_json::json!({
                "session_id": session_id,
                "role": role,
            });
            let _ = app.emit("shell-role", payload);
            SocketResponse::success(None)
        }

        SocketCommand::TestDriver { request } => {
            if !test_driver_enabled() {
                return SocketResponse::error("test driver is not enabled".into());
            }

            match request.clone() {
                TestDriverRequest::Ping => SocketResponse::success(Some(serde_json::json!({
                    "pong": true,
                    "status": test_driver_status(state),
                }))),
                TestDriverRequest::WaitForReady { timeout_ms } => {
                    match wait_for(
                        timeout_ms.unwrap_or(10_000),
                        || state.test_driver_frontend_ready(),
                        "frontend test driver readiness",
                    ) {
                        Ok(()) => SocketResponse::success(Some(test_driver_status(state))),
                        Err(error) => SocketResponse::error(error),
                    }
                }
                TestDriverRequest::WaitForBootstrap { timeout_ms } => {
                    match wait_for(
                        timeout_ms.unwrap_or(10_000),
                        || state.test_driver_bootstrap_complete(),
                        "frontend bootstrap completion",
                    ) {
                        Ok(()) => SocketResponse::success(Some(test_driver_status(state))),
                        Err(error) => SocketResponse::error(error),
                    }
                }
                TestDriverRequest::GetStatus => SocketResponse::success(Some(test_driver_status(state))),
                other => forward_test_driver_request(state, app, other),
            }
        }

        SocketCommand::TestDomQuery { js } => {
            if !test_driver_enabled() {
                return SocketResponse::error("test driver is not enabled".into());
            }
            handle_test_dom_query(js, app)
        }

        SocketCommand::TestDomKeys { keys } => {
            if !test_driver_enabled() {
                return SocketResponse::error("test driver is not enabled".into());
            }
            handle_test_dom_keys(keys, app)
        }

        SocketCommand::TmuxPaneCreated { tmux_session: _, parent_session_id: _, title: _ } => {
            // No longer needed — control mode detects panes automatically
            SocketResponse::success(None)
        }
    }
}

pub fn cleanup() {
    let path = Path::new(runtime::socket_path());
    if path.exists() {
        let _ = std::fs::remove_file(path);
    }
}
