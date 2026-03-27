use crate::{
    agent::{
        AgentRole,
        AgentType,
        TileSubscriptionDirection,
        TileSubscriptionRecord,
        TileSubscriptionScope,
    },
    browser::{self, BrowserBackend},
    commands,
    network::{self, NetworkConnection, TilePort, TilePortSetting},
    persist::TileState,
    runtime,
    state::AppState,
    tile_registry::TileRecordKind,
    tmux_state,
    work::{self, ImportedWorkItem, WorkReviewEntry, WorkStage, WorkStageState},
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const DEFAULT_TILE_WIDTH: f64 = 640.0;
const DEFAULT_TILE_HEIGHT: f64 = 400.0;
const DEFAULT_WORK_WIDTH: f64 = 360.0;
const DEFAULT_WORK_HEIGHT: f64 = 320.0;
const SAVED_SESSION_VERSION: u32 = 1;

fn default_saved_session_browser_backend() -> BrowserBackend {
    BrowserBackend::LiveWebview
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SavedSessionTileKind {
    RootAgent,
    Agent,
    Shell,
    Browser,
    Work,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SavedBrowserTile {
    #[serde(default)]
    pub incognito: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub load_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub navigate_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SavedWorkTile {
    pub title: String,
    pub topic: String,
    pub current_stage: WorkStage,
    pub stages: Vec<WorkStageState>,
    pub reviews: Vec<WorkReviewEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_node_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SavedSessionTile {
    pub node_id: String,
    pub kind: SavedSessionTileKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub layout: TileState,
    #[serde(default)]
    pub minimized: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<AgentType>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub browser: Option<SavedBrowserTile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub work: Option<SavedWorkTile>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SavedSessionConnection {
    pub from_node_id: String,
    pub from_port: TilePort,
    pub to_node_id: String,
    pub to_port: TilePort,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SavedSessionPortSetting {
    pub node_id: String,
    pub port: TilePort,
    pub access_mode: network::PortMode,
    pub networking_mode: network::PortNetworkingMode,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SavedSessionSubscription {
    pub scope: TileSubscriptionScope,
    pub subscriber_node_id: String,
    pub subject_node_id: String,
    pub direction: TileSubscriptionDirection,
    pub action: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SavedSessionConfiguration {
    pub version: u32,
    pub session_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root_cwd: Option<String>,
    #[serde(default = "default_saved_session_browser_backend")]
    pub browser_backend: BrowserBackend,
    pub tiles: Vec<SavedSessionTile>,
    pub connections: Vec<SavedSessionConnection>,
    pub port_settings: Vec<SavedSessionPortSetting>,
    #[serde(default)]
    pub subscriptions: Vec<SavedSessionSubscription>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SavedSessionConfigurationSummary {
    pub config_name: String,
    pub session_name: String,
    pub file_name: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LoadedSessionConfiguration {
    pub session_id: String,
    pub session_name: String,
    pub minimized_tile_ids: Vec<String>,
    pub layout_entries_by_tile: HashMap<String, TileState>,
}

#[derive(Debug, Clone, Deserialize)]
struct SpawnedAgentWindow {
    tile_id: String,
    pane_id: String,
    window_id: String,
    agent_type: AgentType,
}

#[derive(Debug, Clone)]
struct SavedRuntimeTile {
    runtime_tile_id: String,
    kind: SavedSessionTileKind,
    title: Option<String>,
    layout: TileState,
    minimized: bool,
    agent_type: Option<AgentType>,
    browser: Option<SavedBrowserTile>,
    work: Option<SavedWorkTile>,
}

#[derive(Debug, Clone)]
struct RestoredTile {
    tile_id: String,
    layout: TileState,
    minimized: bool,
}

fn sessions_dir() -> PathBuf {
    runtime::project_root_dir().join("sessions")
}

fn ensure_sessions_dir() -> Result<PathBuf, String> {
    let dir = sessions_dir();
    fs::create_dir_all(&dir)
        .map_err(|error| format!("failed to create sessions directory {}: {error}", dir.display()))?;
    Ok(dir)
}

fn sanitize_config_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("session configuration name cannot be empty".to_string());
    }
    let mut sanitized = String::new();
    let mut last_was_separator = false;
    for ch in trimmed.chars() {
        if ch.is_ascii_alphanumeric() {
            sanitized.push(ch.to_ascii_lowercase());
            last_was_separator = false;
        } else if !last_was_separator {
            sanitized.push('_');
            last_was_separator = true;
        }
    }
    let sanitized = sanitized.trim_matches('_').to_string();
    if sanitized.is_empty() {
        Err("session configuration name must include at least one alphanumeric character".to_string())
    } else {
        Ok(sanitized)
    }
}

fn config_file_name(config_name: &str) -> String {
    format!("{config_name}_session.json")
}

fn config_path_for_name(name: &str) -> Result<PathBuf, String> {
    let config_name = sanitize_config_name(name)?;
    Ok(sessions_dir().join(config_file_name(&config_name)))
}

fn file_name_to_config_name(file_name: &str) -> Option<String> {
    file_name.strip_suffix("_session.json").map(|value| value.to_string())
}

fn file_mtime_ms(metadata: &fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or_default()
}

fn read_saved_configuration(path: &Path) -> Result<SavedSessionConfiguration, String> {
    let raw = fs::read_to_string(path)
        .map_err(|error| format!("failed to read saved session configuration {}: {error}", path.display()))?;
    let config = serde_json::from_str::<SavedSessionConfiguration>(&raw)
        .map_err(|error| format!("failed to parse saved session configuration {}: {error}", path.display()))?;
    if config.version != SAVED_SESSION_VERSION {
        return Err(format!(
            "unsupported saved session configuration version {} in {}",
            config.version,
            path.display(),
        ));
    }
    Ok(config)
}

fn saved_title(window_name: &str, pane_title: &str, command: &str) -> Option<String> {
    let title = if !window_name.trim().is_empty() {
        window_name.trim()
    } else if !pane_title.trim().is_empty() {
        pane_title.trim()
    } else {
        command.trim()
    };
    if title.is_empty() {
        None
    } else {
        Some(title.to_string())
    }
}

fn default_layout_for_kind(kind: SavedSessionTileKind) -> TileState {
    match kind {
        SavedSessionTileKind::Work => TileState {
            x: 100.0,
            y: 100.0,
            width: DEFAULT_WORK_WIDTH,
            height: DEFAULT_WORK_HEIGHT,
            locked: false,
        },
        SavedSessionTileKind::RootAgent
        | SavedSessionTileKind::Agent
        | SavedSessionTileKind::Shell
        | SavedSessionTileKind::Browser => TileState {
            x: 100.0,
            y: 100.0,
            width: DEFAULT_TILE_WIDTH,
            height: DEFAULT_TILE_HEIGHT,
            locked: false,
        },
    }
}

fn node_prefix(kind: SavedSessionTileKind) -> &'static str {
    match kind {
        SavedSessionTileKind::RootAgent => "root",
        SavedSessionTileKind::Agent => "agent",
        SavedSessionTileKind::Shell => "shell",
        SavedSessionTileKind::Browser => "browser",
        SavedSessionTileKind::Work => "work",
    }
}

fn tile_kind_priority(kind: SavedSessionTileKind) -> u8 {
    match kind {
        SavedSessionTileKind::RootAgent => 0,
        SavedSessionTileKind::Agent => 1,
        SavedSessionTileKind::Shell => 2,
        SavedSessionTileKind::Browser => 3,
        SavedSessionTileKind::Work => 4,
    }
}

fn parse_spawned_agent(value: serde_json::Value) -> Result<SpawnedAgentWindow, String> {
    serde_json::from_value(value).map_err(|error| format!("failed to decode spawned agent payload: {error}"))
}

fn replace_session_connections(
    db_path: &Path,
    session_id: &str,
    connections: Vec<NetworkConnection>,
) -> Result<(), String> {
    let mut all = network::list_all_connections_at(db_path)?;
    all.retain(|entry| entry.session_id != session_id);
    all.extend(connections);
    all.sort_by(|left, right| {
        left.session_id
            .cmp(&right.session_id)
            .then_with(|| left.from_tile_id.cmp(&right.from_tile_id))
            .then_with(|| left.from_port.as_str().cmp(right.from_port.as_str()))
            .then_with(|| left.to_tile_id.cmp(&right.to_tile_id))
            .then_with(|| left.to_port.as_str().cmp(right.to_port.as_str()))
    });
    all.dedup_by(|left, right| {
        left.session_id == right.session_id
            && left.from_tile_id == right.from_tile_id
            && left.from_port == right.from_port
            && left.to_tile_id == right.to_tile_id
            && left.to_port == right.to_port
    });
    network::replace_connections_at(db_path, &all)
}

fn replace_session_port_settings(
    db_path: &Path,
    session_id: &str,
    settings: Vec<TilePortSetting>,
) -> Result<(), String> {
    let mut all = network::list_all_port_settings_at(db_path)?;
    all.retain(|entry| entry.session_id != session_id);
    all.extend(settings);
    all.sort_by(|left, right| {
        left.session_id
            .cmp(&right.session_id)
            .then_with(|| left.tile_id.cmp(&right.tile_id))
            .then_with(|| left.port.as_str().cmp(right.port.as_str()))
    });
    all.dedup_by(|left, right| {
        left.session_id == right.session_id
            && left.tile_id == right.tile_id
            && left.port == right.port
    });
    network::replace_port_settings_at(db_path, &all)
}

fn session_layout_entry(
    layout_entries: &HashMap<String, TileState>,
    tile_id: &str,
    kind: SavedSessionTileKind,
) -> TileState {
    layout_entries
        .get(tile_id)
        .cloned()
        .unwrap_or_else(|| default_layout_for_kind(kind))
}

fn browser_tile_state(app: &tauri::AppHandle, pane_id: &str, incognito: bool) -> SavedBrowserTile {
    if let Some(extension) = browser::browser_extension_info_for_pane(app, pane_id) {
        return SavedBrowserTile {
            incognito,
            load_path: extension.source_path,
            navigate_url: None,
        };
    }
    SavedBrowserTile {
        incognito,
        load_path: None,
        navigate_url: browser::current_url_for_pane(app, pane_id),
    }
}

fn build_saved_configuration(
    app: &tauri::AppHandle,
    state: &AppState,
    session_id: &str,
    minimized_tile_ids: &[String],
    layout_entries_by_tile: Option<HashMap<String, TileState>>,
) -> Result<SavedSessionConfiguration, String> {
    let snapshot = tmux_state::snapshot(state)?;
    let session = snapshot
        .sessions
        .iter()
        .find(|entry| entry.id == session_id)
        .ok_or_else(|| format!("unknown tmux session: {session_id}"))?;
    let mut layout_entries = state
        .tile_states
        .lock()
        .map_err(|error| error.to_string())?
        .clone();
    if let Some(overrides) = layout_entries_by_tile {
        layout_entries.extend(overrides);
    }
    let tile_records = state.list_tile_records_in_session(session_id)?;
    let work_items = work::list_work_at(Path::new(runtime::database_path()), work::WorkListScope::CurrentSession(session_id.to_string()))?;
    let connections = network::list_connections_at(Path::new(runtime::database_path()), session_id)?;
    let port_settings = network::list_port_settings_at(Path::new(runtime::database_path()), session_id)?;
    let subscriptions = state.list_tile_subscriptions_in_session(session_id)?;
    let session_agents = state.list_agents_in_session(session_id)?;
    let agent_tile_id_by_agent_id = session_agents
        .iter()
        .map(|agent| (agent.agent_id.clone(), agent.tile_id.clone()))
        .collect::<HashMap<_, _>>();
    let work_item_by_tile_id = work_items
        .iter()
        .map(|item| (item.tile_id.clone(), item.clone()))
        .collect::<HashMap<_, _>>();

    let mut runtime_tiles = Vec::new();
    for record in tile_records {
        let pane = snapshot
            .panes
            .iter()
            .find(|pane| pane.id == record.pane_id)
            .ok_or_else(|| format!("missing tmux pane {} for tile {}", record.pane_id, record.tile_id))?;
        let window = snapshot
            .windows
            .iter()
            .find(|window| window.id == record.window_id)
            .ok_or_else(|| format!("missing tmux window {} for tile {}", record.window_id, record.tile_id))?;
        let agent = state
            .agent_info_by_tile(&record.tile_id)?
            .or_else(|| state.agent_info_by_pane(&record.pane_id).ok().flatten());
        let kind = if record.kind == TileRecordKind::Work {
            SavedSessionTileKind::Work
        } else if agent.as_ref().map(|info| info.agent_role) == Some(AgentRole::Root) {
            SavedSessionTileKind::RootAgent
        } else {
            match record.kind {
                TileRecordKind::Agent => SavedSessionTileKind::Agent,
                TileRecordKind::Shell => SavedSessionTileKind::Shell,
                TileRecordKind::Browser => SavedSessionTileKind::Browser,
                TileRecordKind::Work => SavedSessionTileKind::Work,
            }
        };
        let work = if kind == SavedSessionTileKind::Work {
            let item = work_item_by_tile_id
                .get(&record.tile_id)
                .ok_or_else(|| format!("missing work item for saved work tile {}", record.tile_id))?;
            let owner_node_tile_id = item
                .owner_agent_id
                .as_ref()
                .and_then(|agent_id| agent_tile_id_by_agent_id.get(agent_id))
                .cloned();
            Some(SavedWorkTile {
                title: item.title.clone(),
                topic: item.topic.clone(),
                current_stage: item.current_stage,
                stages: item.stages.clone(),
                reviews: item.reviews.clone(),
                owner_node_id: owner_node_tile_id,
                created_at: item.created_at,
                updated_at: item.updated_at,
            })
        } else {
            None
        };
        runtime_tiles.push(SavedRuntimeTile {
            runtime_tile_id: record.tile_id.clone(),
            kind,
            title: work
                .as_ref()
                .map(|entry| entry.title.clone())
                .or_else(|| saved_title(&window.name, &pane.title, &pane.command)),
            layout: session_layout_entry(&layout_entries, &record.tile_id, kind),
            minimized: minimized_tile_ids.iter().any(|tile_id| tile_id == &record.tile_id),
            agent_type: agent.as_ref().map(|info| info.agent_type),
            browser: if kind == SavedSessionTileKind::Browser {
                Some(browser_tile_state(app, &record.pane_id, record.browser_incognito))
            } else {
                None
            },
            work,
        });
    }

    runtime_tiles.sort_by(|left, right| {
        tile_kind_priority(left.kind)
            .cmp(&tile_kind_priority(right.kind))
            .then_with(|| left.title.as_deref().unwrap_or("").cmp(right.title.as_deref().unwrap_or("")))
            .then_with(|| left.runtime_tile_id.cmp(&right.runtime_tile_id))
    });

    let mut next_node_index: HashMap<&'static str, usize> = HashMap::new();
    let mut node_id_by_runtime_tile_id = HashMap::new();
    let mut saved_tiles = Vec::new();

    for tile in runtime_tiles {
        let prefix = node_prefix(tile.kind);
        let next_index = next_node_index.entry(prefix).or_insert(0);
        *next_index += 1;
        let node_id = if tile.kind == SavedSessionTileKind::RootAgent {
            "root".to_string()
        } else {
            format!("{prefix}_{next_index}")
        };
        node_id_by_runtime_tile_id.insert(tile.runtime_tile_id.clone(), node_id.clone());
        let work = tile.work.as_ref().map(|work_tile| SavedWorkTile {
            owner_node_id: work_tile
                .owner_node_id
                .as_ref()
                .and_then(|runtime_tile_id| node_id_by_runtime_tile_id.get(runtime_tile_id).cloned()),
            ..work_tile.clone()
        });
        saved_tiles.push(SavedSessionTile {
            node_id,
            kind: tile.kind,
            title: tile.title,
            layout: tile.layout,
            minimized: tile.minimized,
            agent_type: tile.agent_type,
            browser: tile.browser,
            work,
        });
    }

    let mut saved_connections = connections
        .into_iter()
        .filter_map(|connection| {
            Some(SavedSessionConnection {
                from_node_id: node_id_by_runtime_tile_id.get(&connection.from_tile_id)?.clone(),
                from_port: connection.from_port,
                to_node_id: node_id_by_runtime_tile_id.get(&connection.to_tile_id)?.clone(),
                to_port: connection.to_port,
            })
        })
        .collect::<Vec<_>>();
    saved_connections.sort_by(|left, right| {
        left.from_node_id
            .cmp(&right.from_node_id)
            .then_with(|| left.from_port.as_str().cmp(right.from_port.as_str()))
            .then_with(|| left.to_node_id.cmp(&right.to_node_id))
            .then_with(|| left.to_port.as_str().cmp(right.to_port.as_str()))
    });

    let mut saved_port_settings = port_settings
        .into_iter()
        .filter_map(|setting| {
            Some(SavedSessionPortSetting {
                node_id: node_id_by_runtime_tile_id.get(&setting.tile_id)?.clone(),
                port: setting.port,
                access_mode: setting.access_mode,
                networking_mode: setting.networking_mode,
            })
        })
        .collect::<Vec<_>>();
    saved_port_settings.sort_by(|left, right| {
        left.node_id
            .cmp(&right.node_id)
            .then_with(|| left.port.as_str().cmp(right.port.as_str()))
    });

    let mut saved_subscriptions = subscriptions
        .into_iter()
        .filter_map(|subscription| {
            Some(SavedSessionSubscription {
                scope: subscription.scope,
                subscriber_node_id: node_id_by_runtime_tile_id
                    .get(&subscription.subscriber_tile_id)?
                    .clone(),
                subject_node_id: node_id_by_runtime_tile_id
                    .get(&subscription.subject_tile_id)?
                    .clone(),
                direction: subscription.direction,
                action: subscription.action,
            })
        })
        .collect::<Vec<_>>();
    saved_subscriptions.sort_by(|left, right| {
        left.subscriber_node_id
            .cmp(&right.subscriber_node_id)
            .then_with(|| left.subject_node_id.cmp(&right.subject_node_id))
            .then_with(|| left.scope.cmp(&right.scope))
            .then_with(|| left.direction.cmp(&right.direction))
            .then_with(|| left.action.cmp(&right.action))
    });

    Ok(SavedSessionConfiguration {
        version: SAVED_SESSION_VERSION,
        session_name: session.name.clone(),
        root_cwd: session.root_cwd.clone(),
        browser_backend: session.browser_backend,
        tiles: saved_tiles,
        connections: saved_connections,
        port_settings: saved_port_settings,
        subscriptions: saved_subscriptions,
    })
}

fn clear_session_for_load(
    app: &tauri::AppHandle,
    state: &AppState,
    session_id: &str,
    root_window_id: &str,
) -> Result<Vec<String>, String> {
    let snapshot = tmux_state::snapshot(state)?;
    let existing_work_items = work::list_work_at(
        Path::new(runtime::database_path()),
        work::WorkListScope::CurrentSession(session_id.to_string()),
    )?;
    let mut cleared_tile_ids = state
        .list_tile_records_in_session(session_id)?
        .into_iter()
        .map(|record| record.tile_id)
        .collect::<Vec<_>>();
    cleared_tile_ids.extend(existing_work_items.iter().map(|item| item.tile_id.clone()));

    replace_session_connections(Path::new(runtime::database_path()), session_id, Vec::new())?;
    replace_session_port_settings(Path::new(runtime::database_path()), session_id, Vec::new())?;
    state.clear_tile_subscriptions_in_session(session_id)?;

    for item in existing_work_items {
        work::delete_work_item_at(Path::new(runtime::database_path()), &item.work_id)?;
    }

    let pane_ids_to_close = snapshot
        .panes
        .iter()
        .filter(|pane| pane.session_id == session_id)
        .map(|pane| pane.id.clone())
        .collect::<Vec<_>>();
    for pane_id in pane_ids_to_close {
        browser::close_browser_surface(app, &pane_id);
    }

    let window_ids_to_kill = snapshot
        .windows
        .iter()
        .filter(|window| window.session_id == session_id && window.id != root_window_id)
        .map(|window| window.id.clone())
        .collect::<Vec<_>>();
    for window_id in window_ids_to_kill {
        commands::kill_window(app.clone(), window_id)?;
    }

    tmux_state::select_window(root_window_id)?;

    Ok(cleared_tile_ids)
}

#[tauri::command]
pub fn list_saved_session_configurations() -> Result<Vec<SavedSessionConfigurationSummary>, String> {
    let dir = sessions_dir();
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut summaries = Vec::new();
    let entries = fs::read_dir(&dir)
        .map_err(|error| format!("failed to read sessions directory {}: {error}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("failed to read sessions directory entry: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("failed to read file type for {}: {error}", entry.path().display()))?;
        if !file_type.is_file() {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().to_string();
        let Some(config_name) = file_name_to_config_name(&file_name) else {
            continue;
        };
        let config = match read_saved_configuration(&entry.path()) {
            Ok(config) => config,
            Err(error) => {
                log::warn!("{error}");
                continue;
            }
        };
        let metadata = entry
            .metadata()
            .map_err(|error| format!("failed to read metadata for {}: {error}", entry.path().display()))?;
        summaries.push(SavedSessionConfigurationSummary {
            config_name,
            session_name: config.session_name,
            file_name,
            updated_at: file_mtime_ms(&metadata),
        });
    }
    summaries.sort_by(|left, right| {
        left.session_name
            .to_ascii_lowercase()
            .cmp(&right.session_name.to_ascii_lowercase())
            .then_with(|| left.config_name.cmp(&right.config_name))
    });
    Ok(summaries)
}

#[tauri::command]
pub fn save_session_configuration(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    session_id: String,
    minimized_tile_ids: Vec<String>,
    layout_entries_by_tile: Option<HashMap<String, TileState>>,
) -> Result<SavedSessionConfigurationSummary, String> {
    let config = build_saved_configuration(
        &app,
        state.inner(),
        &session_id,
        &minimized_tile_ids,
        layout_entries_by_tile,
    )?;
    let sessions_dir = ensure_sessions_dir()?;
    let config_name = sanitize_config_name(&config.session_name)?;
    let path = sessions_dir.join(config_file_name(&config_name));
    let serialized = serde_json::to_string_pretty(&config)
        .map_err(|error| format!("failed to serialize saved session configuration: {error}"))?;
    fs::write(&path, format!("{serialized}\n"))
        .map_err(|error| format!("failed to write saved session configuration {}: {error}", path.display()))?;
    let metadata = fs::metadata(&path)
        .map_err(|error| format!("failed to read metadata for {}: {error}", path.display()))?;
    Ok(SavedSessionConfigurationSummary {
        config_name,
        session_name: config.session_name,
        file_name: path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_string(),
        updated_at: file_mtime_ms(&metadata),
    })
}

#[tauri::command]
pub fn load_session_configuration(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    session_id: String,
    config_name: String,
) -> Result<LoadedSessionConfiguration, String> {
    let path = config_path_for_name(&config_name)?;
    let config = read_saved_configuration(&path)?;

    if let Some(root_cwd) = config.root_cwd.as_ref() {
        let trimmed = root_cwd.trim();
        if !trimmed.is_empty() {
            tmux_state::set_session_root_cwd(&session_id, trimmed)?;
        }
    }
    tmux_state::set_session_browser_backend(&session_id, config.browser_backend)?;

    let root_tile = config
        .tiles
        .iter()
        .find(|tile| tile.kind == SavedSessionTileKind::RootAgent)
        .cloned();
    let ensured_root = commands::ensure_root_agent_for_session(app.clone(), session_id.clone(), true)?;
    let mut root_spawn = parse_spawned_agent(ensured_root)?;
    if let Some(saved_root) = root_tile.as_ref() {
        if let Some(saved_agent_type) = saved_root.agent_type {
            if root_spawn.agent_type != saved_agent_type {
                root_spawn = parse_spawned_agent(commands::respawn_root_agent_in_pane(
                    app.clone(),
                    session_id.clone(),
                    root_spawn.window_id.clone(),
                    root_spawn.pane_id.clone(),
                    saved_agent_type,
                )?)?;
            }
        }
    }

    let cleared_tile_ids = clear_session_for_load(&app, state.inner(), &session_id, &root_spawn.window_id)?;
    let mut restored_tiles = Vec::new();
    let mut tile_id_by_node = HashMap::new();
    if let Some(saved_root) = root_tile.as_ref() {
        if let Some(title) = saved_root.title.as_ref() {
            commands::set_pane_title(app.clone(), root_spawn.pane_id.clone(), title.clone())?;
        }
        tile_id_by_node.insert(saved_root.node_id.clone(), root_spawn.tile_id.clone());
        restored_tiles.push(RestoredTile {
            tile_id: root_spawn.tile_id.clone(),
            layout: saved_root.layout.clone(),
            minimized: saved_root.minimized,
        });
    }

    for tile in config.tiles.iter().filter(|tile| tile.kind != SavedSessionTileKind::RootAgent) {
        match tile.kind {
            SavedSessionTileKind::Agent => {
                let spawned = parse_spawned_agent(commands::spawn_agent_window_with_type(
                    app.clone(),
                    Some(session_id.clone()),
                    tile.agent_type.unwrap_or(AgentType::Claude),
                )?)?;
                if let Some(title) = tile.title.as_ref() {
                    commands::set_pane_title(app.clone(), spawned.pane_id.clone(), title.clone())?;
                }
                tile_id_by_node.insert(tile.node_id.clone(), spawned.tile_id.clone());
                restored_tiles.push(RestoredTile {
                    tile_id: spawned.tile_id,
                    layout: tile.layout.clone(),
                    minimized: tile.minimized,
                });
            }
            SavedSessionTileKind::Shell => {
                let spawned = commands::new_shell_window_detached(app.clone(), Some(session_id.clone()))?;
                if let Some(title) = tile.title.as_ref() {
                    commands::set_pane_title(app.clone(), spawned.pane_id.clone(), title.clone())?;
                }
                tile_id_by_node.insert(tile.node_id.clone(), spawned.tile_id.clone());
                restored_tiles.push(RestoredTile {
                    tile_id: spawned.tile_id,
                    layout: tile.layout.clone(),
                    minimized: tile.minimized,
                });
            }
            SavedSessionTileKind::Browser => {
                let browser_state = tile.browser.clone().unwrap_or(SavedBrowserTile {
                    incognito: false,
                    load_path: None,
                    navigate_url: None,
                });
                let spawned = commands::spawn_browser_window_with_pane(
                    app.clone(),
                    Some(session_id.clone()),
                    browser_state.incognito,
                    browser_state.load_path.clone(),
                )?;
                if browser_state.load_path.is_none() {
                    if let Some(url) = browser_state.navigate_url.as_ref() {
                        browser::navigate_browser_webview(&app, &spawned.pane_id, url)?;
                    }
                }
                if let Some(title) = tile.title.as_ref() {
                    commands::set_pane_title(app.clone(), spawned.pane_id.clone(), title.clone())?;
                }
                tile_id_by_node.insert(tile.node_id.clone(), spawned.tile_id.clone());
                restored_tiles.push(RestoredTile {
                    tile_id: spawned.tile_id,
                    layout: tile.layout.clone(),
                    minimized: tile.minimized,
                });
            }
            SavedSessionTileKind::Work => {
                let work_tile = tile
                    .work
                    .clone()
                    .ok_or_else(|| format!("saved work tile {} is missing work state", tile.node_id))?;
                let backing = commands::new_work_window_detached(
                    app.clone(),
                    Some(session_id.clone()),
                    &work_tile.title,
                    None,
                )?;
                let imported = work::import_work_item_at(
                    Path::new(runtime::database_path()),
                    ImportedWorkItem {
                        work_id: None,
                        tile_id: backing.tile_id.clone(),
                        session_id: session_id.clone(),
                        title: work_tile.title,
                        topic: work_tile.topic,
                        current_stage: work_tile.current_stage,
                        stages: work_tile.stages,
                        reviews: work_tile.reviews,
                        created_at: work_tile.created_at,
                        updated_at: work_tile.updated_at,
                    },
                )?;
                tile_id_by_node.insert(tile.node_id.clone(), imported.tile_id.clone());
                restored_tiles.push(RestoredTile {
                    tile_id: imported.tile_id,
                    layout: tile.layout.clone(),
                    minimized: tile.minimized,
                });
            }
            SavedSessionTileKind::RootAgent => {}
        }
    }

    let restored_connections = config
        .connections
        .iter()
        .filter_map(|connection| {
            Some(NetworkConnection {
                session_id: session_id.clone(),
                from_tile_id: tile_id_by_node.get(&connection.from_node_id)?.clone(),
                from_port: connection.from_port,
                to_tile_id: tile_id_by_node.get(&connection.to_node_id)?.clone(),
                to_port: connection.to_port,
            })
        })
        .collect::<Vec<_>>();
    replace_session_connections(Path::new(runtime::database_path()), &session_id, restored_connections)?;

    let restored_port_settings = config
        .port_settings
        .iter()
        .filter_map(|setting| {
            Some(TilePortSetting {
                session_id: session_id.clone(),
                tile_id: tile_id_by_node.get(&setting.node_id)?.clone(),
                port: setting.port,
                access_mode: setting.access_mode,
                networking_mode: setting.networking_mode,
            })
        })
        .collect::<Vec<_>>();
    replace_session_port_settings(Path::new(runtime::database_path()), &session_id, restored_port_settings)?;

    for subscription in config.subscriptions.iter().filter_map(|subscription| {
        Some(TileSubscriptionRecord {
            session_id: session_id.clone(),
            scope: subscription.scope,
            subscriber_tile_id: tile_id_by_node.get(&subscription.subscriber_node_id)?.clone(),
            subject_tile_id: tile_id_by_node.get(&subscription.subject_node_id)?.clone(),
            direction: subscription.direction,
            action: subscription.action.clone(),
        })
    }) {
        state.add_tile_subscription(subscription)?;
    }

    {
        let mut layout_entries = state.tile_states.lock().map_err(|error| error.to_string())?;
        for tile_id in cleared_tile_ids {
            layout_entries.remove(&tile_id);
        }
        for restored in &restored_tiles {
            layout_entries.insert(restored.tile_id.clone(), restored.layout.clone());
        }
    }
    state.save();

    tmux_state::emit_snapshot(&app)?;

    Ok(LoadedSessionConfiguration {
        session_id,
        session_name: config.session_name,
        minimized_tile_ids: restored_tiles
            .iter()
            .filter(|tile| tile.minimized)
            .map(|tile| tile.tile_id.clone())
            .collect(),
        layout_entries_by_tile: restored_tiles
            .into_iter()
            .map(|tile| (tile.tile_id, tile.layout))
            .collect(),
    })
}

#[tauri::command]
pub fn delete_session_configuration(config_name: String) -> Result<(), String> {
    let path = config_path_for_name(&config_name)?;
    if !path.is_file() {
        return Err(format!(
            "saved session configuration {} does not exist",
            path.display()
        ));
    }
    fs::remove_file(&path)
        .map_err(|error| format!("failed to delete saved session configuration {}: {error}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        config_file_name,
        file_name_to_config_name,
        sanitize_config_name,
        SavedSessionConfiguration,
        SavedSessionConfigurationSummary,
        SavedSessionSubscription,
        SAVED_SESSION_VERSION,
    };
    use crate::agent::{TileSubscriptionDirection, TileSubscriptionScope};
    use std::fs;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "herd-session-config-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn sanitizes_session_configuration_names() {
        assert_eq!(sanitize_config_name("Main Tab").unwrap(), "main_tab");
        assert_eq!(sanitize_config_name("  Build/QA  ").unwrap(), "build_qa");
        assert!(sanitize_config_name("   ").is_err());
    }

    #[test]
    fn derives_expected_session_configuration_file_name() {
        assert_eq!(config_file_name("main_tab"), "main_tab_session.json");
        assert_eq!(file_name_to_config_name("main_tab_session.json"), Some("main_tab".to_string()));
        assert_eq!(file_name_to_config_name("notes.json"), None);
    }

    #[test]
    fn round_trips_saved_configuration_summary_inputs() {
        let dir = temp_dir("summary");
        let config_path = dir.join("alpha_session.json");
        let config = SavedSessionConfiguration {
            version: SAVED_SESSION_VERSION,
            session_name: "Alpha".to_string(),
            root_cwd: Some("/tmp/herd".to_string()),
            browser_backend: crate::browser::BrowserBackend::LiveWebview,
            tiles: Vec::new(),
            connections: Vec::new(),
            port_settings: Vec::new(),
            subscriptions: Vec::new(),
        };
        fs::write(&config_path, serde_json::to_string_pretty(&config).unwrap()).unwrap();
        let metadata = fs::metadata(&config_path).unwrap();
        let summary = SavedSessionConfigurationSummary {
            config_name: "alpha".to_string(),
            session_name: config.session_name,
            file_name: config_path.file_name().unwrap().to_string_lossy().to_string(),
            updated_at: metadata
                .modified()
                .unwrap()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as i64,
        };
        assert_eq!(summary.config_name, "alpha");
        assert_eq!(summary.file_name, "alpha_session.json");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn defaults_legacy_saved_configuration_browser_backend() {
        let config = serde_json::from_str::<SavedSessionConfiguration>(
            r#"{
              "version": 1,
              "session_name": "Legacy",
              "root_cwd": "/tmp/herd",
              "tiles": [],
              "connections": [],
              "port_settings": []
            }"#,
        )
        .unwrap();

        assert_eq!(
            config.browser_backend,
            crate::browser::BrowserBackend::LiveWebview
        );
    }

    #[test]
    fn defaults_legacy_saved_tile_lock_state_to_false() {
        let config = serde_json::from_str::<SavedSessionConfiguration>(
            r#"{
              "version": 1,
              "session_name": "Legacy",
              "browser_backend": "live_webview",
              "tiles": [
                {
                  "node_id": "shell_1",
                  "kind": "shell",
                  "layout": {
                    "x": 100.0,
                    "y": 120.0,
                    "width": 640.0,
                    "height": 400.0
                  }
                }
              ],
              "connections": [],
              "port_settings": []
            }"#,
        )
        .unwrap();

        assert_eq!(config.tiles[0].layout.locked, false);
    }

    #[test]
    fn round_trips_saved_session_subscriptions() {
        let config = SavedSessionConfiguration {
            version: SAVED_SESSION_VERSION,
            session_name: "Subscriptions".to_string(),
            root_cwd: None,
            browser_backend: crate::browser::BrowserBackend::LiveWebview,
            tiles: Vec::new(),
            connections: Vec::new(),
            port_settings: Vec::new(),
            subscriptions: vec![SavedSessionSubscription {
                scope: TileSubscriptionScope::Network,
                subscriber_node_id: "agent_1".to_string(),
                subject_node_id: "shell_1".to_string(),
                direction: TileSubscriptionDirection::In,
                action: "exec".to_string(),
            }],
        };

        let encoded = serde_json::to_string(&config).unwrap();
        let decoded = serde_json::from_str::<SavedSessionConfiguration>(&encoded).unwrap();
        assert_eq!(decoded.subscriptions, config.subscriptions);
    }
}
