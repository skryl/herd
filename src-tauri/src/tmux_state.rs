use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::process::Output;
use tauri::{AppHandle, Emitter, Manager};

use crate::{
    agent::AgentRole,
    browser::BrowserBackend,
    network::{self, NetworkTileKind},
    runtime,
    state::{AppState, WindowParentSource},
    tile_registry::TileRecord,
    tmux,
};

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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root_cwd: Option<String>,
    pub browser_backend: BrowserBackend,
}

#[derive(Debug, Clone, Serialize)]
pub struct TmuxWindow {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tile_id: Option<String>,
    pub session_id: String,
    pub session_name: String,
    pub index: u32,
    pub name: String,
    pub active: bool,
    pub cols: u32,
    pub rows: u32,
    pub pane_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_window_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_window_source: Option<WindowParentSource>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TmuxPane {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tile_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
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

fn pane_role_for_record(
    state: &AppState,
    record: &TileRecord,
    window_name: &str,
    pane_title: &str,
) -> Result<String, String> {
    let agent_role = if record.kind == crate::tile_registry::TileRecordKind::Agent
        && (state.agent_info_by_tile_role(&record.tile_id, AgentRole::Root)?.is_some()
            || state.agent_info_by_pane_role(&record.pane_id, AgentRole::Root)?.is_some())
    {
        Some(AgentRole::Root)
    } else {
        None
    };
    Ok(match network::network_tile_kind_from_record_kind(record.kind, agent_role, window_name, pane_title) {
        NetworkTileKind::RootAgent => "root_agent".to_string(),
        NetworkTileKind::Agent => "claude".to_string(),
        NetworkTileKind::Browser => "browser".to_string(),
        NetworkTileKind::Work => "work".to_string(),
        NetworkTileKind::Shell => "regular".to_string(),
    })
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
    tracked_control_pid: Option<libc::pid_t>,
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
            root_cwd: None,
            browser_backend: BrowserBackend::default(),
        });
    }

    let tracked_control_pid = tracked_control_pid.map(|pid| pid.to_string());
    let mut fallback_control_client: Option<(String, String, String)> = None;
    let mut fallback_client: Option<(String, String, String)> = None;

    let client_state = clients_stdout.lines().find_map(|line| {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() < 5 {
            return None;
        }
        let client_pid = parts[0];
        let control_mode = parts[1] == "1";
        let state = (
            parts[2].to_string(),
            parts[3].to_string(),
            parts[4].to_string(),
        );
        if tracked_control_pid.as_deref() == Some(client_pid) && control_mode {
            return Some(state);
        }
        if control_mode && fallback_control_client.is_none() {
            fallback_control_client = Some(state.clone());
        }
        if fallback_client.is_none() {
            fallback_client = Some(state);
        }
        None
    }).or(fallback_control_client).or(fallback_client);

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
            tile_id: None,
            session_id,
            session_name,
            index: parts[3].parse().unwrap_or_default(),
            name: parts[4].to_string(),
            active,
            cols: parts[6].parse().unwrap_or_default(),
            rows: parts[7].parse().unwrap_or_default(),
            pane_ids: Vec::new(),
            parent_window_id: None,
            parent_window_source: None,
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
            tile_id: None,
            role: None,
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
            root_cwd: None,
            browser_backend: BrowserBackend::default(),
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

#[derive(Debug, Clone, PartialEq, Eq)]
struct PaneNormalizationRow {
    session_id: String,
    window_id: String,
    pane_id: String,
    active: bool,
    title: String,
}

fn pane_normalization_plan(rows: &[PaneNormalizationRow]) -> Vec<(String, String, String, String)> {
    let mut by_window: BTreeMap<&str, Vec<&PaneNormalizationRow>> = BTreeMap::new();
    for row in rows {
        by_window.entry(row.window_id.as_str()).or_default().push(row);
    }

    let mut moves = Vec::new();
    for panes in by_window.values() {
        if panes.len() <= 1 {
            continue;
        }
        let keep_pane_id = panes
            .iter()
            .find(|row| row.active)
            .or_else(|| panes.first())
            .map(|row| row.pane_id.as_str());

        for row in panes {
            if Some(row.pane_id.as_str()) == keep_pane_id {
                continue;
            }
            moves.push((
                row.session_id.clone(),
                row.window_id.clone(),
                row.pane_id.clone(),
                row.title.clone(),
            ));
        }
    }

    moves
}

pub fn normalize_multi_pane_windows(state: &AppState) -> Result<bool, String> {
    let output = ensure_success(
        run_tmux(&[
            "list-panes",
            "-a",
            "-F",
            "#{session_id}\t#{window_id}\t#{pane_id}\t#{pane_active}\t#{pane_title}",
        ])?,
        "tmux list-panes failed during normalization",
    )?;

    let rows: Vec<PaneNormalizationRow> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() < 5 {
                return None;
            }
            Some(PaneNormalizationRow {
                session_id: parts[0].to_string(),
                window_id: parts[1].to_string(),
                pane_id: parts[2].to_string(),
                active: parts[3] == "1",
                title: parts[4].to_string(),
            })
        })
        .collect();

    let moves = pane_normalization_plan(&rows);
    if moves.is_empty() {
        return Ok(false);
    }

    for (session_id, source_window_id, pane_id, title) in moves {
        let output = ensure_success(
            run_tmux(&[
                "break-pane",
                "-d",
                "-P",
                "-F",
                "#{window_id}",
                "-s",
                &pane_id,
                "-t",
                &format!("{session_id}:"),
            ])?,
            "tmux break-pane failed during normalization",
        )?;
        let new_window_id = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !new_window_id.is_empty() {
            state.set_window_parent_with_source(&new_window_id, Some(source_window_id.clone()), WindowParentSource::Hook);
        }
        if !new_window_id.is_empty() && !title.trim().is_empty() {
            let _ = rename_window(&new_window_id, &title);
        }
    }

    Ok(true)
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

fn default_session_root_cwd() -> String {
    runtime::project_root_dir()
        .to_str()
        .map(str::to_string)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string()))
}

const SESSION_ROOT_CWD_ENV: &str = "HERD_TAB_ROOT_CWD";
const SESSION_BROWSER_BACKEND_ENV: &str = "HERD_BROWSER_BACKEND";

pub fn set_session_root_cwd(target: &str, cwd: &str) -> Result<(), String> {
    ensure_success(
        run_tmux(&["set-environment", "-t", target, SESSION_ROOT_CWD_ENV, cwd])?,
        "tmux set-environment HERD_TAB_ROOT_CWD failed",
    )?;
    Ok(())
}

pub fn set_session_browser_backend(target: &str, backend: BrowserBackend) -> Result<(), String> {
    ensure_success(
        run_tmux(&["set-environment", "-t", target, SESSION_BROWSER_BACKEND_ENV, backend.as_str()])?,
        "tmux set-environment HERD_BROWSER_BACKEND failed",
    )?;
    Ok(())
}

pub fn set_session_env(target: &str, key: &str, value: &str) -> Result<(), String> {
    ensure_success(
        run_tmux(&["set-environment", "-t", target, key, value])?,
        &format!("tmux set-environment {key} failed"),
    )?;
    Ok(())
}

pub fn session_root_cwd(target: &str) -> Result<Option<String>, String> {
    let output = run_tmux(&["show-environment", "-t", target, SESSION_ROOT_CWD_ENV])?;
    if !output.status.success() {
        return Ok(None);
    }
    let value = String::from_utf8_lossy(&output.stdout)
        .trim()
        .strip_prefix(&format!("{SESSION_ROOT_CWD_ENV}="))
        .map(str::to_string);
    Ok(value.filter(|value| !value.trim().is_empty()))
}

pub fn session_browser_backend(target: &str) -> Result<Option<BrowserBackend>, String> {
    let output = run_tmux(&["show-environment", "-t", target, SESSION_BROWSER_BACKEND_ENV])?;
    if !output.status.success() {
        return Ok(None);
    }
    let raw = String::from_utf8_lossy(&output.stdout);
    let Some(value) = raw.trim().strip_prefix(&format!("{SESSION_BROWSER_BACKEND_ENV}=")) else {
        return Ok(None);
    };
    BrowserBackend::parse(value).map(Some)
}

pub fn ensure_session_root_cwd(target: &str) -> Result<String, String> {
    if let Some(existing) = session_root_cwd(target)? {
        return Ok(existing);
    }
    let cwd = default_session_root_cwd();
    set_session_root_cwd(target, &cwd)?;
    Ok(cwd)
}

fn default_session_browser_backend() -> BrowserBackend {
    if crate::browser::agent_browser_is_ready() {
        BrowserBackend::AgentBrowser
    } else {
        BrowserBackend::LiveWebview
    }
}

pub fn ensure_session_browser_backend(target: &str) -> Result<BrowserBackend, String> {
    if let Some(existing) = session_browser_backend(target)? {
        return Ok(existing);
    }
    let backend = default_session_browser_backend();
    set_session_browser_backend(target, backend)?;
    Ok(backend)
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
        let _ = set_session_env(&name, "HERD_SOCK", runtime::socket_path());
        let _ = ensure_session_root_cwd(&name);
        let _ = ensure_session_browser_backend(&name);
        return Ok(name);
    }
    let herd_sock = format!("HERD_SOCK={}", runtime::socket_path());
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    ensure_success(
        run_tmux(&[
            "new-session",
            "-d",
            "-s",
            runtime::session_name(),
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
    let _ = set_session_env(runtime::session_name(), "HERD_SOCK", runtime::socket_path());
    let _ = set_session_root_cwd(runtime::session_name(), &default_session_root_cwd());
    let _ = set_session_browser_backend(runtime::session_name(), default_session_browser_backend());
    Ok(runtime::session_name().to_string())
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
    let herd_sock = format!("HERD_SOCK={}", runtime::socket_path());
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
    let session_id = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let _ = set_session_env(&session_id, "HERD_SOCK", runtime::socket_path());
    let _ = set_session_root_cwd(&session_id, &default_session_root_cwd());
    let _ = set_session_browser_backend(&session_id, default_session_browser_backend());
    Ok(session_id)
}

pub fn create_window(target_pane: Option<&str>, command: Option<&str>) -> Result<String, String> {
    let herd_sock = format!("HERD_SOCK={}", runtime::socket_path());
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let command = command.unwrap_or(&shell);
    let mut session_name = None;

    if let Some(target) = target_pane {
        let session_output = ensure_success(
            run_tmux(&["display-message", "-p", "-t", target, "#{session_name}"])?,
            "tmux display-message failed",
        )?;
        let resolved = String::from_utf8_lossy(&session_output.stdout).trim().to_string();
        if resolved.is_empty() {
            return Err(format!("tmux returned an empty session name for pane {target}"));
        }
        session_name = Some(resolved);
    }

    let mut window_args = vec![
        "new-window".to_string(),
        "-d".to_string(),
        "-P".to_string(),
        "-F".to_string(),
        "#{pane_id}".to_string(),
        "-e".to_string(),
        herd_sock,
    ];
    if let Some(target_session) = session_name.as_ref() {
        window_args.push("-t".to_string());
        window_args.push(target_session.clone());
    }
    window_args.push(command.to_string());
    let window_args_refs = window_args.iter().map(|value| value.as_str()).collect::<Vec<_>>();

    let output = ensure_success(run_tmux(&window_args_refs)?, "tmux new-window failed")?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

pub fn kill_pane(pane_id: &str) -> Result<(), String> {
    ensure_success(run_tmux(&["kill-pane", "-t", pane_id])?, "tmux kill-pane failed")?;
    Ok(())
}

pub fn kill_window(window_id: &str) -> Result<(), String> {
    ensure_success(run_tmux(&["kill-window", "-t", window_id])?, "tmux kill-window failed")?;
    Ok(())
}

fn respawn_window_args(window_id: &str) -> Vec<String> {
    let herd_sock = format!("HERD_SOCK={}", runtime::socket_path());
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    vec![
        "respawn-window".to_string(),
        "-k".to_string(),
        "-t".to_string(),
        window_id.to_string(),
        "-e".to_string(),
        herd_sock,
        shell,
    ]
}

pub fn respawn_window(window_id: &str) -> Result<(), String> {
    let args = respawn_window_args(window_id);
    let arg_refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    ensure_success(
        run_tmux(&arg_refs)?,
        "tmux respawn-window failed",
    )?;
    Ok(())
}

fn respawn_pane_shell_command_args(pane_id: &str, command: &str, tile_id: Option<&str>) -> Vec<String> {
    let herd_sock = format!("HERD_SOCK={}", runtime::socket_path());
    let mut args = vec![
        "respawn-pane".to_string(),
        "-k".to_string(),
        "-t".to_string(),
        pane_id.to_string(),
        "-e".to_string(),
        herd_sock,
        "/bin/bash".to_string(),
        "-lc".to_string(),
        command.to_string(),
    ];
    if let Some(tile_id) = tile_id {
        args.splice(
            6..6,
            [
                "-e".to_string(),
                format!("HERD_TILE_ID={tile_id}"),
            ],
        );
    }
    args
}

pub fn respawn_pane_shell_command(pane_id: &str, command: &str, tile_id: Option<&str>) -> Result<(), String> {
    let args = respawn_pane_shell_command_args(pane_id, command, tile_id);
    let arg_refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    ensure_success(
        run_tmux(&arg_refs)?,
        "tmux respawn-pane failed",
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

pub fn pane_pid(pane_id: &str) -> Result<Option<u32>, String> {
    let output = ensure_success(
        run_tmux(&["display-message", "-p", "-t", pane_id, "#{pane_pid}"])?,
        "tmux display-message failed",
    )?;
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if value.is_empty() {
        return Ok(None);
    }
    let pid = value
        .parse::<u32>()
        .map_err(|error| format!("invalid tmux pane pid for {pane_id}: {error}"))?;
    Ok(Some(pid))
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
        "#{client_pid}\t#{client_control_mode}\t#{session_id}\t#{window_id}\t#{pane_id}",
    ])?;

    let mut snapshot = parse_snapshot(
        state.next_snapshot_version(),
        &String::from_utf8_lossy(&sessions_output.stdout),
        &String::from_utf8_lossy(&windows_output.stdout),
        &String::from_utf8_lossy(&panes_output.stdout),
        &String::from_utf8_lossy(&clients_output.stdout),
        state.current_control_pid(),
    );

    let live_window_ids: BTreeSet<String> = snapshot.windows.iter().map(|window| window.id.clone()).collect();
    let session_by_window: BTreeMap<String, String> = snapshot
        .windows
        .iter()
        .map(|window| (window.id.clone(), window.session_id.clone()))
        .collect();

    state.retain_window_parents(|child, parent| {
        if child == parent {
            return false;
        }
        let Some(child_session_id) = session_by_window.get(child) else {
            return false;
        };
        let Some(parent_session_id) = session_by_window.get(parent) else {
            return false;
        };
        live_window_ids.contains(child)
            && live_window_ids.contains(parent)
            && child_session_id == parent_session_id
    });

    let window_parents = state.window_parents_snapshot();
    let window_parent_sources = state.window_parent_sources_snapshot();
    for window in &mut snapshot.windows {
        window.parent_window_id = window_parents.get(&window.id).cloned();
        window.parent_window_source = window_parent_sources.get(&window.id).copied();
    }

    for session in &mut snapshot.sessions {
        session.root_cwd = session_root_cwd(&session.id)
            .ok()
            .flatten()
            .or_else(|| Some(default_session_root_cwd()));
        session.browser_backend = session_browser_backend(&session.id)
            .ok()
            .flatten()
            .unwrap_or_else(default_session_browser_backend);
    }

    Ok(snapshot)
}

pub fn emit_snapshot(app: &AppHandle) -> Result<(), String> {
    let state = app
        .try_state::<AppState>()
        .ok_or("app state not initialized")?;
    if normalize_multi_pane_windows(&state)? {
        log::info!("Normalized tmux multi-pane windows back to single-pane windows");
    }
    let mut snapshot = snapshot(&state)?;
    let tile_records = state.tile_records_snapshot()?;
    let tile_record_by_window = tile_records
        .iter()
        .map(|record| (record.window_id.as_str(), record))
        .collect::<std::collections::HashMap<_, _>>();
    let window_name_by_id = snapshot
        .windows
        .iter()
        .map(|window| (window.id.clone(), window.name.clone()))
        .collect::<std::collections::HashMap<_, _>>();
    let tile_id_by_window = tile_records
        .iter()
        .map(|record| (record.window_id.as_str(), record.tile_id.clone()))
        .collect::<std::collections::HashMap<_, _>>();
    let tile_id_by_pane = tile_records
        .iter()
        .map(|record| (record.pane_id.as_str(), record.tile_id.clone()))
        .collect::<std::collections::HashMap<_, _>>();
    for window in &mut snapshot.windows {
        window.tile_id = tile_id_by_window.get(window.id.as_str()).cloned();
    }
    for pane in &mut snapshot.panes {
        pane.tile_id = tile_id_by_pane.get(pane.id.as_str()).cloned();
        pane.role = tile_record_by_window
            .get(pane.window_id.as_str())
            .and_then(|record| {
                let window_name = window_name_by_id
                    .get(pane.window_id.as_str())
                    .map(|name| name.as_str())
                    .unwrap_or("");
                pane_role_for_record(&state, record, window_name, &pane.title).ok()
            });
    }
    state.set_last_active_session(snapshot.active_session_id.clone());
    app.emit("tmux-state", &snapshot)
        .map_err(|e| format!("emit tmux-state failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::{
        pane_normalization_plan,
        parse_snapshot,
        respawn_pane_shell_command_args,
        PaneNormalizationRow,
    };
    use crate::runtime;

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
            "92568\t1\t$2\t@2\t%2\n",
            Some(92568),
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

    #[test]
    fn parse_snapshot_prefers_the_tracked_control_client() {
        let snapshot = parse_snapshot(
            8,
            "$1\talpha\n$2\tbeta\n",
            "$1\talpha\t@0\t0\tone\t1\t80\t24\n\
             $2\tbeta\t@2\t0\tthree\t1\t120\t40\n",
            "$1\t%0\t@0\t0\t0\tone\tzsh\t1\t0\t80\t24\n\
             $2\t%2\t@2\t0\t0\tthree\tzsh\t1\t0\t120\t40\n",
            "11111\t0\t$1\t@0\t%0\n\
             92568\t1\t$2\t@2\t%2\n",
            Some(92568),
        );

        assert_eq!(snapshot.active_session_id.as_deref(), Some("$2"));
        assert_eq!(snapshot.active_window_id.as_deref(), Some("@2"));
        assert_eq!(snapshot.active_pane_id.as_deref(), Some("%2"));
    }

    #[test]
    fn pane_normalization_plan_keeps_the_active_pane_and_breaks_the_rest() {
        let plan = pane_normalization_plan(&[
            PaneNormalizationRow {
                session_id: "$1".to_string(),
                window_id: "@1".to_string(),
                pane_id: "%1".to_string(),
                active: false,
                title: "Agent".to_string(),
            },
            PaneNormalizationRow {
                session_id: "$1".to_string(),
                window_id: "@1".to_string(),
                pane_id: "%2".to_string(),
                active: true,
                title: "Agent A".to_string(),
            },
            PaneNormalizationRow {
                session_id: "$1".to_string(),
                window_id: "@1".to_string(),
                pane_id: "%3".to_string(),
                active: false,
                title: "Agent B".to_string(),
            },
            PaneNormalizationRow {
                session_id: "$2".to_string(),
                window_id: "@2".to_string(),
                pane_id: "%4".to_string(),
                active: true,
                title: "Shell".to_string(),
            },
        ]);

        assert_eq!(
            plan,
            vec![
                ("$1".to_string(), "@1".to_string(), "%1".to_string(), "Agent".to_string()),
                ("$1".to_string(), "@1".to_string(), "%3".to_string(), "Agent B".to_string()),
            ]
        );
    }

    #[test]
    fn shell_respawn_args_include_socket_and_tile_env() {
        let args = respawn_pane_shell_command_args("%42", "printf ready\\n", Some("tile-abc123"));
        assert_eq!(args[0], "respawn-pane");
        assert!(args.contains(&format!("HERD_SOCK={}", runtime::socket_path())));
        assert!(args.contains(&"HERD_TILE_ID=tile-abc123".to_string()));
        assert!(args.ends_with(&["/bin/bash".to_string(), "-lc".to_string(), "printf ready\\n".to_string()]));
    }
}
