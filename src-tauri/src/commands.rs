use crate::state::AppState;
use std::process::Command;
use tauri::Emitter;

#[tauri::command]
pub fn create_pty(
    state: tauri::State<'_, AppState>,
    _app: tauri::AppHandle,
    _cols: u16,
    _rows: u16,
) -> Result<String, String> {
    // Create a new window in the tmux session; the control mode reader
    // will detect the new pane and emit shell-spawned with a session_id.
    state.with_control(|ctrl| {
        ctrl.create_window()?;
        // The actual session_id is assigned asynchronously when the pane is detected.
        // Return a placeholder — the frontend will get the real ID via the shell-spawned event.
        Ok("pending".to_string())
    })
}

#[tauri::command]
pub fn destroy_pty(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    state.with_control(|ctrl| {
        ctrl.kill_pane_by_id(&session_id)
    })
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
    // First try the buffer
    let buffered = state.read_output(&session_id).unwrap_or_default();
    if !buffered.is_empty() {
        return Ok(buffered);
    }

    // Fallback: capture current pane content directly from tmux
    let guard = state.tmux_writer.lock().map_err(|e| e.to_string())?;
    let writer = guard.as_ref().ok_or("writer not initialized")?;
    let pane_id = writer.pane_id_for(&session_id)
        .ok_or_else(|| format!("No pane for session {session_id}"))?;

    let output = Command::new("tmux")
        .args(["-L", crate::tmux::server_name(), "capture-pane", "-t", &pane_id, "-e", "-p"])
        .output()
        .map_err(|e| format!("capture-pane failed: {e}"))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Ok(String::new())
    }
}

#[tauri::command]
pub fn resize_pty(
    state: tauri::State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.with_control(|ctrl| {
        ctrl.resize_by_id(&session_id, cols, rows)
    })
}

#[tauri::command]
pub fn save_tile_state(
    state: tauri::State<'_, AppState>,
    session_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    title: String,
) -> Result<(), String> {
    state.with_control(|ctrl| {
        if let Some(pane_id) = ctrl.writer.pane_id_for(&session_id) {
            if let Some(mut ts) = state.get_tile_state(&pane_id) {
                ts.x = x;
                ts.y = y;
                ts.width = width;
                ts.height = height;
                ts.title = title;
                state.set_tile_state(&pane_id, ts);
                state.save();
            }
        }
        Ok(())
    })
}

#[tauri::command]
pub fn tmux_tree() -> Result<serde_json::Value, String> {
    let output = Command::new("tmux")
        .args(["-L", crate::tmux::server_name(),
               "list-panes", "-a", "-F",
               "#{session_name}\t#{window_index}\t#{window_name}\t#{pane_id}\t#{pane_current_command}\t#{pane_pid}\t#{pane_dead}"])
        .output()
        .map_err(|e| format!("tmux list-panes failed: {e}"))?;

    if !output.status.success() {
        return Ok(serde_json::json!([]));
    }

    let text = String::from_utf8_lossy(&output.stdout);
    let mut sessions: std::collections::BTreeMap<String, Vec<serde_json::Value>> = std::collections::BTreeMap::new();

    for line in text.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() < 7 { continue; }
        let session_name = parts[0];
        if session_name.starts_with('_') { continue; }

        let pane = serde_json::json!({
            "window_index": parts[1],
            "window_name": parts[2],
            "pane_id": parts[3],
            "command": parts[4],
            "pid": parts[5],
            "dead": parts[6] == "1",
        });

        sessions.entry(session_name.to_string())
            .or_default()
            .push(pane);
    }

    let tree: Vec<serde_json::Value> = sessions.into_iter().map(|(name, panes)| {
        serde_json::json!({
            "session": name,
            "panes": panes,
        })
    }).collect();

    Ok(serde_json::json!(tree))
}

#[tauri::command]
pub fn spawn_log_shell(
    _state: tauri::State<'_, AppState>,
    cmd: String,
) -> Result<(), String> {
    let server = crate::tmux::server_name();
    // Create a new window running the log command directly
    Command::new("tmux")
        .args(["-L", server, "new-window", "-t", crate::SESSION_NAME, &cmd])
        .status()
        .map_err(|e| format!("Failed to create log window: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn tmux_restart(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let server = crate::tmux::server_name();

    // Clear backend state and kill the -CC child process
    state.with_control(|ctrl| {
        ctrl.clear_all();
        Ok(())
    }).ok();

    // Tell frontend to clear all tiles
    let _ = app.emit("shells-clear", ());

    // Kill ALL tmux processes for our server (including zombie -CC forkpty children)
    let _ = Command::new("pkill")
        .args(["-9", "-f", "tmux -L herd"])
        .status();

    // Remove stale socket
    let _ = std::fs::remove_file("/private/tmp/tmux-501/herd");

    std::thread::sleep(std::time::Duration::from_millis(1000));

    // Create fresh session with a real shell
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let herd_sock_env = format!("HERD_SOCK={}", crate::socket::SOCKET_PATH);

    let status = Command::new("tmux")
        .args(["-L", server, "new-session", "-d",
               "-s", crate::SESSION_NAME, "-x", "80", "-y", "24",
               "-e", &herd_sock_env,
               &shell])
        .status()
        .map_err(|e| format!("Failed to create tmux session: {e}"))?;
    if !status.success() {
        return Err("tmux new-session failed".into());
    }

    let _ = Command::new("tmux")
        .args(["-L", server, "set", "-g", "status", "off"])
        .status();
    let _ = Command::new("tmux")
        .args(["-L", server, "set", "-g", "exit-empty", "off"])
        .status();
    let _ = Command::new("tmux")
        .args(["-L", server, "set", "-g", "default-command", "zsh --no-rcs"])
        .status();

    // Start control mode
    match crate::tmux_control::TmuxControl::start(crate::SESSION_NAME, app) {
        Ok(control) => {
            state.set_control(control);
            log::info!("tmux restarted and control mode reconnected");
            Ok(())
        }
        Err(e) => Err(format!("Control mode failed: {e}")),
    }
}

#[tauri::command]
pub fn sync_panes(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    // Re-emit shell-spawned events for all known panes
    state.with_control(|ctrl| {
        for (pane_id, session_id) in ctrl.list_panes() {
            let payload = serde_json::json!({
                "session_id": session_id,
                "pane_id": pane_id,
                "x": 100.0,
                "y": 100.0,
                "width": 640.0,
                "height": 400.0,
            });
            let _ = app.emit("shell-spawned", &payload);
        }
        Ok(())
    })
}

#[tauri::command]
pub fn redraw_all_panes() -> Result<(), String> {
    let server = crate::tmux::server_name();
    // Force redraw by doing a resize bounce on each pane
    let output = Command::new("tmux")
        .args(["-L", server, "list-panes", "-s", "-t", crate::SESSION_NAME, "-F", "#{pane_id}"])
        .output()
        .map_err(|e| e.to_string())?;

    let panes: Vec<String> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|s| s.to_string())
        .collect();

    for pane_id in &panes {
        // Send Ctrl+L via direct tmux command
        let _ = Command::new("tmux")
            .args(["-L", server, "send-keys", "-t", pane_id, "C-l"])
            .status();
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
pub fn tmux_status() -> serde_json::Value {
    let server_alive = Command::new("tmux")
        .args(["-L", crate::tmux::server_name(), "list-sessions"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    let cc_alive = Command::new("pgrep")
        .args(["-f", "tmux -L herd -CC"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    serde_json::json!({
        "server": server_alive,
        "cc": cc_alive,
    })
}
