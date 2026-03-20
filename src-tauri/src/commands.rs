use crate::{
    persist::TileState,
    runtime,
    state::AppState,
    tmux,
    tmux_state,
};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::Manager;

#[derive(Debug, Clone, Serialize)]
pub struct ClaudeCommandDescriptor {
    pub name: String,
    pub execution: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClaudeMenuData {
    pub commands: Vec<ClaudeCommandDescriptor>,
    pub skills: Vec<ClaudeCommandDescriptor>,
}

#[derive(Debug, Clone, Deserialize)]
struct ClaudeInitDiscovery {
    #[serde(default)]
    slash_commands: Vec<String>,
    #[serde(default)]
    skills: Vec<String>,
}

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
            state.set_last_active_session(Some(session_id.to_string()));
            return Ok(());
        }
        return Err(format!(
            "tmux switch-client failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    tmux_state::select_session(session_id)?;
    state.set_last_active_session(Some(session_id.to_string()));
    Ok(())
}

fn pane_current_path(pane_id: &str) -> Result<String, String> {
    let output = tmux::output(&["display-message", "-p", "-t", pane_id, "#{pane_current_path}"])?;
    if !output.status.success() {
        return Err(format!(
            "tmux display-message failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let cwd = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if cwd.is_empty() {
        return Err(format!("tmux returned an empty cwd for pane {pane_id}"));
    }
    Ok(cwd)
}

fn builtin_claude_command(name: &str) -> Option<(&'static str, &'static str)> {
    match name {
        "clear" => Some(("execute", "builtin")),
        "cost" => Some(("execute", "builtin")),
        "context" => Some(("execute", "builtin")),
        "debug" => Some(("execute", "builtin")),
        "help" => Some(("execute", "builtin")),
        "init" => Some(("execute", "builtin")),
        "insights" => Some(("execute", "builtin")),
        "memory" => Some(("execute", "builtin")),
        "pr-comments" => Some(("execute", "builtin")),
        "review" => Some(("execute", "builtin")),
        "security-review" => Some(("execute", "builtin")),
        "compact" => Some(("insert", "builtin")),
        "model" => Some(("insert", "builtin")),
        _ => None,
    }
}

fn env_fixture_claude_menu() -> Result<Option<ClaudeInitDiscovery>, String> {
    let Some(value) = std::env::var("HERD_CLAUDE_MENU_FIXTURE").ok() else {
        return Ok(None);
    };

    if value.trim().is_empty() {
        return Ok(Some(ClaudeInitDiscovery {
            slash_commands: Vec::new(),
            skills: Vec::new(),
        }));
    }

    serde_json::from_str::<ClaudeInitDiscovery>(&value)
        .map(Some)
        .map_err(|error| format!("invalid HERD_CLAUDE_MENU_FIXTURE: {error}"))
}

fn discover_claude_menu_from_cli(cwd: &str) -> Result<ClaudeInitDiscovery, String> {
    if let Some(menu) = env_fixture_claude_menu()? {
        return Ok(menu);
    }

    let mut child = Command::new("claude")
        .arg("-p")
        .arg("--verbose")
        .arg("--output-format")
        .arg("stream-json")
        .arg("ok")
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("failed to spawn claude for command discovery: {error}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or("failed to capture claude discovery stdout")?;
    let reader = BufReader::new(stdout);
    let mut discovered: Option<ClaudeInitDiscovery> = None;

    for line in reader.lines().take(20) {
        let line = line.map_err(|error| format!("failed reading claude discovery output: {error}"))?;
        if line.trim().is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let is_init = value.get("type").and_then(|value| value.as_str()) == Some("system")
            && value.get("subtype").and_then(|value| value.as_str()) == Some("init");
        if !is_init {
            continue;
        }
        let slash_commands = value
            .get("slash_commands")
            .and_then(|value| value.as_array())
            .ok_or("claude init output missing slash_commands")?
            .iter()
            .filter_map(|value| value.as_str().map(|value| value.to_string()))
            .collect::<Vec<_>>();
        let skills = value
            .get("skills")
            .and_then(|value| value.as_array())
            .map(|values| {
                values
                    .iter()
                    .filter_map(|value| value.as_str().map(|value| value.to_string()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        discovered = Some(ClaudeInitDiscovery {
            slash_commands,
            skills,
        });
        break;
    }

    let _ = child.kill();
    let _ = child.wait();

    discovered.ok_or("claude discovery did not yield an init slash_commands payload".into())
}

fn find_custom_claude_command_file(cwd: &str, name: &str) -> Option<PathBuf> {
    let command_name = name.replace(':', "/");
    let md_name = format!("{command_name}.md");
    let home_commands = std::env::var("HOME").ok().map(PathBuf::from);
    let mut roots: Vec<PathBuf> = Vec::new();

    let mut current = Some(PathBuf::from(cwd));
    while let Some(path) = current {
        roots.push(path.join(".claude/commands"));
        current = path.parent().map(Path::to_path_buf);
    }

    if let Some(home) = home_commands {
        roots.push(home.join(".claude/commands"));
    }

    roots.into_iter()
        .map(|root| root.join(&md_name))
        .find(|path| path.exists())
}

fn custom_command_has_argument_hint(path: &Path) -> bool {
    fs::read_to_string(path)
        .map(|content| {
            content.lines().take(20).any(|line| {
                let trimmed = line.trim();
                trimmed.starts_with("argument-hint:") || trimmed.starts_with("argument_hint:")
            })
        })
        .unwrap_or(false)
}

fn enrich_claude_commands(command_names: Vec<String>, cwd: &str) -> Vec<ClaudeCommandDescriptor> {
    command_names
        .into_iter()
        .map(|name| {
            if let Some((execution, source)) = builtin_claude_command(&name) {
                return ClaudeCommandDescriptor {
                    name,
                    execution: execution.to_string(),
                    source: source.to_string(),
                };
            }

            if let Some(path) = find_custom_claude_command_file(cwd, &name) {
                let execution = if custom_command_has_argument_hint(&path) {
                    "insert"
                } else {
                    "execute"
                };
                return ClaudeCommandDescriptor {
                    name,
                    execution: execution.to_string(),
                    source: "custom".to_string(),
                };
            }

            ClaudeCommandDescriptor {
                name,
                execution: "insert".to_string(),
                source: "unknown".to_string(),
            }
        })
        .collect()
}

fn skillify_commands(commands: Vec<ClaudeCommandDescriptor>) -> Vec<ClaudeCommandDescriptor> {
    commands
        .into_iter()
        .map(|mut command| {
            command.source = "skill".to_string();
            command
        })
        .collect()
}

fn build_claude_menu_data(discovery: ClaudeInitDiscovery, cwd: &str) -> ClaudeMenuData {
    ClaudeMenuData {
        commands: enrich_claude_commands(discovery.slash_commands, cwd),
        skills: skillify_commands(enrich_claude_commands(discovery.skills, cwd)),
    }
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
pub fn get_claude_menu_data_for_pane(
    state: tauri::State<'_, AppState>,
    pane_id: String,
) -> Result<ClaudeMenuData, String> {
    let cwd = pane_current_path(&pane_id)?;
    if let Some(cached) = state.cached_claude_commands(&cwd) {
        return Ok(cached);
    }

    let menu = build_claude_menu_data(discover_claude_menu_from_cli(&cwd)?, &cwd);
    state.set_cached_claude_commands(cwd, menu.clone());
    Ok(menu)
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
        Some(tmux_state::create_session(Some(runtime::session_name()))?)
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

fn new_window_internal(
    app: tauri::AppHandle,
    target_session_id: Option<String>,
    select_new_window: bool,
) -> Result<String, String> {
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

    if select_new_window {
        tmux_state::select_window(&window_id)?;
    }
    tmux_state::emit_snapshot(&app)?;
    Ok(window_id)
}

#[tauri::command]
pub fn new_window(app: tauri::AppHandle, target_session_id: Option<String>) -> Result<String, String> {
    new_window_internal(app, target_session_id, true)
}

pub fn new_window_detached(app: tauri::AppHandle, target_session_id: Option<String>) -> Result<String, String> {
    new_window_internal(app, target_session_id, false)
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
    new_window_internal(app, Some(session_id), true)
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
    let window_id = new_window_internal(app.clone(), None, true)?;
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
        .args(["-9", "-f", &format!("tmux .* -L {}", runtime::tmux_server_name())])
        .status();
    let _ = std::fs::remove_file(runtime::tmux_socket_file_path());
    std::thread::sleep(std::time::Duration::from_millis(1000));

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let herd_sock_env = format!("HERD_SOCK={}", runtime::socket_path());
    let output = tmux::output(&[
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

    match crate::tmux_control::TmuxControl::start(runtime::session_name(), app.clone()) {
        Ok(control) => {
            state.set_control(control);
            state.set_last_active_session(Some(runtime::session_name().to_string()));
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
        "socket" => runtime::socket_log_path().to_string(),
        "cc" => runtime::cc_log_path().to_string(),
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
    std::fs::write(runtime::dom_result_path(), result)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn __set_test_driver_state(
    state: tauri::State<'_, AppState>,
    frontend_ready: Option<bool>,
    bootstrap_complete: Option<bool>,
) -> Result<(), String> {
    if let Some(ready) = frontend_ready {
        state.set_test_driver_frontend_ready(ready);
    }
    if let Some(complete) = bootstrap_complete {
        state.set_test_driver_bootstrap_complete(complete);
    }
    Ok(())
}

#[tauri::command]
pub fn __resolve_test_driver_request(
    state: tauri::State<'_, AppState>,
    request_id: String,
    data: Option<serde_json::Value>,
    error: Option<String>,
) -> Result<(), String> {
    let result = match error {
        Some(error) => Err(error),
        None => Ok(data.unwrap_or(serde_json::Value::Null)),
    };
    let _ = state.resolve_test_driver_request(&request_id, result)?;
    Ok(())
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
    use super::{
        control_client_tty_from_output,
        enrich_claude_commands,
        tmux_control_client_alive,
    };
    use std::fs;
    use std::path::PathBuf;

    fn temp_test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "herd-commands-test-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

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

    #[test]
    fn enriches_builtin_and_unknown_claude_commands() {
        let cwd = temp_test_dir("builtin");
        let commands = enrich_claude_commands(
            vec!["clear".into(), "model".into(), "mcp:deploy".into()],
            cwd.to_str().unwrap(),
        );

        assert_eq!(commands[0].name, "clear");
        assert_eq!(commands[0].execution, "execute");
        assert_eq!(commands[0].source, "builtin");

        assert_eq!(commands[1].name, "model");
        assert_eq!(commands[1].execution, "insert");
        assert_eq!(commands[1].source, "builtin");

        assert_eq!(commands[2].name, "mcp:deploy");
        assert_eq!(commands[2].execution, "insert");
        assert_eq!(commands[2].source, "unknown");

        let _ = fs::remove_dir_all(cwd);
    }

    #[test]
    fn custom_command_argument_hint_marks_insert_execution() {
        let cwd = temp_test_dir("custom");
        let command_dir = cwd.join(".claude/commands");
        fs::create_dir_all(&command_dir).unwrap();
        fs::write(
            command_dir.join("plan.md"),
            "---\nargument-hint: ticket\n---\n# Plan\n",
        )
        .unwrap();

        let commands = enrich_claude_commands(vec!["plan".into()], cwd.to_str().unwrap());
        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0].name, "plan");
        assert_eq!(commands[0].execution, "insert");
        assert_eq!(commands[0].source, "custom");

        let _ = fs::remove_dir_all(cwd);
    }
}
