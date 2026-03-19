use crate::{
    persist::TileState,
    state::AppState,
    tmux,
    tmux_state,
};
use std::process::Command;
use tauri::Manager;

fn active_session_id(snapshot: &tmux_state::TmuxSnapshot) -> Result<String, String> {
    snapshot
        .active_session_id
        .clone()
        .or_else(|| snapshot.sessions.first().map(|session| session.id.clone()))
        .ok_or("no tmux session available".into())
}

fn active_window_id_for_session(
    snapshot: &tmux_state::TmuxSnapshot,
    session_id: &str,
) -> Result<String, String> {
    snapshot
        .sessions
        .iter()
        .find(|session| session.id == session_id)
        .and_then(|session| session.active_window_id.clone().or_else(|| session.window_ids.first().cloned()))
        .ok_or_else(|| format!("no tmux window available for session {session_id}"))
}

fn active_pane_id_for_window(
    snapshot: &tmux_state::TmuxSnapshot,
    window_id: &str,
) -> Result<String, String> {
    snapshot
        .windows
        .iter()
        .find(|window| window.id == window_id)
        .and_then(|window| window.pane_ids.first().cloned())
        .ok_or_else(|| format!("no tmux pane available for window {window_id}"))
}

fn active_pane_id_for_session(
    snapshot: &tmux_state::TmuxSnapshot,
    session_id: &str,
) -> Result<String, String> {
    let window_id = active_window_id_for_session(snapshot, session_id)?;
    active_pane_id_for_window(snapshot, &window_id)
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

fn tmux_control_client_tty(control_pid: Option<libc::pid_t>) -> Option<String> {
    let control_pid = control_pid?;
    let output = tmux::output(&[
        "list-clients",
        "-F",
        "#{client_pid}\t#{client_tty}\t#{client_control_mode}",
    ])
    .ok()?;
    if !output.status.success() {
        return None;
    }

    control_client_tty_from_output(&String::from_utf8_lossy(&output.stdout), Some(control_pid))
}

fn switch_control_client_to_session(state: &AppState, session_id: &str) -> Result<(), String> {
    if let Some(client_tty) = tmux_control_client_tty(state.current_control_pid()) {
        let output = tmux::output(&["switch-client", "-c", &client_tty, "-t", session_id])?;
        if output.status.success() {
            return Ok(());
        }
        return Err(format!(
            "tmux switch-client failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    tmux_state::select_session(session_id)
}

fn control_client_tty_from_output(output: &str, control_pid: Option<libc::pid_t>) -> Option<String> {
    let control_pid = control_pid?;
    let control_pid = control_pid.to_string();
    output.lines().find_map(|line| {
        let mut parts = line.split('\t');
        match (parts.next(), parts.next(), parts.next()) {
            (Some(client_pid), Some(client_tty), Some("1")) if client_pid == control_pid => {
                Some(client_tty.to_string())
            }
            _ => None,
        }
    })
}

#[tauri::command]
pub fn get_tmux_state(state: tauri::State<'_, AppState>) -> Result<tmux_state::TmuxSnapshot, String> {
    tmux_state::snapshot(&state)
}

#[tauri::command]
pub fn get_layout_state(
    state: tauri::State<'_, AppState>,
) -> Result<std::collections::HashMap<String, TileState>, String> {
    let states = state.tile_states.lock().map_err(|e| e.to_string())?;
    Ok(states.clone())
}

#[tauri::command]
pub fn save_layout_state(
    state: tauri::State<'_, AppState>,
    pane_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    state.set_tile_state(&pane_id, TileState { x, y, width, height });
    state.save();
    Ok(())
}

#[tauri::command]
pub fn new_session(app: tauri::AppHandle, name: Option<String>) -> Result<String, String> {
    let state = app.state::<AppState>();
    let session_id = tmux_state::create_session(name.as_deref())?;
    switch_control_client_to_session(state.inner(), &session_id)?;
    tmux_state::emit_snapshot(&app)?;
    Ok(session_id)
}

#[tauri::command]
pub fn kill_session(app: tauri::AppHandle, session_id: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    let snapshot = tmux_state::snapshot(state.inner())?;
    let active_session_id = snapshot.active_session_id.clone();
    let is_only_session = snapshot.sessions.len() <= 1;

    let fallback_session_id = if is_only_session {
        Some(tmux_state::create_session(Some(crate::SESSION_NAME))?)
    } else {
        snapshot
            .sessions
            .iter()
            .find(|session| session.id != session_id)
            .map(|session| session.id.clone())
    };

    if active_session_id.as_deref() == Some(session_id.as_str()) {
        if let Some(fallback) = fallback_session_id.as_ref() {
            switch_control_client_to_session(state.inner(), fallback)?;
        }
    }

    tmux_state::kill_session(&session_id)?;
    tmux_state::emit_snapshot(&app)?;
    Ok(())
}

#[tauri::command]
pub fn select_session(app: tauri::AppHandle, session_id: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    switch_control_client_to_session(state.inner(), &session_id)?;
    tmux_state::emit_snapshot(&app)?;
    Ok(())
}

#[tauri::command]
pub fn rename_session(app: tauri::AppHandle, session_id: String, name: String) -> Result<(), String> {
    tmux_state::rename_session(&session_id, &name)?;
    tmux_state::emit_snapshot(&app)?;
    Ok(())
}

#[tauri::command]
pub fn new_window(app: tauri::AppHandle, target_session_id: Option<String>) -> Result<String, String> {
    let state = app.state::<AppState>();
    let before = tmux_state::snapshot(state.inner())?;
    let session_id = target_session_id.unwrap_or(active_session_id(&before)?);
    let target_pane_id = active_pane_id_for_session(&before, &session_id)?;
    let pane_id = tmux_state::create_window(Some(&target_pane_id), None)?;

    let after = tmux_state::snapshot(state.inner())?;
    let window_id = after
        .panes
        .iter()
        .find(|pane| pane.id == pane_id)
        .map(|pane| pane.window_id.clone())
        .ok_or("tmux did not report the new window for the created pane")?;

    tmux_state::select_window(&window_id)?;
    tmux_state::emit_snapshot(&app)?;
    Ok(window_id)
}

#[tauri::command]
pub fn split_pane(app: tauri::AppHandle, target_pane_id: Option<String>) -> Result<String, String> {
    let state = app.state::<AppState>();
    let snapshot = tmux_state::snapshot(state.inner())?;
    let session_id = if let Some(pane_id) = target_pane_id.as_ref() {
        snapshot
            .panes
            .iter()
            .find(|pane| &pane.id == pane_id)
            .map(|pane| pane.session_id.clone())
            .ok_or_else(|| format!("No tmux pane found for {pane_id}"))?
    } else {
        active_session_id(&snapshot)?
    };
    new_window(app, Some(session_id))
}

#[tauri::command]
pub fn kill_window(app: tauri::AppHandle, window_id: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    let snapshot = tmux_state::snapshot(state.inner())?;
    let window = snapshot
        .windows
        .iter()
        .find(|window| window.id == window_id)
        .cloned()
        .ok_or_else(|| format!("No tmux window found for {window_id}"))?;
    let session = snapshot
        .sessions
        .iter()
        .find(|session| session.id == window.session_id)
        .cloned()
        .ok_or_else(|| format!("No tmux session found for {}", window.session_id))?;

    if session.window_ids.len() <= 1 {
        tmux_state::respawn_window(&window_id)?;
        tmux_state::emit_snapshot(&app)?;
        return Ok(());
    }

    tmux_state::kill_window(&window_id)?;
    tmux_state::emit_snapshot(&app)?;
    Ok(())
}

#[tauri::command]
pub fn kill_pane(app: tauri::AppHandle, pane_id: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    let snapshot = tmux_state::snapshot(state.inner())?;
    let window_id = snapshot
        .panes
        .iter()
        .find(|pane| pane.id == pane_id)
        .map(|pane| pane.window_id.clone())
        .ok_or_else(|| format!("No tmux pane found for {pane_id}"))?;
    kill_window(app, window_id)
}

#[tauri::command]
pub fn select_window(app: tauri::AppHandle, window_id: String) -> Result<(), String> {
    tmux_state::select_window(&window_id)?;
    tmux_state::emit_snapshot(&app)?;
    Ok(())
}

#[tauri::command]
pub fn resize_window(_app: tauri::AppHandle, window_id: String, cols: u16, rows: u16) -> Result<(), String> {
    tmux_state::resize_window(&window_id, cols, rows)
}

#[tauri::command]
pub fn rename_window(app: tauri::AppHandle, window_id: String, name: String) -> Result<(), String> {
    tmux_state::rename_window(&window_id, &name)?;
    tmux_state::emit_snapshot(&app)?;
    Ok(())
}

#[tauri::command]
pub fn set_pane_title(app: tauri::AppHandle, pane_id: String, title: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    let snapshot = tmux_state::snapshot(state.inner())?;
    let window_id = snapshot
        .panes
        .iter()
        .find(|pane| pane.id == pane_id)
        .map(|pane| pane.window_id.clone())
        .ok_or_else(|| format!("No tmux pane found for {pane_id}"))?;
    tmux_state::rename_window(&window_id, &title)?;
    tmux_state::set_pane_title(&pane_id, &title)?;
    tmux_state::emit_snapshot(&app)?;
    Ok(())
}

// Compatibility alias: create a new single-pane tmux window in the active session.
#[tauri::command]
pub fn create_pty(app: tauri::AppHandle, _cols: u16, _rows: u16) -> Result<String, String> {
    let window_id = new_window(app.clone(), None)?;
    let state = app.state::<AppState>();
    let snapshot = tmux_state::snapshot(state.inner())?;
    snapshot
        .windows
        .iter()
        .find(|window| window.id == window_id)
        .and_then(|window| window.pane_ids.first().cloned())
        .ok_or("tmux did not report a pane for the new window".into())
}

// Compatibility alias: pane IDs are still the IO identity, but tiles are windows.
#[tauri::command]
pub fn destroy_pty(app: tauri::AppHandle, session_id: String) -> Result<(), String> {
    kill_pane(app, session_id)
}

#[tauri::command]
pub fn write_pty(
    state: tauri::State<'_, AppState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let guard = state.tmux_writer.lock().map_err(|e| e.to_string())?;
    let writer = guard.as_ref().ok_or("tmux writer not initialized")?;
    writer.send_input_by_id(&session_id, data.as_bytes())
}

#[tauri::command]
pub fn read_pty_output(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<String, String> {
    let buffered = state.read_output(&session_id).unwrap_or_default();
    if !buffered.is_empty() {
        return Ok(buffered);
    }

    let output = tmux::output(&[
        "capture-pane",
        "-t",
        &session_id,
        "-e",
        "-p",
    ])
    .map_err(|e| format!("capture-pane failed: {e}"))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Ok(String::new())
    }
}

// Compatibility alias: visual resize is now frontend-only, so this is a no-op.
#[tauri::command]
pub fn resize_pty(
    _state: tauri::State<'_, AppState>,
    _session_id: String,
    _cols: u16,
    _rows: u16,
) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn tmux_tree(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    let snapshot = tmux_state::snapshot(&state)?;
    let tree = snapshot.sessions.into_iter().map(|session| {
        let windows = snapshot.windows.iter()
            .filter(|window| window.session_id == session.id)
            .map(|window| {
                let pane = snapshot.panes.iter().find(|pane| pane.window_id == window.id);
                serde_json::json!({
                    "window_index": window.index.to_string(),
                    "window_name": window.name,
                    "window_id": window.id,
                    "pane_id": pane.as_ref().map(|pane| pane.id.clone()),
                    "command": pane.as_ref().map(|pane| pane.command.clone()).unwrap_or_default(),
                    "dead": pane.as_ref().map(|pane| pane.dead).unwrap_or(false),
                })
            })
            .collect::<Vec<_>>();
        serde_json::json!({
            "session_id": session.id,
            "session": session.name,
            "windows": windows,
        })
    }).collect::<Vec<_>>();
    Ok(serde_json::json!(tree))
}

#[tauri::command]
pub fn spawn_log_shell(
    state: tauri::State<'_, AppState>,
    cmd: String,
) -> Result<(), String> {
    let snapshot = tmux_state::snapshot(&state)?;
    let session_id = active_session_id(&snapshot)?;
    let target_pane_id = active_pane_id_for_session(&snapshot, &session_id)?;
    let pane_id = tmux_state::create_window(Some(&target_pane_id), Some(&cmd))?;
    let latest = tmux_state::snapshot(&state)?;
    if let Some(window_id) = latest
        .panes
        .iter()
        .find(|pane| pane.id == pane_id)
        .map(|pane| pane.window_id.clone())
    {
        let _ = tmux_state::select_window(&window_id);
    }
    Ok(())
}

#[tauri::command]
pub fn tmux_restart(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    state.with_control(|ctrl| {
        ctrl.clear_all();
        Ok(())
    }).ok();

    let _ = Command::new("pkill")
        .args(["-9", "-f", "tmux .* -L herd"])
        .status();
    let _ = std::fs::remove_file("/private/tmp/tmux-501/herd");
    std::thread::sleep(std::time::Duration::from_millis(1000));

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let herd_sock_env = format!("HERD_SOCK={}", crate::socket::SOCKET_PATH);
    let output = tmux::output(&[
            "new-session",
            "-d",
            "-s",
            crate::SESSION_NAME,
            "-x",
            "80",
            "-y",
            "24",
            "-e",
            &herd_sock_env,
            &shell,
        ])
        .map_err(|e| format!("Failed to create tmux session: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "tmux new-session failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    let _ = tmux::output(&["set", "-g", "status", "off"]);
    let _ = tmux::output(&["set", "-g", "exit-empty", "off"]);
    let _ = tmux::output(&["set", "-g", "default-command", "zsh --no-rcs"]);

    match crate::tmux_control::TmuxControl::start(crate::SESSION_NAME, app.clone()) {
        Ok(control) => {
            state.set_control(control);
            let _ = tmux_state::emit_snapshot(&app);
            log::info!("tmux restarted and control mode reconnected");
            Ok(())
        }
        Err(e) => Err(format!("Control mode failed: {e}")),
    }
}

#[tauri::command]
pub fn sync_panes(app: tauri::AppHandle) -> Result<(), String> {
    tmux_state::emit_snapshot(&app)
}

#[tauri::command]
pub fn redraw_all_panes() -> Result<(), String> {
    let output = tmux::output(&["list-panes", "-a", "-F", "#{pane_id}"])?;

    let panes: Vec<String> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|s| s.to_string())
        .collect();

    for pane_id in &panes {
        let _ = tmux::output(&["send-keys", "-t", pane_id, "C-l"]);
    }

    Ok(())
}

#[tauri::command]
pub fn read_log_tail(log_name: String, offset: u64) -> Result<String, String> {
    use std::io::{Read, Seek, SeekFrom};

    let path = match log_name.as_str() {
        "socket" => {
            let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tmp/herd-socket.log");
            p.to_string_lossy().to_string()
        }
        "cc" => {
            let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tmp/herd-cc.log");
            p.to_string_lossy().to_string()
        }
        _ => return Err(format!("Unknown log: {log_name}")),
    };

    let mut file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    if offset >= len {
        return Ok(String::new());
    }
    file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut buf = String::new();
    file.read_to_string(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

#[tauri::command]
pub fn __write_dom_result(result: String) -> Result<(), String> {
    std::fs::write("/tmp/herd-dom-result.json", result)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn tmux_status(state: tauri::State<'_, AppState>) -> serde_json::Value {
    let server_alive = tmux::is_running();
    let cc_alive = tmux_control_client_alive(state.current_control_pid());

    serde_json::json!({
        "server": server_alive,
        "cc": cc_alive,
    })
}

#[cfg(test)]
mod tests {
    use super::{control_client_tty_from_output, tmux_control_client_alive};

    fn control_client_alive_from_output(output: &str, control_pid: Option<libc::pid_t>) -> bool {
        let Some(control_pid) = control_pid else {
            return false;
        };
        let control_pid = control_pid.to_string();
        output.lines().any(|line| {
            let mut parts = line.split('\t');
            matches!(
                (parts.next(), parts.next()),
                (Some(client_pid), Some("1")) if client_pid == control_pid
            )
        })
    }

    #[test]
    fn matches_the_tracked_control_client() {
        let output = "92568\t1\n91234\t0\n";
        assert!(control_client_alive_from_output(output, Some(92568)));
        assert!(!control_client_alive_from_output(output, Some(91234)));
        assert!(!control_client_alive_from_output(output, Some(99999)));
        assert!(!control_client_alive_from_output(output, None));
    }

    #[test]
    fn helper_returns_false_without_a_live_tmux_server() {
        assert!(!tmux_control_client_alive(None));
    }

    #[test]
    fn finds_the_tracked_control_client_tty() {
        let output = "92568\t/dev/ttys009\t1\n91234\t/dev/ttys010\t0\n";
        assert_eq!(
            control_client_tty_from_output(output, Some(92568)),
            Some("/dev/ttys009".to_string())
        );
        assert_eq!(control_client_tty_from_output(output, Some(91234)), None);
        assert_eq!(control_client_tty_from_output(output, Some(99999)), None);
        assert_eq!(control_client_tty_from_output(output, None), None);
    }
}
