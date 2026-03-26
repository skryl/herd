use crate::{
    agent::{now_ms, AgentChannelEvent, AgentChannelEventKind, AgentDebugState, AgentRole, AgentType},
    browser,
    network::{self, NetworkConnection, NetworkTileDescriptor, NetworkTileKind},
    persist::TileState,
    runtime,
    state::AppState,
    tile_registry::{self, TileRecord, TileRecordKind},
    tmux,
    tmux_state,
    work,
};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::{Emitter, Manager};

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

#[derive(Debug, Clone, Serialize)]
pub struct BrowserWindowSpawn {
    pub tile_id: String,
    pub pane_id: String,
    pub window_id: String,
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ShellWindowSpawn {
    pub tile_id: String,
    pub pane_id: String,
    pub window_id: String,
    pub session_id: String,
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

fn active_or_last_session_id(state: &AppState) -> Result<String, String> {
    if let Some(session_id) = state.last_active_session() {
        return Ok(session_id);
    }
    active_session_id(&tmux_state::snapshot(state)?)
}

fn pane_network_tile_kind(
    state: &AppState,
    snapshot: &tmux_state::TmuxSnapshot,
    pane_id: &str,
) -> Result<NetworkTileKind, String> {
    let record = state
        .tile_record_by_pane(pane_id)?
        .ok_or_else(|| format!("unknown tile record for tmux pane: {pane_id}"))?;
    let pane = snapshot
        .panes
        .iter()
        .find(|pane| pane.id == pane_id)
        .ok_or_else(|| format!("unknown tmux pane: {pane_id}"))?;
    let window_name = snapshot
        .windows
        .iter()
        .find(|window| window.id == pane.window_id)
        .map(|window| window.name.as_str())
        .unwrap_or("");
    let agent_role = if state.agent_info_by_tile_role(&record.tile_id, AgentRole::Root)?.is_some()
        || state.agent_info_by_pane_role(pane_id, AgentRole::Root)?.is_some()
    {
        Some(AgentRole::Root)
    } else {
        None
    };
    Ok(crate::network::network_tile_kind_from_record_kind(
        record.kind,
        agent_role,
        window_name,
        &pane.title,
    ))
}

fn reconciled_tmux_tile_records(
    state: &AppState,
    snapshot: &tmux_state::TmuxSnapshot,
) -> Result<
    (
        Vec<TileRecord>,
        std::collections::HashMap<String, String>,
        std::collections::HashMap<String, String>,
    ),
    String,
> {
    let existing = state.tile_records_snapshot()?;
    let mut existing_by_window = existing
        .iter()
        .cloned()
        .map(|record| (record.window_id.clone(), record))
        .collect::<std::collections::HashMap<_, _>>();
    let mut existing_by_pane = existing
        .into_iter()
        .map(|record| (record.pane_id.clone(), record))
        .collect::<std::collections::HashMap<_, _>>();
    let mut records = Vec::new();
    let mut pane_to_tile = std::collections::HashMap::new();
    let mut window_to_tile = std::collections::HashMap::new();
    let db_path = Path::new(runtime::database_path());

    for window in &snapshot.windows {
        let Some(pane_id) = window.pane_ids.first() else {
            continue;
        };
        let pane = snapshot
            .panes
            .iter()
            .find(|pane| pane.id == *pane_id)
            .ok_or_else(|| format!("missing pane {pane_id} for tmux window {}", window.id))?;
        let now_ms = now_ms();
        let existing = existing_by_window
            .remove(&window.id)
            .or_else(|| existing_by_pane.remove(pane_id));
        let tile_id = match existing.as_ref() {
            Some(record) => record.tile_id.clone(),
            None => tile_registry::generate_unique_tile_id_at(db_path)?,
        };
        let kind = crate::network::reconciled_tmux_tile_record_kind(
            existing.as_ref().map(|record| record.kind),
            &window.name,
            &pane.title,
        );
        pane_to_tile.insert(pane.id.clone(), tile_id.clone());
        window_to_tile.insert(window.id.clone(), tile_id.clone());
        records.push(TileRecord {
            tile_id,
            session_id: window.session_id.clone(),
            kind,
            window_id: window.id.clone(),
            pane_id: pane.id.clone(),
            browser_incognito: if kind == TileRecordKind::Browser {
                existing.as_ref().map(|record| record.browser_incognito).unwrap_or(false)
            } else {
                false
            },
            created_at: existing.as_ref().map(|record| record.created_at).unwrap_or(now_ms),
            updated_at: now_ms,
        });
    }

    records.sort_by(|left, right| {
        left.session_id
            .cmp(&right.session_id)
            .then_with(|| left.tile_id.cmp(&right.tile_id))
    });
    Ok((records, pane_to_tile, window_to_tile))
}

fn migrate_layout_entries_to_tile_ids(
    state: &AppState,
    pane_to_tile: &std::collections::HashMap<String, String>,
    window_to_tile: &std::collections::HashMap<String, String>,
    work_tile_map: &std::collections::HashMap<String, String>,
) {
    let existing = state
        .tile_states
        .lock()
        .map(|entries| entries.clone())
        .unwrap_or_default();
    let mut next = std::collections::HashMap::new();

    for (entry_id, layout) in existing {
        let resolved_id = if pane_to_tile.values().any(|tile_id| tile_id == &entry_id)
            || work_tile_map.values().any(|tile_id| tile_id == &entry_id)
        {
            Some(entry_id.clone())
        } else if let Some(tile_id) = window_to_tile.get(&entry_id) {
            Some(tile_id.clone())
        } else if let Some(tile_id) = pane_to_tile.get(&entry_id) {
            Some(tile_id.clone())
        } else {
            work_tile_map.get(&entry_id).cloned()
        };
        if let Some(tile_id) = resolved_id {
            next.entry(tile_id).or_insert(layout);
        }
    }

    if let Ok(mut entries) = state.tile_states.lock() {
        *entries = next;
    }
    state.save();
}

fn migrate_network_connections_to_tile_ids(
    pane_to_tile: &std::collections::HashMap<String, String>,
    work_tile_map: &std::collections::HashMap<String, String>,
) -> Result<(), String> {
    let db_path = Path::new(runtime::database_path());
    let connections = network::list_all_connections_at(db_path)?;
    let mut next = Vec::new();

    for mut connection in connections {
        if let Some(tile_id) = pane_to_tile.get(&connection.from_tile_id) {
            connection.from_tile_id = tile_id.clone();
        } else if let Some(tile_id) = work_tile_map.get(&connection.from_tile_id) {
            connection.from_tile_id = tile_id.clone();
        }
        if let Some(tile_id) = pane_to_tile.get(&connection.to_tile_id) {
            connection.to_tile_id = tile_id.clone();
        } else if let Some(tile_id) = work_tile_map.get(&connection.to_tile_id) {
            connection.to_tile_id = tile_id.clone();
        }
        if connection.from_tile_id == connection.to_tile_id {
            continue;
        }
        next.push(connection);
    }

    next.sort_by(|left, right| {
        left.session_id
            .cmp(&right.session_id)
            .then_with(|| left.from_tile_id.cmp(&right.from_tile_id))
            .then_with(|| left.from_port.as_str().cmp(right.from_port.as_str()))
            .then_with(|| left.to_tile_id.cmp(&right.to_tile_id))
            .then_with(|| left.to_port.as_str().cmp(right.to_port.as_str()))
    });
    next.dedup_by(|left, right| {
        left.session_id == right.session_id
            && left.from_tile_id == right.from_tile_id
            && left.from_port == right.from_port
            && left.to_tile_id == right.to_tile_id
            && left.to_port == right.to_port
    });
    network::replace_connections_at(db_path, &next)
}

fn migrate_agents_to_tile_ids(
    state: &AppState,
    records: &[TileRecord],
    pane_to_tile: &std::collections::HashMap<String, String>,
    window_to_tile: &std::collections::HashMap<String, String>,
) -> Result<(), String> {
    let records_by_tile = records
        .iter()
        .cloned()
        .map(|record| (record.tile_id.clone(), record))
        .collect::<std::collections::HashMap<_, _>>();
    let mut next_agents = Vec::new();

    for mut agent in state.agent_infos_snapshot()? {
        let matched_record = if let Some(record) = records_by_tile.get(&agent.tile_id) {
            (record.kind == TileRecordKind::Agent).then_some(record.clone())
        } else if !agent.pane_id.trim().is_empty() {
            pane_to_tile
                .get(&agent.pane_id)
                .and_then(|tile_id| records_by_tile.get(tile_id))
                .filter(|record| record.kind == TileRecordKind::Agent)
                .cloned()
        } else if agent.tile_id.starts_with('%') {
            pane_to_tile
                .get(&agent.tile_id)
                .and_then(|tile_id| records_by_tile.get(tile_id))
                .filter(|record| record.kind == TileRecordKind::Agent)
                .cloned()
        } else {
            None
        }
        .or_else(|| {
            window_to_tile
                .get(&agent.window_id)
                .and_then(|tile_id| records_by_tile.get(tile_id))
                .filter(|record| record.kind == TileRecordKind::Agent)
                .cloned()
        });

        if let Some(record) = matched_record {
            agent.tile_id = record.tile_id.clone();
            agent.pane_id = record.pane_id.clone();
            agent.window_id = record.window_id.clone();
            agent.session_id = record.session_id.clone();
        } else if let Some(record) = records_by_tile.get(&agent.tile_id) {
            if record.kind != TileRecordKind::Agent && !agent.pane_id.trim().is_empty() {
                agent.tile_id = agent.pane_id.clone();
            }
        }
        next_agents.push(agent);
    }

    state.replace_agents_snapshot(next_agents)
}

pub fn reconcile_tmux_tile_registry(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let snapshot = tmux_state::snapshot(state.inner())?;
    let db_path = Path::new(runtime::database_path());
    let _ = work::ensure_tile_ids_at(db_path)?;
    let work_items = work::list_work_at(db_path, work::WorkListScope::All)?;
    let work_tile_map = work_items
        .iter()
        .map(|item| (format!("work:{}", item.work_id), item.tile_id.clone()))
        .collect::<std::collections::HashMap<_, _>>();
    let (records, pane_to_tile, window_to_tile) = reconciled_tmux_tile_records(state.inner(), &snapshot)?;
    state.replace_tile_records(records.clone())?;
    migrate_agents_to_tile_ids(state.inner(), &records, &pane_to_tile, &window_to_tile)?;
    migrate_network_connections_to_tile_ids(&pane_to_tile, &work_tile_map)?;
    migrate_layout_entries_to_tile_ids(state.inner(), &pane_to_tile, &window_to_tile, &work_tile_map);
    Ok(())
}

pub fn ensure_tmux_tile_record_for_backing(
    state: &AppState,
    session_id: &str,
    window_id: &str,
    pane_id: &str,
    kind: TileRecordKind,
    browser_incognito: bool,
    preferred_tile_id: Option<String>,
) -> Result<TileRecord, String> {
    let now_ms = now_ms();
    let existing = state
        .tile_record_by_window(window_id)?
        .or_else(|| state.tile_record_by_pane(pane_id).ok().flatten());
    let tile_id = match existing.as_ref() {
        Some(record) => record.tile_id.clone(),
        None => match preferred_tile_id {
            Some(tile_id) => tile_id,
            None => tile_registry::generate_unique_tile_id_at(Path::new(runtime::database_path()))?,
        },
    };
    state.upsert_tile_record(TileRecord {
        tile_id,
        session_id: session_id.to_string(),
        kind,
        window_id: window_id.to_string(),
        pane_id: pane_id.to_string(),
        browser_incognito: if kind == TileRecordKind::Browser {
            browser_incognito
        } else {
            false
        },
        created_at: existing.as_ref().map(|record| record.created_at).unwrap_or(now_ms),
        updated_at: now_ms,
    })
}

fn resolve_ui_network_tile_descriptor(
    state: &AppState,
    snapshot: &tmux_state::TmuxSnapshot,
    session_id: &str,
    tile_id: &str,
) -> Result<NetworkTileDescriptor, String> {
    if let Ok(item) = work::get_work_item_by_tile_id_at(Path::new(runtime::database_path()), tile_id) {
        if item.session_id != session_id {
            return Err(format!("tile {tile_id} is not in session {session_id}"));
        }
        return Ok(NetworkTileDescriptor {
            tile_id: tile_id.to_string(),
            session_id: session_id.to_string(),
            kind: NetworkTileKind::Work,
        });
    }

    let record = state
        .tile_record(tile_id)?
        .ok_or_else(|| format!("unknown tile: {tile_id}"))?;
    if record.session_id != session_id {
        return Err(format!("tile {tile_id} is not in session {session_id}"));
    }
    Ok(NetworkTileDescriptor {
        tile_id: tile_id.to_string(),
        session_id: session_id.to_string(),
        kind: pane_network_tile_kind(state, snapshot, &record.pane_id)?,
    })
}

fn touched_work_ids_from_connections(connections: &[NetworkConnection]) -> Vec<String> {
    let mut ids = std::collections::BTreeSet::new();
    for connection in connections {
        if let Ok(item) = work::get_work_item_by_tile_id_at(Path::new(runtime::database_path()), &connection.from_tile_id) {
            ids.insert(item.work_id);
        }
        if let Ok(item) = work::get_work_item_by_tile_id_at(Path::new(runtime::database_path()), &connection.to_tile_id) {
            ids.insert(item.work_id);
        }
    }
    ids.into_iter().collect()
}

fn emit_agent_debug_state(app: &tauri::AppHandle, state: &AppState) {
    let Ok(session_id) = active_or_last_session_id(state) else {
        return;
    };
    if let Ok(snapshot) = state.snapshot_agent_debug_state_for_session(&session_id) {
        let _ = app.emit("herd-agent-state", snapshot);
    }
}

fn emit_work_updated(app: &tauri::AppHandle, item: &work::WorkItem) {
    let _ = app.emit(
        "herd-work-updated",
        serde_json::json!({
            "session_id": item.session_id,
            "work_id": item.work_id,
        }),
    );
}

fn connection_event_message(connection: &NetworkConnection, connected: bool) -> String {
    let action = if connected { "connected" } else { "disconnected" };
    format!(
        "Port {action}: {}:{} <-> {}:{}",
        connection.from_tile_id,
        connection.from_port.as_str(),
        connection.to_tile_id,
        connection.to_port.as_str(),
    )
}

fn notify_agents_about_connection_change(
    state: &AppState,
    connection: &NetworkConnection,
    connected: bool,
) {
    let message = connection_event_message(connection, connected);
    for tile_id in [&connection.from_tile_id, &connection.to_tile_id] {
        let Ok(Some(agent)) = state.agent_info_by_tile(tile_id) else {
            continue;
        };
        if !agent.alive {
            continue;
        }
        let event = AgentChannelEvent {
            kind: AgentChannelEventKind::System,
            from_agent_id: None,
            from_display_name: "HERD".to_string(),
            to_agent_id: Some(agent.agent_id.clone()),
            to_display_name: Some(agent.display_name.clone()),
            message: message.clone(),
            channels: Vec::new(),
            mentions: Vec::new(),
            replay: false,
            ping_id: None,
            timestamp_ms: now_ms(),
        };
        if let Err(error) = state.send_event_to_agent(&agent.agent_id, event) {
            log::warn!(
                "Failed to deliver connection event to {} from Tauri command path: {error}",
                agent.agent_id
            );
        }
    }
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

fn default_shell_program() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
}

fn build_shell_launch_command(cwd: &str) -> String {
    format!(
        "cd {} || exit 1\nexec {}",
        shell_single_quote(cwd),
        shell_single_quote(&default_shell_program())
    )
}

fn agent_role_prompt_path(role: AgentRole) -> String {
    let role_dir = match role {
        AgentRole::Root => "root",
        AgentRole::Worker => "worker",
    };
    runtime::project_root_dir()
        .join(".claude/roles")
        .join(role_dir)
        .join("CLAUDE.md")
        .to_string_lossy()
        .to_string()
}

fn build_agent_launch_command(cwd: &str, pane_id: &str, server_name: &str, role: AgentRole) -> String {
    let mcp_config = runtime::project_mcp_config_path()
        .to_string_lossy()
        .to_string();
    let prompt_file = agent_role_prompt_path(role);
    let tmux_server = runtime::tmux_server_name().to_string();
    format!(
        "(sleep 1; tmux -f /dev/null -L {} send-keys -t {} Enter >/dev/null 2>&1) &\ncd {} || exit 1\nHERD_ROLE_CLAUDE_MD={}\n[ -f \"$HERD_ROLE_CLAUDE_MD\" ] || {{ echo \"Missing role prompt file: $HERD_ROLE_CLAUDE_MD\"; exit 1; }}\nexec claude --append-system-prompt \"$(cat \"$HERD_ROLE_CLAUDE_MD\")\" --mcp-config {} --teammate-mode tmux --dangerously-load-development-channels server:{}",
        shell_single_quote(&tmux_server),
        shell_single_quote(pane_id),
        shell_single_quote(cwd),
        shell_single_quote(&prompt_file),
        shell_single_quote(&mcp_config),
        server_name,
    )
}

fn build_claude_launch_command(cwd: &str, pane_id: &str) -> String {
    build_agent_launch_command(cwd, pane_id, "herd", AgentRole::Worker)
}

fn build_root_agent_launch_command(cwd: &str, pane_id: &str) -> String {
    build_agent_launch_command(cwd, pane_id, "herd", AgentRole::Root)
}

fn build_fixture_agent_launch_command(cwd: &str) -> String {
    format!(
        "cd {} || exit 1\nprintf '__HERD_FIXTURE_AGENT__\\n'\nexec tail -f /dev/null",
        shell_single_quote(cwd),
    )
}

fn default_runtime_agent_type() -> AgentType {
    if runtime::fixture_agents_enabled() {
        AgentType::Fixture
    } else {
        AgentType::Claude
    }
}

fn build_role_agent_launch_command(cwd: &str, pane_id: &str, role: AgentRole, agent_type: AgentType) -> String {
    match agent_type {
        AgentType::Claude => match role {
            AgentRole::Root => build_root_agent_launch_command(cwd, pane_id),
            AgentRole::Worker => build_claude_launch_command(cwd, pane_id),
        },
        AgentType::Fixture => build_fixture_agent_launch_command(cwd),
    }
}

fn root_agent_id(session_id: &str) -> String {
    format!("root:{session_id}")
}

pub fn respawn_root_agent_in_pane(
    app: tauri::AppHandle,
    session_id: String,
    window_id: String,
    pane_id: String,
    agent_type: AgentType,
) -> Result<serde_json::Value, String> {
    launch_agent_in_pane(
        app,
        session_id.clone(),
        window_id,
        pane_id,
        root_agent_id(&session_id),
        "Root",
        AgentRole::Root,
        agent_type,
    )
}

fn launch_agent_in_pane(
    app: tauri::AppHandle,
    session_id: String,
    window_id: String,
    pane_id: String,
    agent_id: String,
    title: &str,
    role: AgentRole,
    agent_type: AgentType,
) -> Result<serde_json::Value, String> {
    let state = app.state::<AppState>();
    let tile = ensure_tmux_tile_record_for_backing(
        state.inner(),
        &session_id,
        &window_id,
        &pane_id,
        TileRecordKind::Agent,
        false,
        None,
    )?;
    let cwd = tmux_state::ensure_session_root_cwd(&session_id)?;
    let shell_command = build_role_agent_launch_command(&cwd, &pane_id, role, agent_type);

    tmux::output(&[
        "respawn-pane",
        "-k",
        "-t",
        &pane_id,
        "-e",
        &format!("HERD_SOCK={}", runtime::socket_path()),
        "-e",
        &format!("HERD_AGENT_ID={agent_id}"),
        "-e",
        &format!("HERD_AGENT_ROLE={}", match role {
            AgentRole::Root => "root",
            AgentRole::Worker => "worker",
        }),
        "-e",
        &format!("HERD_TILE_ID={}", tile.tile_id),
        "-e",
        &format!("HERD_PANE_ID={pane_id}"),
        "-e",
        &format!("HERD_SESSION_ID={session_id}"),
        "/bin/bash",
        "-lc",
        &shell_command,
    ])
    .map_err(|error| format!("tmux respawn-pane failed: {error}"))
    .and_then(|output| {
        if output.status.success() {
            Ok(())
        } else {
            Err(format!(
                "tmux respawn-pane failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ))
        }
    })?;

    let _ = set_pane_title(app.clone(), pane_id.clone(), title.to_string());
    let _ = app.emit(
        "shell-role",
        serde_json::json!({
            "session_id": pane_id,
            "role": match role {
                AgentRole::Root => "root_agent",
                AgentRole::Worker => "claude",
            },
        }),
    );
    let _ = tmux_state::emit_snapshot(&app);

    if agent_type == AgentType::Fixture {
        let agent_pid = crate::tmux_state::pane_pid(&pane_id).ok().flatten();
        state.upsert_agent(
            agent_id.clone(),
            tile.tile_id.clone(),
            pane_id.clone(),
            window_id.clone(),
            session_id.clone(),
            title.to_string(),
            agent_type,
            role,
            agent_pid,
        )?;
        if let Ok(snapshot) = state.snapshot_agent_debug_state_for_session(&session_id) {
            let _ = app.emit("herd-agent-state", snapshot);
        }
    }

    Ok(serde_json::json!({
        "agent_id": agent_id,
        "tile_id": tile.tile_id,
        "agent_type": agent_type,
        "agent_role": match role {
            AgentRole::Root => "root",
            AgentRole::Worker => "worker",
        },
        "pane_id": pane_id,
        "window_id": window_id,
        "session_id": session_id,
        "cwd": cwd,
    }))
}

fn session_primary_window_and_pane(
    snapshot: &tmux_state::TmuxSnapshot,
    session_id: &str,
) -> Result<(String, String), String> {
    let window_id = active_window_id_for_session(snapshot, session_id)?;
    let pane_id = active_pane_id_for_window(snapshot, &window_id)?;
    Ok((window_id, pane_id))
}

fn recorded_root_target_in_snapshot(
    snapshot: &tmux_state::TmuxSnapshot,
    info: &crate::agent::AgentInfo,
) -> Option<(String, String)> {
    let pane_exists = snapshot
        .panes
        .iter()
        .any(|pane| pane.id == info.pane_id && pane.session_id == info.session_id && pane.window_id == info.window_id);
    let window_exists = snapshot
        .windows
        .iter()
        .any(|window| window.id == info.window_id && window.session_id == info.session_id);
    if pane_exists && window_exists {
        return Some((info.window_id.clone(), info.pane_id.clone()));
    }
    None
}

fn reusable_root_target_in_snapshot(
    snapshot: &tmux_state::TmuxSnapshot,
    info: &crate::agent::AgentInfo,
    session_agents: &[crate::agent::AgentInfo],
) -> Option<(String, String)> {
    let target = recorded_root_target_in_snapshot(snapshot, info)?;
    let occupied_by_other_live_agent = session_agents.iter().any(|agent| {
        agent.pane_id == info.pane_id && agent.agent_id != info.agent_id && agent.alive
    });
    if occupied_by_other_live_agent {
        return None;
    }
    Some(target)
}

fn duplicate_root_pane_ids_for_session(
    snapshot: &tmux_state::TmuxSnapshot,
    session_id: &str,
    keep_pane_id: &str,
) -> Vec<String> {
    snapshot
        .panes
        .iter()
        .filter(|pane| pane.session_id == session_id && pane.id != keep_pane_id && pane.title.trim() == "Root")
        .map(|pane| pane.id.clone())
        .collect()
}

fn prune_duplicate_root_panes(
    app: &tauri::AppHandle,
    session_id: &str,
    keep_pane_id: &str,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let snapshot = tmux_state::snapshot(state.inner())?;
    let duplicate_pane_ids = duplicate_root_pane_ids_for_session(&snapshot, session_id, keep_pane_id);
    if duplicate_pane_ids.is_empty() {
        return Ok(());
    }
    for pane_id in duplicate_pane_ids {
        if let Err(error) = tmux_state::kill_pane(&pane_id) {
            log::warn!("Failed to prune duplicate root pane {pane_id} in session {session_id}: {error}");
        }
    }
    let _ = tmux_state::emit_snapshot(app);
    Ok(())
}

pub fn create_session_with_root_agent(
    app: tauri::AppHandle,
    name: Option<&str>,
) -> Result<String, String> {
    let session_id = tmux_state::create_session(name)?;
    let _ = ensure_root_agent_for_session(app, session_id.clone(), true)?;
    Ok(session_id)
}

pub fn ensure_root_agent_for_session(
    app: tauri::AppHandle,
    session_id: String,
    reuse_primary_pane: bool,
) -> Result<serde_json::Value, String> {
    let state = app.state::<AppState>();
    let before = tmux_state::snapshot(state.inner())?;
    let session_agents = state.list_agents_in_session(&session_id)?;
    if let Some(info) = state.root_agent_in_session(&session_id)? {
        if info.alive && reusable_root_target_in_snapshot(&before, &info, &session_agents).is_some() {
            let _ = prune_duplicate_root_panes(&app, &session_id, &info.pane_id);
            return Ok(serde_json::json!({
                "agent_id": info.agent_id,
                "agent_type": info.agent_type,
                "agent_role": "root",
                "tile_id": info.tile_id,
                "pane_id": info.pane_id,
                "window_id": info.window_id,
                "session_id": info.session_id,
            }));
        }
    }
    if let Some(info) = state.root_agent_in_session(&session_id)? {
        if let Some((window_id, pane_id)) =
            reusable_root_target_in_snapshot(&before, &info, &session_agents)
        {
            let launched = respawn_root_agent_in_pane(
                app.clone(),
                session_id.clone(),
                window_id,
                pane_id.clone(),
                info.agent_type,
            )?;
            let _ = prune_duplicate_root_panes(&app, &session_id, &pane_id);
            return Ok(launched);
        }
    }
    let (window_id, pane_id) = if reuse_primary_pane {
        session_primary_window_and_pane(&before, &session_id)?
    } else {
        let window_id = new_window_detached(app.clone(), Some(session_id.clone()))?;
        let after = tmux_state::snapshot(state.inner())?;
        let pane_id = after
            .windows
            .iter()
            .find(|window| window.id == window_id)
            .and_then(|window| window.pane_ids.first().cloned())
            .ok_or("tmux did not report a pane for the new Root window".to_string())?;
        (window_id, pane_id)
    };

    let keep_pane_id = pane_id.clone();
    let launched = launch_agent_in_pane(
        app.clone(),
        session_id.clone(),
        window_id,
        pane_id,
        root_agent_id(&session_id),
        "Root",
        AgentRole::Root,
        default_runtime_agent_type(),
    )?;
    let _ = prune_duplicate_root_panes(&app, &session_id, &keep_pane_id);
    Ok(launched)
}

pub fn repair_root_agent(
    app: tauri::AppHandle,
    info: &crate::agent::AgentInfo,
) -> Result<serde_json::Value, String> {
    let state = app.state::<AppState>();
    let snapshot = tmux_state::snapshot(state.inner())?;
    let session_agents = state.list_agents_in_session(&info.session_id)?;
    if let Some((window_id, pane_id)) =
        reusable_root_target_in_snapshot(&snapshot, info, &session_agents)
    {
        return respawn_root_agent_in_pane(
            app,
            info.session_id.clone(),
            window_id,
            pane_id,
            info.agent_type,
        );
    }

    ensure_root_agent_for_session(app, info.session_id.clone(), false)
}

fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
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
    let mut snapshot = tmux_state::snapshot(&state)?;
    let tile_records = state.tile_records_snapshot()?;
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
    }
    Ok(snapshot)
}

#[tauri::command]
pub fn get_layout_state(
    state: tauri::State<'_, AppState>,
) -> Result<std::collections::HashMap<String, TileState>, String> {
    let states = state.tile_states.lock().map_err(|e| e.to_string())?;
    Ok(states.clone())
}

#[tauri::command]
pub fn get_agent_debug_state(state: tauri::State<'_, AppState>) -> Result<AgentDebugState, String> {
    let snapshot = tmux_state::snapshot(&state)?;
    let session_id = active_session_id(&snapshot)?;
    state.snapshot_agent_debug_state_for_session(&session_id)
}

#[tauri::command]
pub fn get_work_items(
    state: tauri::State<'_, AppState>,
    session_id: Option<String>,
) -> Result<Vec<work::WorkItem>, String> {
    let resolved_session_id = if let Some(session_id) = session_id.filter(|value| !value.trim().is_empty()) {
        session_id
    } else {
        active_session_id(&tmux_state::snapshot(&state)?)?
    };
    work::list_work_at(
        Path::new(runtime::database_path()),
        work::WorkListScope::CurrentSession(resolved_session_id),
    )
}

#[tauri::command]
pub fn send_root_message_command(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    message: String,
) -> Result<(), String> {
    crate::socket::server::send_root_message_as_user(state.inner(), &app, message)
}

#[tauri::command]
pub fn send_direct_message_command(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    target: String,
    message: String,
) -> Result<(), String> {
    crate::socket::server::send_direct_message_as_user(state.inner(), &app, target, message)
}

#[tauri::command]
pub fn send_public_message_command(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    message: String,
) -> Result<(), String> {
    crate::socket::server::send_public_message_as_user(state.inner(), &app, message)
}

#[tauri::command]
pub fn create_work_item(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    title: String,
    session_id: Option<String>,
) -> Result<work::WorkItem, String> {
    let resolved_session_id = if let Some(session_id) = session_id.filter(|value| !value.trim().is_empty()) {
        session_id
    } else {
        active_session_id(&tmux_state::snapshot(&state)?)?
    };
    let item = work::create_work_item_at(
        Path::new(runtime::database_path()),
        &resolved_session_id,
        &title,
    )?;
    let _ = state.touch_channels_in_session(&item.session_id, std::slice::from_ref(&item.topic));
    emit_agent_debug_state(&app, &state);
    emit_work_updated(&app, &item);
    Ok(item)
}

#[tauri::command]
pub fn delete_work_item(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    work_id: String,
) -> Result<(), String> {
    let item = work::get_work_item_at(Path::new(runtime::database_path()), &work_id)?;
    let removed_connections = network::disconnect_all_for_tile_at(
        Path::new(runtime::database_path()),
        &item.session_id,
        &item.tile_id,
    )
    .unwrap_or_default();
    work::delete_work_item_at(
        Path::new(runtime::database_path()),
        &work_id,
    )?;
    for connection in &removed_connections {
        notify_agents_about_connection_change(state.inner(), connection, false);
    }
    state.remove_tile_state(&item.tile_id);
    state.save();
    emit_agent_debug_state(&app, &state);
    emit_work_updated(&app, &item);
    Ok(())
}

#[tauri::command]
pub fn approve_work_item(app: tauri::AppHandle, work_id: String) -> Result<work::WorkItem, String> {
    let item = work::approve_work_stage_at(Path::new(runtime::database_path()), &work_id)?;
    emit_work_updated(&app, &item);
    Ok(item)
}

#[tauri::command]
pub fn improve_work_item(
    app: tauri::AppHandle,
    work_id: String,
    comment: String,
) -> Result<work::WorkItem, String> {
    let item = work::improve_work_stage_at(Path::new(runtime::database_path()), &work_id, &comment)?;
    emit_work_updated(&app, &item);
    Ok(item)
}

#[tauri::command]
pub fn read_work_stage_preview(work_id: String) -> Result<String, String> {
    work::read_current_stage_preview_at(Path::new(runtime::database_path()), &work_id)
}

#[tauri::command]
pub fn connect_network_tiles(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    from_tile_id: String,
    from_port: String,
    to_tile_id: String,
    to_port: String,
) -> Result<network::NetworkConnection, String> {
    let snapshot = tmux_state::snapshot(&state)?;
    let session_id = active_session_id(&snapshot)?;
    let from = resolve_ui_network_tile_descriptor(state.inner(), &snapshot, &session_id, &from_tile_id)?;
    let to = resolve_ui_network_tile_descriptor(state.inner(), &snapshot, &session_id, &to_tile_id)?;
    let from_port = network::parse_port(&from_port).map_err(|_| "invalid from_port".to_string())?;
    let to_port = network::parse_port(&to_port).map_err(|_| "invalid to_port".to_string())?;
    let connection = network::connect_at(Path::new(runtime::database_path()), &from, from_port, &to, to_port)?;
    notify_agents_about_connection_change(state.inner(), &connection, true);
    emit_agent_debug_state(&app, &state);
    for work_id in touched_work_ids_from_connections(std::slice::from_ref(&connection)) {
        if let Ok(item) = work::get_work_item_at(Path::new(runtime::database_path()), &work_id) {
            emit_work_updated(&app, &item);
        }
    }
    Ok(connection)
}

#[tauri::command]
pub fn disconnect_network_port(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    tile_id: String,
    port: String,
) -> Result<Option<network::NetworkConnection>, String> {
    let snapshot = tmux_state::snapshot(&state)?;
    let session_id = active_session_id(&snapshot)?;
    let descriptor = resolve_ui_network_tile_descriptor(state.inner(), &snapshot, &session_id, &tile_id)?;
    let port = network::parse_port(&port).map_err(|_| "invalid port".to_string())?;
    let removed = network::disconnect_at(Path::new(runtime::database_path()), &descriptor.session_id, &descriptor.tile_id, port)?;
    if let Some(connection) = removed.as_ref() {
        notify_agents_about_connection_change(state.inner(), connection, false);
    }
    emit_agent_debug_state(&app, &state);
    if let Some(connection) = removed.as_ref() {
        for work_id in touched_work_ids_from_connections(std::slice::from_ref(connection)) {
            if let Ok(item) = work::get_work_item_at(Path::new(runtime::database_path()), &work_id) {
                emit_work_updated(&app, &item);
            }
        }
    }
    Ok(removed)
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
    let session_id = create_session_with_root_agent(app.clone(), name.as_deref())?;
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
        Some(create_session_with_root_agent(app.clone(), Some(runtime::session_name()))?)
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

    for pane_id in snapshot
        .panes
        .iter()
        .filter(|pane| pane.session_id == session_id)
        .map(|pane| pane.id.as_str())
    {
        browser::close_browser_webview(&app, pane_id);
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
pub fn set_session_root_cwd(
    app: tauri::AppHandle,
    session_id: String,
    cwd: String,
) -> Result<String, String> {
    let trimmed = cwd.trim();
    if trimmed.is_empty() {
        return Err("spawn directory cannot be empty".to_string());
    }

    let requested = PathBuf::from(trimmed);
    let absolute = if requested.is_absolute() {
        requested
    } else {
        runtime::project_root_dir().join(requested)
    };
    let canonical = fs::canonicalize(&absolute)
        .map_err(|error| format!("failed to resolve spawn directory {}: {error}", absolute.display()))?;
    if !canonical.is_dir() {
        return Err(format!("spawn directory is not a directory: {}", canonical.display()));
    }
    let normalized = canonical.to_string_lossy().to_string();

    tmux_state::set_session_root_cwd(&session_id, &normalized)?;
    tmux_state::emit_snapshot(&app)?;
    Ok(normalized)
}

fn new_backing_window_internal(
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
    let cwd = tmux_state::ensure_session_root_cwd(&session_id)?;

    tmux_state::respawn_pane_shell_command(&pane_id, &build_shell_launch_command(&cwd), None)?;

    if select_new_window {
        tmux_state::select_window(&window_id)?;
    }
    tmux_state::emit_snapshot(&app)?;
    Ok(window_id)
}

fn new_shell_window_internal(
    app: tauri::AppHandle,
    target_session_id: Option<String>,
    select_new_window: bool,
) -> Result<ShellWindowSpawn, String> {
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
    let cwd = tmux_state::ensure_session_root_cwd(&session_id)?;
    let tile = ensure_tmux_tile_record_for_backing(
        state.inner(),
        &session_id,
        &window_id,
        &pane_id,
        TileRecordKind::Shell,
        false,
        None,
    )?;

    tmux_state::respawn_pane_shell_command(&pane_id, &build_shell_launch_command(&cwd), Some(&tile.tile_id))?;

    if select_new_window {
        tmux_state::select_window(&window_id)?;
    }
    tmux_state::emit_snapshot(&app)?;
    Ok(ShellWindowSpawn {
        tile_id: tile.tile_id,
        pane_id,
        window_id,
        session_id,
    })
}

#[tauri::command]
pub fn new_window(app: tauri::AppHandle, target_session_id: Option<String>) -> Result<String, String> {
    Ok(new_shell_window_internal(app, target_session_id, true)?.window_id)
}

pub fn new_window_detached(app: tauri::AppHandle, target_session_id: Option<String>) -> Result<String, String> {
    new_backing_window_internal(app, target_session_id, false)
}

pub fn new_shell_window_detached(
    app: tauri::AppHandle,
    target_session_id: Option<String>,
) -> Result<ShellWindowSpawn, String> {
    new_shell_window_internal(app, target_session_id, false)
}

#[tauri::command]
pub fn spawn_agent_window(
    app: tauri::AppHandle,
    target_session_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let state = app.state::<AppState>();
    let before = tmux_state::snapshot(state.inner())?;
    let session_id = target_session_id.unwrap_or(active_session_id(&before)?);
    let window_id = new_window_detached(app.clone(), Some(session_id.clone()))?;
    let after = tmux_state::snapshot(state.inner())?;
    let pane_id = after
        .windows
        .iter()
        .find(|window| window.id == window_id)
        .and_then(|window| window.pane_ids.first().cloned())
        .ok_or("tmux did not report a pane for the new Agent window".to_string())?;

    let agent_id = uuid::Uuid::new_v4().to_string();
    launch_agent_in_pane(
        app,
        session_id,
        window_id,
        pane_id,
        agent_id,
        "Agent",
        AgentRole::Worker,
        default_runtime_agent_type(),
    )
}

fn spawn_browser_window_internal(
    app: tauri::AppHandle,
    target_session_id: Option<String>,
    browser_incognito: bool,
    browser_path: Option<String>,
) -> Result<BrowserWindowSpawn, String> {
    let state = app.state::<AppState>();
    let before = tmux_state::snapshot(state.inner())?;
    let session_id = target_session_id.unwrap_or(active_session_id(&before)?);
    let window_id = new_window_detached(app.clone(), Some(session_id.clone()))?;
    let after = tmux_state::snapshot(state.inner())?;
    let pane_id = after
        .windows
        .iter()
        .find(|window| window.id == window_id)
        .and_then(|window| window.pane_ids.first().cloned())
        .ok_or("tmux did not report a pane for the new Browser window".to_string())?;

    let cwd = tmux_state::ensure_session_root_cwd(&session_id)?;
    tmux_state::respawn_pane_shell_command(&pane_id, &build_shell_launch_command(&cwd), None)?;
    let _ = tmux_state::rename_window(&window_id, "Browser");
    let _ = set_pane_title(app.clone(), pane_id.clone(), "Browser".to_string());
    let tile = ensure_tmux_tile_record_for_backing(
        state.inner(),
        &session_id,
        &window_id,
        &pane_id,
        TileRecordKind::Browser,
        browser_incognito,
        None,
    )?;
    let _ = app.emit(
        "shell-role",
        serde_json::json!({
            "session_id": pane_id,
            "role": "browser",
        }),
    );
    if let Some(path) = browser_path.as_ref() {
        if let Err(error) = browser::load_browser_webview(&app, &pane_id, path) {
            let cleanup_error = kill_window(app.clone(), window_id.clone()).err();
            return match cleanup_error {
                Some(cleanup_error) => Err(format!(
                    "failed to load browser path {path}: {error}; cleanup also failed for window {window_id}: {cleanup_error}"
                )),
                None => Err(format!("failed to load browser path {path}: {error}")),
            };
        }
    }
    let _ = tmux_state::emit_snapshot(&app);

    Ok(BrowserWindowSpawn {
        tile_id: tile.tile_id,
        pane_id,
        window_id,
        session_id,
    })
}

pub fn spawn_browser_window_with_pane(
    app: tauri::AppHandle,
    target_session_id: Option<String>,
    browser_incognito: bool,
    browser_path: Option<String>,
) -> Result<BrowserWindowSpawn, String> {
    spawn_browser_window_internal(app, target_session_id, browser_incognito, browser_path)
}

#[tauri::command]
pub fn spawn_browser_window(
    app: tauri::AppHandle,
    target_session_id: Option<String>,
    browser_incognito: Option<bool>,
    browser_path: Option<String>,
) -> Result<String, String> {
    Ok(
        spawn_browser_window_internal(
            app,
            target_session_id,
            browser_incognito.unwrap_or(false),
            browser_path,
        )?
        .window_id,
    )
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
    Ok(new_shell_window_internal(app, Some(session_id), true)?.window_id)
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
    let agents = state.list_agents_in_session(&window.session_id)?;
    let root_agent = window
        .pane_ids
        .iter()
        .find_map(|pane_id| {
            agents
                .iter()
                .find(|agent| agent.agent_role == AgentRole::Root && agent.pane_id == *pane_id)
                .cloned()
        });
    if let Some(root_agent) = root_agent {
        let restarted = respawn_root_agent_in_pane(
            app.clone(),
            root_agent.session_id.clone(),
            root_agent.window_id.clone(),
            root_agent.pane_id.clone(),
            root_agent.agent_type,
        )?;
        let _ = tmux_state::emit_snapshot(&app);
        let _ = prune_duplicate_root_panes(&app, &root_agent.session_id, &root_agent.tile_id);
        let _ = restarted;
        return Ok(());
    }
    let session = snapshot
        .sessions
        .iter()
        .find(|session| session.id == window.session_id)
        .cloned()
        .ok_or_else(|| format!("No tmux session found for {}", window.session_id))?;

    if session.window_ids.len() <= 1 {
        for pane_id in &window.pane_ids {
            browser::close_browser_webview(&app, pane_id);
        }
        if matches!(state.tile_record_by_window(&window_id)?, Some(record) if record.kind == TileRecordKind::Shell) {
            let pane_id = window
                .pane_ids
                .first()
                .cloned()
                .ok_or_else(|| format!("No tmux pane found for window {window_id}"))?;
            let tile = ensure_tmux_tile_record_for_backing(
                state.inner(),
                &window.session_id,
                &window_id,
                &pane_id,
                TileRecordKind::Shell,
                false,
                None,
            )?;
            let cwd = tmux_state::ensure_session_root_cwd(&window.session_id)?;
            tmux_state::respawn_pane_shell_command(&pane_id, &build_shell_launch_command(&cwd), Some(&tile.tile_id))?;
        } else {
            tmux_state::respawn_window(&window_id)?;
        }
        tmux_state::emit_snapshot(&app)?;
        return Ok(());
    }

    for pane_id in &window.pane_ids {
        browser::close_browser_webview(&app, pane_id);
    }
    tmux_state::kill_window(&window_id)?;
    tmux_state::emit_snapshot(&app)?;
    Ok(())
}

#[tauri::command]
pub fn kill_pane(app: tauri::AppHandle, pane_id: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    let snapshot = tmux_state::snapshot(state.inner())?;
    let pane = snapshot
        .panes
        .iter()
        .find(|pane| pane.id == pane_id)
        .cloned()
        .ok_or_else(|| format!("No tmux pane found for {pane_id}"))?;
    kill_window(app, pane.window_id)
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
    Ok(new_shell_window_internal(app, None, true)?.pane_id)
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

fn truncate_log_file(path: &str) -> Result<(), String> {
    use std::fs::OpenOptions;
    match OpenOptions::new().create(true).write(true).truncate(true).open(path) {
        Ok(_) => Ok(()),
        Err(error) => Err(format!("failed to truncate {path}: {error}")),
    }
}

#[tauri::command]
pub fn clear_debug_logs(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    state.clear_debug_logs()?;
    truncate_log_file(runtime::socket_log_path())?;
    truncate_log_file(runtime::cc_log_path())?;
    if let Some(session_id) = state.last_active_session() {
        if let Ok(snapshot) = state.snapshot_agent_debug_state_for_session(&session_id) {
            let _ = app.emit("herd-agent-state", snapshot);
        }
    }
    Ok(())
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
        build_claude_launch_command,
        build_fixture_agent_launch_command,
        build_root_agent_launch_command,
        build_shell_launch_command,
        control_client_tty_from_output,
        duplicate_root_pane_ids_for_session,
        enrich_claude_commands,
        recorded_root_target_in_snapshot,
        reusable_root_target_in_snapshot,
        tmux_control_client_alive,
    };
    use crate::agent::{AgentInfo, AgentRole, AgentType};
    use crate::tmux_state::{TmuxPane, TmuxSession, TmuxSnapshot, TmuxWindow};
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

    fn sample_snapshot() -> TmuxSnapshot {
        TmuxSnapshot {
            version: 1,
            server_name: "herd".to_string(),
            active_session_id: Some("$1".to_string()),
            active_window_id: Some("@1".to_string()),
            active_pane_id: Some("%1".to_string()),
            sessions: vec![TmuxSession {
                id: "$1".to_string(),
                name: "Main".to_string(),
                active: true,
                window_ids: vec!["@1".to_string(), "@2".to_string()],
                active_window_id: Some("@1".to_string()),
                root_cwd: Some("/tmp/herd".to_string()),
            }],
            windows: vec![
                TmuxWindow {
                    id: "@1".to_string(),
                    tile_id: None,
                    session_id: "$1".to_string(),
                    session_name: "Main".to_string(),
                    index: 0,
                    name: "Root".to_string(),
                    active: true,
                    cols: 80,
                    rows: 24,
                    pane_ids: vec!["%1".to_string()],
                    parent_window_id: None,
                    parent_window_source: None,
                },
                TmuxWindow {
                    id: "@2".to_string(),
                    tile_id: None,
                    session_id: "$1".to_string(),
                    session_name: "Main".to_string(),
                    index: 1,
                    name: "Root".to_string(),
                    active: false,
                    cols: 80,
                    rows: 24,
                    pane_ids: vec!["%2".to_string()],
                    parent_window_id: None,
                    parent_window_source: None,
                },
            ],
            panes: vec![
                TmuxPane {
                    id: "%1".to_string(),
                    tile_id: None,
                    role: None,
                    session_id: "$1".to_string(),
                    window_id: "@1".to_string(),
                    window_index: 0,
                    pane_index: 0,
                    cols: 80,
                    rows: 24,
                    title: "Root".to_string(),
                    command: "bash".to_string(),
                    active: true,
                    dead: false,
                },
                TmuxPane {
                    id: "%2".to_string(),
                    tile_id: None,
                    role: None,
                    session_id: "$1".to_string(),
                    window_id: "@2".to_string(),
                    window_index: 1,
                    pane_index: 0,
                    cols: 80,
                    rows: 24,
                    title: "Root".to_string(),
                    command: "bash".to_string(),
                    active: false,
                    dead: false,
                },
            ],
        }
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
    fn reuses_a_recorded_root_pane_when_it_still_exists_in_tmux() {
        let snapshot = sample_snapshot();
        let info = AgentInfo {
            agent_id: "root:$1".to_string(),
            agent_type: AgentType::Claude,
            agent_role: AgentRole::Root,
            tile_id: "AbCdEf".to_string(),
            pane_id: "%1".to_string(),
            window_id: "@1".to_string(),
            session_id: "$1".to_string(),
            title: "Root".to_string(),
            display_name: "Root".to_string(),
            alive: false,
            chatter_subscribed: true,
            channels: Vec::new(),
            agent_pid: None,
        };

        assert_eq!(
            recorded_root_target_in_snapshot(&snapshot, &info),
            Some(("@1".to_string(), "%1".to_string()))
        );
    }

    #[test]
    fn identifies_duplicate_root_panes_to_prune_within_a_session() {
        let snapshot = sample_snapshot();
        assert_eq!(
            duplicate_root_pane_ids_for_session(&snapshot, "$1", "%1"),
            vec!["%2".to_string()]
        );
    }

    #[test]
    fn does_not_reuse_a_recorded_root_pane_when_a_live_worker_occupies_it() {
        let snapshot = sample_snapshot();
        let root = AgentInfo {
            agent_id: "root:$1".to_string(),
            agent_type: AgentType::Claude,
            agent_role: AgentRole::Root,
            tile_id: "AbCdEf".to_string(),
            pane_id: "%1".to_string(),
            window_id: "@1".to_string(),
            session_id: "$1".to_string(),
            title: "Root".to_string(),
            display_name: "Root".to_string(),
            alive: false,
            chatter_subscribed: true,
            channels: Vec::new(),
            agent_pid: None,
        };
        let worker = AgentInfo {
            agent_id: "worker-1".to_string(),
            agent_type: AgentType::Claude,
            agent_role: AgentRole::Worker,
            tile_id: "GhIjKl".to_string(),
            pane_id: "%1".to_string(),
            window_id: "@1".to_string(),
            session_id: "$1".to_string(),
            title: "Agent".to_string(),
            display_name: "Agent 1".to_string(),
            alive: true,
            chatter_subscribed: true,
            channels: Vec::new(),
            agent_pid: None,
        };

        assert_eq!(
            reusable_root_target_in_snapshot(&snapshot, &root, &[root.clone(), worker]),
            None
        );
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

    #[test]
    fn shell_launch_command_starts_in_the_requested_directory() {
        let command = build_shell_launch_command("/tmp/herd-shell");
        assert!(command.contains("cd '/tmp/herd-shell' || exit 1"));
        assert!(command.contains("exec "));
    }

    #[test]
    fn worker_agent_launch_command_uses_worker_mcp_server() {
        let command = build_claude_launch_command("/tmp/herd-claude", "%12");
        assert!(command.contains("cd '/tmp/herd-claude' || exit 1"));
        assert!(command.contains("HERD_ROLE_CLAUDE_MD="));
        assert!(command.contains(".claude/roles/worker/CLAUDE.md"));
        assert!(command.contains("--append-system-prompt \"$(cat \"$HERD_ROLE_CLAUDE_MD\")\""));
        assert!(command.contains("--mcp-config "));
        assert!(command.contains("send-keys -t '%12' Enter"));
        assert!(command.contains("--dangerously-load-development-channels server:herd"));
        assert!(!command.contains("--channels server:herd"));
    }

    #[test]
    fn root_agent_launch_command_uses_root_mcp_server() {
        let command = build_root_agent_launch_command("/tmp/herd-root", "%21");
        assert!(command.contains("cd '/tmp/herd-root' || exit 1"));
        assert!(command.contains("HERD_ROLE_CLAUDE_MD="));
        assert!(command.contains(".claude/roles/root/CLAUDE.md"));
        assert!(command.contains("--append-system-prompt \"$(cat \"$HERD_ROLE_CLAUDE_MD\")\""));
        assert!(command.contains("--mcp-config "));
        assert!(command.contains("send-keys -t '%21' Enter"));
        assert!(command.contains("--dangerously-load-development-channels server:herd"));
        assert!(!command.contains("--dangerously-load-development-channels server:herd-root"));
    }

    #[test]
    fn fixture_agent_launch_command_never_mentions_claude() {
        let command = build_fixture_agent_launch_command("/tmp/herd-fixture");
        assert!(command.contains("cd '/tmp/herd-fixture' || exit 1"));
        assert!(command.contains("__HERD_FIXTURE_AGENT__"));
        assert!(command.contains("exec tail -f /dev/null"));
        assert!(!command.contains("claude"));
        assert!(!command.contains("--mcp-config"));
    }

    #[test]
    fn role_prompts_reference_role_specific_herd_skills() {
        let project_root = crate::runtime::project_root_dir();
        let root_prompt = fs::read_to_string(project_root.join(".claude/roles/root/CLAUDE.md")).unwrap();
        let worker_prompt = fs::read_to_string(project_root.join(".claude/roles/worker/CLAUDE.md")).unwrap();

        assert!(root_prompt.contains("/herd-root"));
        assert!(!root_prompt.contains("/herd-worker"));
        assert!(worker_prompt.contains("/herd-worker"));
        assert!(!worker_prompt.contains("/herd-root"));
    }

    #[test]
    fn role_specific_herd_skills_describe_their_mcp_surfaces() {
        let project_root = crate::runtime::project_root_dir();
        let root_skill = fs::read_to_string(project_root.join(".claude/skills/herd-root/SKILL.md")).unwrap();
        let worker_skill = fs::read_to_string(project_root.join(".claude/skills/herd-worker/SKILL.md")).unwrap();

        assert!(root_skill.contains("tile_create"));
        assert!(root_skill.contains("browser_drive"));
        assert!(root_skill.contains("network_connect"));
        assert!(worker_skill.contains("network_call"));
        assert!(worker_skill.contains("message_root"));
        assert!(worker_skill.contains("Do not use `tile_call`"));
        assert!(worker_skill.contains("Do not use `browser_drive`"));
    }
}
