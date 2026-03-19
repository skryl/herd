use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::process::Output;
use tauri::{AppHandle, Emitter, Manager};

use crate::{socket, state::AppState, tmux, SESSION_NAME};

#[derive(Debug, Clone, Serialize)]
pub struct TmuxSnapshot {
    pub version: u64,
    pub server_name: String,
    pub active_session_id: Option<String>,
    pub active_window_id: Option<String>,
    pub active_pane_id: Option<String>,
    pub sessions: Vec<TmuxSession>,
    pub windows: Vec<TmuxWindow>,
    pub panes: Vec<TmuxPane>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TmuxSession {
    pub id: String,
    pub name: String,
    pub active: bool,
    pub window_ids: Vec<String>,
    pub active_window_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TmuxWindow {
    pub id: String,
    pub session_id: String,
    pub session_name: String,
    pub index: u32,
    pub name: String,
    pub active: bool,
    pub cols: u32,
    pub rows: u32,
    pub pane_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TmuxPane {
    pub id: String,
    pub session_id: String,
    pub window_id: String,
    pub window_index: u32,
    pub pane_index: u32,
    pub cols: u32,
    pub rows: u32,
    pub title: String,
    pub command: String,
    pub active: bool,
    pub dead: bool,
}

fn parse_tmux_id_ordinal(id: &str) -> u32 {
    id.chars()
        .filter(char::is_ascii_digit)
        .collect::<String>()
        .parse()
        .unwrap_or_default()
}

fn parse_snapshot(
    version: u64,
    sessions_stdout: &str,
    windows_stdout: &str,
    panes_stdout: &str,
    clients_stdout: &str,
) -> TmuxSnapshot {
    let mut sessions: Vec<TmuxSession> = Vec::new();
    let mut windows: Vec<TmuxWindow> = Vec::new();
    let mut panes: Vec<TmuxPane> = Vec::new();

    let mut session_names: BTreeMap<String, String> = BTreeMap::new();
    let mut window_ids_by_session: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut active_window_by_session: BTreeMap<String, String> = BTreeMap::new();
    let mut pane_ids_by_window: BTreeMap<String, Vec<String>> = BTreeMap::new();

    for line in sessions_stdout.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() < 2 {
            continue;
        }
        let id = parts[0].to_string();
        let name = parts[1].to_string();
        session_names.insert(id.clone(), name.clone());
        window_ids_by_session.entry(id.clone()).or_default();
        sessions.push(TmuxSession {
            id,
            name,
            active: false,
            window_ids: Vec::new(),
            active_window_id: None,
        });
    }

    let client_state = clients_stdout.lines().find_map(|line| {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() < 3 {
            return None;
        }
        Some((
            parts[0].to_string(),
            parts[1].to_string(),
            parts[2].to_string(),
        ))
    });

    let mut active_session_id = client_state.as_ref().map(|(session_id, _, _)| session_id.clone());
    let mut active_window_id = client_state.as_ref().map(|(_, window_id, _)| window_id.clone());
    let mut active_pane_id = client_state.as_ref().map(|(_, _, pane_id)| pane_id.clone());

    for line in windows_stdout.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() < 8 {
            continue;
        }
        let session_id = parts[0].to_string();
        let session_name = parts[1].to_string();
        let id = parts[2].to_string();
        let active = parts[5] == "1";
        if active {
            active_window_by_session.insert(session_id.clone(), id.clone());
        }
        session_names.entry(session_id.clone()).or_insert_with(|| session_name.clone());
        window_ids_by_session
            .entry(session_id.clone())
            .or_default()
            .push(id.clone());
        pane_ids_by_window.entry(id.clone()).or_default();
        windows.push(TmuxWindow {
            id,
            session_id,
            session_name,
            index: parts[3].parse().unwrap_or_default(),
            name: parts[4].to_string(),
            active,
            cols: parts[6].parse().unwrap_or_default(),
            rows: parts[7].parse().unwrap_or_default(),
            pane_ids: Vec::new(),
        });
    }

    for line in panes_stdout.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() < 11 {
            continue;
        }
        let session_id = parts[0].to_string();
        let id = parts[1].to_string();
        let window_id = parts[2].to_string();
        let active = parts[7] == "1";
        if active_pane_id.is_none() && active_window_id.as_deref() == Some(window_id.as_str()) && active {
            active_pane_id = Some(id.clone());
        }
        pane_ids_by_window
            .entry(window_id.clone())
            .or_default()
            .push(id.clone());
        panes.push(TmuxPane {
            id,
            session_id,
            window_id,
            window_index: parts[3].parse().unwrap_or_default(),
            pane_index: parts[4].parse().unwrap_or_default(),
            title: parts[5].to_string(),
            command: parts[6].to_string(),
            active,
            dead: parts[8] == "1",
            cols: parts[9].parse().unwrap_or_default(),
            rows: parts[10].parse().unwrap_or_default(),
        });
    }

    if active_session_id.is_none() {
        active_session_id = sessions.first().map(|session| session.id.clone());
    }

    if active_window_id.is_none() {
        if let Some(session_id) = active_session_id.as_ref() {
            active_window_id = active_window_by_session.get(session_id).cloned().or_else(|| {
                windows
                    .iter()
                    .find(|window| &window.session_id == session_id)
                    .map(|window| window.id.clone())
            });
        }
    }

    if active_pane_id.is_none() {
        if let Some(window_id) = active_window_id.as_ref() {
            active_pane_id = pane_ids_by_window
                .get(window_id)
                .and_then(|pane_ids| pane_ids.first().cloned());
        }
    }

    let known_session_ids: BTreeSet<String> = windows
        .iter()
        .map(|window| window.session_id.clone())
        .chain(panes.iter().map(|pane| pane.session_id.clone()))
        .chain(session_names.keys().cloned())
        .collect();

    for session_id in known_session_ids {
        if sessions.iter().any(|session| session.id == session_id) {
            continue;
        }
        sessions.push(TmuxSession {
            id: session_id.clone(),
            name: session_names.get(&session_id).cloned().unwrap_or_else(|| session_id.clone()),
            active: false,
            window_ids: Vec::new(),
            active_window_id: None,
        });
    }

    sessions.sort_by_key(|session| parse_tmux_id_ordinal(&session.id));
    windows.sort_by_key(|window| (parse_tmux_id_ordinal(&window.session_id), window.index));
    panes.sort_by_key(|pane| (parse_tmux_id_ordinal(&pane.session_id), pane.window_index, pane.pane_index));

    for session in &mut sessions {
        session.active = active_session_id.as_deref() == Some(session.id.as_str());
        session.window_ids = window_ids_by_session
            .get(&session.id)
            .cloned()
            .unwrap_or_default();
        session.active_window_id = active_window_by_session
            .get(&session.id)
            .cloned()
            .or_else(|| session.window_ids.first().cloned());
    }

    for window in &mut windows {
        window.pane_ids = pane_ids_by_window
            .get(&window.id)
            .cloned()
            .unwrap_or_default();
        if active_window_id.as_deref() == Some(window.id.as_str()) {
            window.active = true;
        }
    }

    TmuxSnapshot {
        version,
        server_name: tmux::server_name().to_string(),
        active_session_id,
        active_window_id,
        active_pane_id,
        sessions,
        windows,
        panes,
    }
}

fn run_tmux(args: &[&str]) -> Result<Output, String> {
    tmux::output(args)
}

fn ensure_success(output: Output, context: &str) -> Result<Output, String> {
    if output.status.success() {
        Ok(output)
    } else {
        Err(format!(
            "{context}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

fn existing_session_names() -> Result<Vec<String>, String> {
    let output = run_tmux(&["list-sessions", "-F", "#{session_name}"])?;
    if !output.status.success() {
        return Ok(Vec::new());
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|line| line.to_string())
        .collect())
}

fn unique_session_name(base: Option<&str>) -> Result<String, String> {
    let base = base.filter(|value| !value.trim().is_empty()).unwrap_or("tab");
    let existing: BTreeSet<String> = existing_session_names()?.into_iter().collect();
    if !existing.contains(base) {
        return Ok(base.to_string());
    }
    for idx in 2..1000 {
        let candidate = format!("{base}-{idx}");
        if !existing.contains(&candidate) {
            return Ok(candidate);
        }
    }
    Err("unable to allocate a unique tmux session name".into())
}

pub fn ensure_default_session() -> Result<String, String> {
    if let Some(name) = first_session_name()? {
        return Ok(name);
    }
    let herd_sock = format!("HERD_SOCK={}", socket::SOCKET_PATH);
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    ensure_success(
        run_tmux(&[
            "new-session",
            "-d",
            "-s",
            SESSION_NAME,
            "-x",
            "80",
            "-y",
            "24",
            "-e",
            &herd_sock,
            &shell,
        ])?,
        "tmux new-session failed",
    )?;
    Ok(SESSION_NAME.to_string())
}

pub fn first_session_name() -> Result<Option<String>, String> {
    let output = run_tmux(&["list-sessions", "-F", "#{session_name}"])?;
    if !output.status.success() {
        return Ok(None);
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|line| line.trim())
        .find(|line| !line.is_empty())
        .map(|line| line.to_string()))
}

pub fn create_session(name: Option<&str>) -> Result<String, String> {
    let herd_sock = format!("HERD_SOCK={}", socket::SOCKET_PATH);
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let session_name = unique_session_name(name)?;
    let output = ensure_success(
        run_tmux(&[
            "new-session",
            "-d",
            "-P",
            "-F",
            "#{session_id}",
            "-s",
            &session_name,
            "-x",
            "80",
            "-y",
            "24",
            "-e",
            &herd_sock,
            &shell,
        ])?,
        "tmux new-session failed",
    )?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

pub fn create_window(target_pane: Option<&str>, command: Option<&str>) -> Result<String, String> {
    let herd_sock = format!("HERD_SOCK={}", socket::SOCKET_PATH);
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let command = command.unwrap_or(&shell);

    let mut split_args = vec![
        "split-window",
        "-d",
        "-P",
        "-F",
        "#{pane_id}",
        "-e",
        &herd_sock,
    ];
    if let Some(target) = target_pane {
        split_args.push("-t");
        split_args.push(target);
    }
    split_args.push(command);

    let split_output = ensure_success(run_tmux(&split_args)?, "tmux split-window failed")?;
    let pane_id = String::from_utf8_lossy(&split_output.stdout).trim().to_string();
    ensure_success(
        run_tmux(&["break-pane", "-d", "-s", &pane_id])?,
        "tmux break-pane failed",
    )?;
    Ok(pane_id)
}

pub fn kill_pane(pane_id: &str) -> Result<(), String> {
    ensure_success(run_tmux(&["kill-pane", "-t", pane_id])?, "tmux kill-pane failed")?;
    Ok(())
}

pub fn kill_window(window_id: &str) -> Result<(), String> {
    ensure_success(run_tmux(&["kill-window", "-t", window_id])?, "tmux kill-window failed")?;
    Ok(())
}

pub fn respawn_window(window_id: &str) -> Result<(), String> {
    let herd_sock = format!("HERD_SOCK={}", socket::SOCKET_PATH);
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    ensure_success(
        run_tmux(&[
            "respawn-window",
            "-k",
            "-t",
            window_id,
            "-e",
            &herd_sock,
            &shell,
        ])?,
        "tmux respawn-window failed",
    )?;
    Ok(())
}

pub fn kill_session(session_id: &str) -> Result<(), String> {
    ensure_success(run_tmux(&["kill-session", "-t", session_id])?, "tmux kill-session failed")?;
    Ok(())
}

pub fn select_window(window_id: &str) -> Result<(), String> {
    ensure_success(run_tmux(&["select-window", "-t", window_id])?, "tmux select-window failed")?;
    Ok(())
}

pub fn select_session(session_id: &str) -> Result<(), String> {
    ensure_success(run_tmux(&["switch-client", "-t", session_id])?, "tmux switch-client failed")?;
    Ok(())
}

pub fn resize_window(window_id: &str, cols: u16, rows: u16) -> Result<(), String> {
    ensure_success(
        run_tmux(&["set-window-option", "-t", window_id, "window-size", "manual"])?,
        "tmux set window-size manual failed",
    )?;
    ensure_success(
        run_tmux(&[
            "resize-window",
            "-t",
            window_id,
            "-x",
            &cols.to_string(),
            "-y",
            &rows.to_string(),
        ])?,
        "tmux resize-window failed",
    )?;
    Ok(())
}

pub fn rename_window(window_id: &str, name: &str) -> Result<(), String> {
    ensure_success(run_tmux(&["rename-window", "-t", window_id, name])?, "tmux rename-window failed")?;
    Ok(())
}

pub fn rename_session(session_id: &str, name: &str) -> Result<(), String> {
    let next_name = unique_session_name(Some(name))?;
    ensure_success(run_tmux(&["rename-session", "-t", session_id, &next_name])?, "tmux rename-session failed")?;
    Ok(())
}

pub fn set_pane_title(pane_id: &str, title: &str) -> Result<(), String> {
    ensure_success(run_tmux(&["select-pane", "-t", pane_id, "-T", title])?, "tmux set pane title failed")?;
    Ok(())
}

pub fn snapshot(state: &AppState) -> Result<TmuxSnapshot, String> {
    let sessions_output = ensure_success(
        run_tmux(&["list-sessions", "-F", "#{session_id}\t#{session_name}"])?,
        "tmux list-sessions failed",
    )?;

    let windows_output = ensure_success(
        run_tmux(&[
            "list-windows",
            "-a",
            "-F",
            "#{session_id}\t#{session_name}\t#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_width}\t#{window_height}",
        ])?,
        "tmux list-windows failed",
    )?;

    let panes_output = ensure_success(
        run_tmux(&[
            "list-panes",
            "-a",
            "-F",
            "#{session_id}\t#{pane_id}\t#{window_id}\t#{window_index}\t#{pane_index}\t#{pane_title}\t#{pane_current_command}\t#{pane_active}\t#{pane_dead}\t#{pane_width}\t#{pane_height}",
        ])?,
        "tmux list-panes failed",
    )?;

    let clients_output = run_tmux(&[
        "list-clients",
        "-F",
        "#{session_id}\t#{window_id}\t#{pane_id}",
    ])?;

    Ok(parse_snapshot(
        state.next_snapshot_version(),
        &String::from_utf8_lossy(&sessions_output.stdout),
        &String::from_utf8_lossy(&windows_output.stdout),
        &String::from_utf8_lossy(&panes_output.stdout),
        &String::from_utf8_lossy(&clients_output.stdout),
    ))
}

pub fn emit_snapshot(app: &AppHandle) -> Result<(), String> {
    let state = app
        .try_state::<AppState>()
        .ok_or("app state not initialized")?;
    let snapshot = snapshot(&state)?;
    app.emit("tmux-state", &snapshot)
        .map_err(|e| format!("emit tmux-state failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::parse_snapshot;

    #[test]
    fn parse_snapshot_keeps_sessions_windows_and_panes() {
        let snapshot = parse_snapshot(
            7,
            "$1\talpha\n$2\tbeta\n",
            "$1\talpha\t@0\t0\tone\t1\t80\t24\n\
             $1\talpha\t@1\t1\ttwo\t0\t90\t30\n\
             $2\tbeta\t@2\t0\tthree\t1\t120\t40\n",
            "$1\t%0\t@0\t0\t0\tone\tzsh\t1\t0\t80\t24\n\
             $1\t%1\t@1\t1\t0\ttwo\tzsh\t1\t0\t90\t30\n\
             $2\t%2\t@2\t0\t0\tthree\tzsh\t1\t0\t120\t40\n",
            "$2\t@2\t%2\n",
        );

        assert_eq!(snapshot.active_session_id.as_deref(), Some("$2"));
        assert_eq!(snapshot.active_window_id.as_deref(), Some("@2"));
        assert_eq!(snapshot.active_pane_id.as_deref(), Some("%2"));
        assert_eq!(snapshot.sessions.len(), 2);
        assert_eq!(snapshot.sessions[0].window_ids, vec!["@0", "@1"]);
        assert_eq!(snapshot.sessions[1].window_ids, vec!["@2"]);
        assert_eq!(snapshot.windows[0].session_id, "$1");
        assert_eq!(snapshot.windows[2].session_id, "$2");
        assert_eq!(snapshot.windows[2].pane_ids, vec!["%2"]);
        assert_eq!(snapshot.panes[2].session_id, "$2");
    }
}
