use std::collections::{HashMap, HashSet, VecDeque};
use std::path::Path;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::{
    agent::{AgentInfo, AgentRole, AgentType},
    db,
    tile_registry::TileRecordKind,
    work::{WorkReviewEntry, WorkStage, WorkStageState},
};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum TilePort {
    Left,
    Top,
    Right,
    Bottom,
}

impl TilePort {
    pub const ALL: [Self; 4] = [Self::Left, Self::Top, Self::Right, Self::Bottom];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Left => "left",
            Self::Top => "top",
            Self::Right => "right",
            Self::Bottom => "bottom",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PortMode {
    Read,
    ReadWrite,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TileRpcAccess {
    Read,
    ReadWrite,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NetworkTileKind {
    Agent,
    RootAgent,
    Shell,
    Work,
    Browser,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NetworkTileDescriptor {
    pub tile_id: String,
    pub session_id: String,
    pub kind: NetworkTileKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NetworkConnection {
    pub session_id: String,
    pub from_tile_id: String,
    pub from_port: TilePort,
    pub to_tile_id: String,
    pub to_port: TilePort,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TileTypeFilter {
    Agent,
    Shell,
    Browser,
    Work,
}

impl TileTypeFilter {
    pub fn matches_kind(self, kind: NetworkTileKind) -> bool {
        match self {
            Self::Agent => matches!(kind, NetworkTileKind::Agent | NetworkTileKind::RootAgent),
            Self::Shell => kind == NetworkTileKind::Shell,
            Self::Browser => kind == NetworkTileKind::Browser,
            Self::Work => kind == NetworkTileKind::Work,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentTileDetails {
    pub agent_id: String,
    pub agent_type: AgentType,
    pub agent_role: AgentRole,
    pub display_name: String,
    pub alive: bool,
    pub chatter_subscribed: bool,
    pub topics: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_pid: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PaneTileDetails {
    pub window_name: String,
    pub window_index: u32,
    pub pane_index: u32,
    pub cols: u32,
    pub rows: u32,
    pub active: bool,
    pub dead: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BrowserTileDetails {
    pub window_name: String,
    pub window_index: u32,
    pub pane_index: u32,
    pub cols: u32,
    pub rows: u32,
    pub active: bool,
    pub dead: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkTileDetails {
    pub work_id: String,
    pub topic: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_agent_id: Option<String>,
    pub current_stage: WorkStage,
    pub stages: Vec<WorkStageState>,
    pub reviews: Vec<WorkReviewEntry>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TileMessageArgSpec {
    pub name: String,
    #[serde(rename = "type")]
    pub arg_type: String,
    pub required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub enum_values: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TileMessageSubcommandSpec {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<TileMessageArgSpec>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TileMessageSpec {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<TileMessageArgSpec>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub subcommands: Vec<TileMessageSubcommandSpec>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum TileDetails {
    Agent(AgentTileDetails),
    Shell(PaneTileDetails),
    Browser(BrowserTileDetails),
    Work(WorkTileDetails),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionTileInfo {
    pub tile_id: String,
    pub session_id: String,
    pub kind: NetworkTileKind,
    pub title: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(skip_serializing)]
    pub pane_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_window_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default)]
    pub responds_to: Vec<String>,
    #[serde(default)]
    pub message_api: Vec<TileMessageSpec>,
    pub details: TileDetails,
}

impl SessionTileInfo {
    pub fn placeholder(tile_id: impl Into<String>, session_id: impl Into<String>) -> Self {
        let tile_id = tile_id.into();
        Self {
            title: tile_id.clone(),
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 0.0,
            pane_id: None,
            window_id: None,
            parent_window_id: None,
            command: None,
            responds_to: Vec::new(),
            message_api: Vec::new(),
            details: TileDetails::Shell(PaneTileDetails {
                window_name: String::new(),
                window_index: 0,
                pane_index: 0,
                cols: 0,
                rows: 0,
                active: false,
                dead: false,
            }),
            tile_id,
            session_id: session_id.into(),
            kind: NetworkTileKind::Shell,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NetworkComponent {
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sender_tile_id: Option<String>,
    pub tiles: Vec<SessionTileInfo>,
    pub connections: Vec<NetworkConnection>,
}

pub fn filter_tiles(mut tiles: Vec<SessionTileInfo>, tile_type: Option<TileTypeFilter>) -> Vec<SessionTileInfo> {
    if let Some(tile_type) = tile_type {
        tiles.retain(|tile| tile_type.matches_kind(tile.kind));
    }
    tiles
}

fn pane_label_matches(value: &str, expected: &str) -> bool {
    value.trim().eq_ignore_ascii_case(expected)
}

fn looks_like_browser_backing(window_name: &str, pane_title: &str) -> bool {
    pane_label_matches(pane_title, "Browser") || pane_label_matches(window_name, "Browser")
}

fn looks_like_root_agent_backing(window_name: &str, pane_title: &str) -> bool {
    pane_label_matches(pane_title, "Root") || pane_label_matches(window_name, "Root")
}

fn looks_like_worker_agent_backing(window_name: &str, pane_title: &str) -> bool {
    pane_label_matches(pane_title, "Agent")
        || pane_label_matches(window_name, "Agent")
        || window_name.trim().starts_with("Worker-")
}

pub fn inferred_tmux_tile_record_kind(window_name: &str, pane_title: &str) -> TileRecordKind {
    if looks_like_browser_backing(window_name, pane_title) {
        return TileRecordKind::Browser;
    }

    if looks_like_root_agent_backing(window_name, pane_title)
        || looks_like_worker_agent_backing(window_name, pane_title)
    {
        return TileRecordKind::Agent;
    }

    TileRecordKind::Shell
}

pub fn reconciled_tmux_tile_record_kind(
    existing_kind: Option<TileRecordKind>,
    window_name: &str,
    pane_title: &str,
) -> TileRecordKind {
    match existing_kind {
        Some(TileRecordKind::Agent) => TileRecordKind::Agent,
        Some(TileRecordKind::Browser) => TileRecordKind::Browser,
        Some(TileRecordKind::Shell) | None => inferred_tmux_tile_record_kind(window_name, pane_title),
    }
}

pub fn network_tile_kind_from_record_kind(
    record_kind: TileRecordKind,
    agent_role: Option<AgentRole>,
    window_name: &str,
    pane_title: &str,
) -> NetworkTileKind {
    match record_kind {
        TileRecordKind::Browser => NetworkTileKind::Browser,
        TileRecordKind::Shell => NetworkTileKind::Shell,
        TileRecordKind::Agent => match agent_role {
            Some(AgentRole::Root) => NetworkTileKind::RootAgent,
            Some(AgentRole::Worker) => NetworkTileKind::Agent,
            None if looks_like_root_agent_backing(window_name, pane_title) => NetworkTileKind::RootAgent,
            None => NetworkTileKind::Agent,
        },
    }
}

pub fn browser_controller_agent_id_at(
    db_path: &Path,
    session_id: &str,
    browser_tile_id: &str,
) -> Result<Option<String>, String> {
    let conn = db::open_at(db_path)?;
    controller_agent_id_with_conn(&conn, session_id, browser_tile_id)
}

pub fn derived_work_owner_agent_id_at(
    db_path: &Path,
    session_id: &str,
    work_id: &str,
) -> Result<Option<String>, String> {
    let conn = db::open_at(db_path)?;
    derived_work_owner_agent_id_with_conn(&conn, session_id, work_id)
}

pub fn derived_work_owner_agent_id_with_conn(
    conn: &Connection,
    session_id: &str,
    work_id: &str,
) -> Result<Option<String>, String> {
    let tile_id = conn
        .query_row(
            "SELECT tile_id FROM work_item WHERE work_id = ?1",
            [work_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .map_err(|error| format!("failed to load work tile id for {work_id}: {error}"))?
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("work item {work_id} is missing a tile id"))?;
    controller_agent_id_with_conn(conn, session_id, &tile_id)
}

pub fn controller_agent_id_with_conn(
    conn: &Connection,
    session_id: &str,
    controlled_tile_id: &str,
) -> Result<Option<String>, String> {
    let connections = list_connections_with_conn(conn, session_id)?;
    let connected_tile_id = connections.iter().find_map(|connection| {
        if connection.from_tile_id == controlled_tile_id && connection.from_port == TilePort::Left {
            Some(connection.to_tile_id.clone())
        } else if connection.to_tile_id == controlled_tile_id && connection.to_port == TilePort::Left {
            Some(connection.from_tile_id.clone())
        } else {
            None
        }
    });

    let Some(agent_tile_id) = connected_tile_id else {
        return Ok(None);
    };

    let mut stmt = conn
        .prepare("SELECT data_json FROM agent ORDER BY updated_at ASC")
        .map_err(|error| format!("failed to prepare agent owner lookup: {error}"))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("failed to query agents for owner lookup: {error}"))?;
    for row in rows {
        let json = row.map_err(|error| format!("failed to decode agent owner row: {error}"))?;
        let agent = serde_json::from_str::<AgentInfo>(&json)
            .map_err(|error| format!("failed to parse agent owner json: {error}"))?;
        if agent.session_id == session_id && agent.tile_id == agent_tile_id && agent.alive {
            return Ok(Some(agent.agent_id));
        }
    }
    Ok(None)
}

pub fn list_connections_at(db_path: &Path, session_id: &str) -> Result<Vec<NetworkConnection>, String> {
    let conn = db::open_at(db_path)?;
    list_connections_with_conn(&conn, session_id)
}

pub fn list_all_connections_at(db_path: &Path) -> Result<Vec<NetworkConnection>, String> {
    let conn = db::open_at(db_path)?;
    let mut stmt = conn
        .prepare(
            "SELECT session_id, from_tile_id, from_port, to_tile_id, to_port
             FROM network_connection
             ORDER BY session_id ASC, from_tile_id ASC, from_port ASC, to_tile_id ASC, to_port ASC",
        )
        .map_err(|error| format!("failed to prepare network query: {error}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(NetworkConnection {
                session_id: row.get(0)?,
                from_tile_id: row.get(1)?,
                from_port: parse_port(&row.get::<_, String>(2)?)?,
                to_tile_id: row.get(3)?,
                to_port: parse_port(&row.get::<_, String>(4)?)?,
            })
        })
        .map_err(|error| format!("failed to query network connections: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to decode network connection rows: {error}"))
}

pub fn replace_connections_at(db_path: &Path, connections: &[NetworkConnection]) -> Result<(), String> {
    let mut conn = db::open_at(db_path)?;
    let tx = conn
        .transaction()
        .map_err(|error| format!("failed to begin network replace transaction: {error}"))?;
    tx.execute("DELETE FROM network_connection", [])
        .map_err(|error| format!("failed to clear network connections: {error}"))?;
    for connection in connections {
        tx.execute(
            "INSERT INTO network_connection (session_id, from_tile_id, from_port, to_tile_id, to_port)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                connection.session_id,
                connection.from_tile_id,
                connection.from_port.as_str(),
                connection.to_tile_id,
                connection.to_port.as_str(),
            ],
        )
        .map_err(|error| {
            format!(
                "failed to replace network connection {}:{} <-> {}:{}: {error}",
                connection.from_tile_id,
                connection.from_port.as_str(),
                connection.to_tile_id,
                connection.to_port.as_str()
            )
        })?;
    }
    tx.commit()
        .map_err(|error| format!("failed to commit network replace transaction: {error}"))?;
    Ok(())
}

pub fn list_connections_with_conn(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<NetworkConnection>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT from_tile_id, from_port, to_tile_id, to_port
             FROM network_connection
             WHERE session_id = ?1
             ORDER BY from_tile_id ASC, from_port ASC, to_tile_id ASC, to_port ASC",
        )
        .map_err(|error| format!("failed to prepare network query: {error}"))?;
    let rows = stmt
        .query_map([session_id], |row| {
            Ok(NetworkConnection {
                session_id: session_id.to_string(),
                from_tile_id: row.get(0)?,
                from_port: parse_port(&row.get::<_, String>(1)?)?,
                to_tile_id: row.get(2)?,
                to_port: parse_port(&row.get::<_, String>(3)?)?,
            })
        })
        .map_err(|error| format!("failed to query network connections: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to decode network connection rows: {error}"))
}

pub fn connect_at(
    db_path: &Path,
    from: &NetworkTileDescriptor,
    from_port: TilePort,
    to: &NetworkTileDescriptor,
    to_port: TilePort,
) -> Result<NetworkConnection, String> {
    let mut conn = db::open_at(db_path)?;
    let tx = conn
        .transaction()
        .map_err(|error| format!("failed to begin network connect transaction: {error}"))?;
    let connection = connect_with_conn(&tx, from, from_port, to, to_port)?;
    tx.commit()
        .map_err(|error| format!("failed to commit network connect transaction: {error}"))?;
    Ok(connection)
}

pub fn connect_with_conn(
    conn: &Connection,
    from: &NetworkTileDescriptor,
    from_port: TilePort,
    to: &NetworkTileDescriptor,
    to_port: TilePort,
) -> Result<NetworkConnection, String> {
    validate_connect(conn, from, from_port, to, to_port)?;
    let connection = canonical_connection(
        from.session_id.clone(),
        from.tile_id.clone(),
        from_port,
        to.tile_id.clone(),
        to_port,
    );
    conn.execute(
        "INSERT INTO network_connection (session_id, from_tile_id, from_port, to_tile_id, to_port)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            connection.session_id,
            connection.from_tile_id,
            connection.from_port.as_str(),
            connection.to_tile_id,
            connection.to_port.as_str()
        ],
    )
    .map_err(|error| format!("failed to insert network connection: {error}"))?;
    Ok(connection)
}

pub fn disconnect_at(
    db_path: &Path,
    session_id: &str,
    tile_id: &str,
    port: TilePort,
) -> Result<Option<NetworkConnection>, String> {
    let mut conn = db::open_at(db_path)?;
    let tx = conn
        .transaction()
        .map_err(|error| format!("failed to begin network disconnect transaction: {error}"))?;
    let removed = disconnect_with_conn(&tx, session_id, tile_id, port)?;
    tx.commit()
        .map_err(|error| format!("failed to commit network disconnect transaction: {error}"))?;
    Ok(removed)
}

pub fn disconnect_with_conn(
    conn: &Connection,
    session_id: &str,
    tile_id: &str,
    port: TilePort,
) -> Result<Option<NetworkConnection>, String> {
    let existing = find_connection_for_port_with_conn(conn, session_id, tile_id, port)?;
    let Some(connection) = existing else {
        return Ok(None);
    };
    conn.execute(
        "DELETE FROM network_connection
         WHERE session_id = ?1
           AND from_tile_id = ?2
           AND from_port = ?3
           AND to_tile_id = ?4
           AND to_port = ?5",
        params![
            connection.session_id,
            connection.from_tile_id,
            connection.from_port.as_str(),
            connection.to_tile_id,
            connection.to_port.as_str()
        ],
    )
    .map_err(|error| format!("failed to delete network connection: {error}"))?;
    Ok(Some(connection))
}

pub fn disconnect_all_for_tile_at(
    db_path: &Path,
    session_id: &str,
    tile_id: &str,
) -> Result<Vec<NetworkConnection>, String> {
    let mut conn = db::open_at(db_path)?;
    let tx = conn
        .transaction()
        .map_err(|error| format!("failed to begin network tile disconnect transaction: {error}"))?;
    let connections = list_connections_with_conn(&tx, session_id)?;
    let removed = connections
        .into_iter()
        .filter(|connection| connection.from_tile_id == tile_id || connection.to_tile_id == tile_id)
        .collect::<Vec<_>>();
    for connection in &removed {
        tx.execute(
            "DELETE FROM network_connection
             WHERE session_id = ?1
               AND from_tile_id = ?2
               AND from_port = ?3
               AND to_tile_id = ?4
               AND to_port = ?5",
            params![
                connection.session_id,
                connection.from_tile_id,
                connection.from_port.as_str(),
                connection.to_tile_id,
                connection.to_port.as_str()
            ],
        )
        .map_err(|error| format!("failed to delete network connection: {error}"))?;
    }
    tx.commit()
        .map_err(|error| format!("failed to commit network tile disconnect transaction: {error}"))?;
    Ok(removed)
}

pub fn component_for_tile(
    session_id: &str,
    start_tile_id: &str,
    session_tiles: &[SessionTileInfo],
    connections: &[NetworkConnection],
) -> NetworkComponent {
    let tile_by_id = session_tiles
        .iter()
        .cloned()
        .map(|tile| (tile.tile_id.clone(), tile))
        .collect::<HashMap<_, _>>();

    let mut adjacency: HashMap<&str, Vec<&str>> = HashMap::new();
    for connection in connections.iter().filter(|connection| connection.session_id == session_id) {
        adjacency
            .entry(connection.from_tile_id.as_str())
            .or_default()
            .push(connection.to_tile_id.as_str());
        adjacency
            .entry(connection.to_tile_id.as_str())
            .or_default()
            .push(connection.from_tile_id.as_str());
    }

    let mut visited = HashSet::new();
    let mut queue = VecDeque::from([start_tile_id.to_string()]);
    while let Some(tile_id) = queue.pop_front() {
        if !visited.insert(tile_id.clone()) {
            continue;
        }
        for neighbor in adjacency.get(tile_id.as_str()).into_iter().flatten() {
            if !visited.contains(*neighbor) {
                queue.push_back((*neighbor).to_string());
            }
        }
    }

    if visited.is_empty() {
        visited.insert(start_tile_id.to_string());
    }

    let mut tiles = visited
        .iter()
        .map(|tile_id| {
            tile_by_id
                .get(tile_id)
                .cloned()
                .unwrap_or(SessionTileInfo::placeholder(tile_id.clone(), session_id))
        })
        .collect::<Vec<_>>();
    tiles.sort_by(|left, right| left.tile_id.cmp(&right.tile_id));

    let mut tile_ids = visited;
    tile_ids.insert(start_tile_id.to_string());
    let mut component_connections = connections
        .iter()
        .filter(|connection| connection.session_id == session_id)
        .filter(|connection| {
            tile_ids.contains(&connection.from_tile_id) && tile_ids.contains(&connection.to_tile_id)
        })
        .cloned()
        .collect::<Vec<_>>();
    component_connections.sort_by(|left, right| {
        left.from_tile_id
            .cmp(&right.from_tile_id)
            .then_with(|| left.from_port.cmp(&right.from_port))
            .then_with(|| left.to_tile_id.cmp(&right.to_tile_id))
            .then_with(|| left.to_port.cmp(&right.to_port))
    });

    NetworkComponent {
        session_id: session_id.to_string(),
        sender_tile_id: Some(start_tile_id.to_string()),
        tiles,
        connections: component_connections,
    }
}

pub fn filter_component(mut component: NetworkComponent, tile_type: Option<TileTypeFilter>) -> NetworkComponent {
    component.tiles = filter_tiles(component.tiles, tile_type);
    let tile_ids = component
        .tiles
        .iter()
        .map(|tile| tile.tile_id.clone())
        .collect::<HashSet<_>>();
    component
        .connections
        .retain(|connection| tile_ids.contains(&connection.from_tile_id) && tile_ids.contains(&connection.to_tile_id));
    component
}

pub fn port_mode(kind: NetworkTileKind, port: TilePort) -> PortMode {
    match kind {
        NetworkTileKind::Work => {
            if port == TilePort::Left {
                PortMode::ReadWrite
            } else {
                PortMode::Read
            }
        }
        NetworkTileKind::Browser
        | NetworkTileKind::Agent
        | NetworkTileKind::RootAgent
        | NetworkTileKind::Shell => PortMode::ReadWrite,
    }
}

pub fn dispatchable_messages(kind: NetworkTileKind) -> &'static [&'static str] {
    match kind {
        NetworkTileKind::Shell => &["get", "output_read", "input_send", "exec", "role_set"],
        NetworkTileKind::Browser => &["get", "navigate", "load", "drive"],
        NetworkTileKind::Agent | NetworkTileKind::RootAgent => {
            &["get", "output_read", "input_send", "exec", "role_set"]
        }
        NetworkTileKind::Work => &["get", "stage_start", "stage_complete", "review_approve", "review_improve"],
    }
}

pub fn readable_messages(kind: NetworkTileKind) -> &'static [&'static str] {
    match kind {
        NetworkTileKind::Shell | NetworkTileKind::Agent | NetworkTileKind::RootAgent => &["get", "output_read"],
        NetworkTileKind::Browser | NetworkTileKind::Work => &["get"],
    }
}

pub fn dispatchable_messages_for_access(
    kind: NetworkTileKind,
    access: TileRpcAccess,
) -> &'static [&'static str] {
    match access {
        TileRpcAccess::Read => readable_messages(kind),
        TileRpcAccess::ReadWrite => dispatchable_messages(kind),
    }
}

pub fn responds_to_for_access(kind: NetworkTileKind, access: TileRpcAccess) -> Vec<String> {
    ["get", "call"]
        .into_iter()
        .chain(
            dispatchable_messages_for_access(kind, access)
                .iter()
                .copied()
                .filter(|message_name| *message_name != "get"),
        )
        .map(str::to_string)
        .collect()
}

pub fn responds_to(kind: NetworkTileKind) -> Vec<String> {
    responds_to_for_access(kind, TileRpcAccess::ReadWrite)
}

fn message_arg(
    name: &str,
    arg_type: &str,
    required: bool,
    description: &str,
    enum_values: &[&str],
) -> TileMessageArgSpec {
    TileMessageArgSpec {
        name: name.to_string(),
        arg_type: arg_type.to_string(),
        required,
        description: Some(description.to_string()),
        enum_values: enum_values.iter().map(|value| (*value).to_string()).collect(),
    }
}

fn required_message_arg(name: &str, arg_type: &str, description: &str) -> TileMessageArgSpec {
    message_arg(name, arg_type, true, description, &[])
}

fn optional_message_arg(name: &str, arg_type: &str, description: &str) -> TileMessageArgSpec {
    message_arg(name, arg_type, false, description, &[])
}

fn required_enum_message_arg(
    name: &str,
    arg_type: &str,
    description: &str,
    enum_values: &[&str],
) -> TileMessageArgSpec {
    message_arg(name, arg_type, true, description, enum_values)
}

fn tile_message(
    name: &str,
    description: &str,
    args: Vec<TileMessageArgSpec>,
    subcommands: Vec<TileMessageSubcommandSpec>,
) -> TileMessageSpec {
    TileMessageSpec {
        name: name.to_string(),
        description: Some(description.to_string()),
        args,
        subcommands,
    }
}

fn tile_subcommand(
    name: &str,
    description: &str,
    args: Vec<TileMessageArgSpec>,
) -> TileMessageSubcommandSpec {
    TileMessageSubcommandSpec {
        name: name.to_string(),
        description: Some(description.to_string()),
        args,
    }
}

fn call_actions_for_access(kind: NetworkTileKind, access: TileRpcAccess) -> Vec<&'static str> {
    std::iter::once("get")
        .chain(
            dispatchable_messages_for_access(kind, access)
                .iter()
                .copied()
                .filter(|message_name| *message_name != "get"),
        )
        .collect()
}

fn get_message_spec() -> TileMessageSpec {
    tile_message("get", "Return the current tile payload.", Vec::new(), Vec::new())
}

fn call_message_spec(kind: NetworkTileKind, access: TileRpcAccess) -> TileMessageSpec {
    let actions = call_actions_for_access(kind, access);
    tile_message(
        "call",
        "Invoke one of this tile's allowed messages through network_call or tile_call.",
        vec![
            required_enum_message_arg(
                "action",
                "string",
                "Message name to invoke on this tile.",
                &actions,
            ),
            optional_message_arg("args", "object", "Optional message-specific argument object."),
        ],
        Vec::new(),
    )
}

fn message_spec_for_kind(kind: NetworkTileKind, message_name: &str) -> TileMessageSpec {
    match (kind, message_name) {
        (NetworkTileKind::Shell | NetworkTileKind::Agent | NetworkTileKind::RootAgent, "output_read") => {
            tile_message(
                "output_read",
                "Read captured terminal output from the tile.",
                Vec::new(),
                Vec::new(),
            )
        }
        (NetworkTileKind::Shell | NetworkTileKind::Agent | NetworkTileKind::RootAgent, "input_send") => {
            tile_message(
                "input_send",
                "Send raw input bytes to the tile's terminal.",
                vec![required_message_arg("input", "string", "Text to send to the tile terminal.")],
                Vec::new(),
            )
        }
        (NetworkTileKind::Shell | NetworkTileKind::Agent | NetworkTileKind::RootAgent, "exec") => {
            tile_message(
                "exec",
                "Send a shell command to the existing terminal process and press Enter.",
                vec![required_message_arg("command", "string", "Shell command to send to the tile terminal.")],
                Vec::new(),
            )
        }
        (NetworkTileKind::Shell | NetworkTileKind::Agent | NetworkTileKind::RootAgent, "role_set") => {
            tile_message(
                "role_set",
                "Mark the terminal tile with a Herd role label.",
                vec![required_message_arg("role", "string", "Role label to apply to the tile.")],
                Vec::new(),
            )
        }
        (NetworkTileKind::Browser, "navigate") => tile_message(
            "navigate",
            "Navigate the browser tile to a URL.",
            vec![required_message_arg("url", "string", "Absolute URL to load in the browser tile.")],
            Vec::new(),
        ),
        (NetworkTileKind::Browser, "load") => tile_message(
            "load",
            "Load a local file path in the browser tile.",
            vec![required_message_arg(
                "path",
                "string",
                "Absolute or repo-relative file path to load.",
            )],
            Vec::new(),
        ),
        (NetworkTileKind::Browser, "drive") => tile_message(
            "drive",
            "Drive the browser tile through one of the supported browser automation subcommands.",
            vec![
                required_enum_message_arg(
                    "action",
                    "string",
                    "Browser drive subcommand to execute.",
                    &["click", "type", "dom_query", "eval"],
                ),
                optional_message_arg("args", "object", "Nested args for the selected browser drive subcommand."),
            ],
            vec![
                tile_subcommand(
                    "click",
                    "Click the first element matching a selector.",
                    vec![required_message_arg("selector", "string", "CSS selector for the target element.")],
                ),
                tile_subcommand(
                    "type",
                    "Type text into an input, textarea, or contenteditable element.",
                    vec![
                        required_message_arg("selector", "string", "CSS selector for the target element."),
                        required_message_arg("text", "string", "Text to insert into the target element."),
                        optional_message_arg(
                            "clear",
                            "boolean",
                            "Whether to clear the existing value first. Defaults to true.",
                        ),
                    ],
                ),
                tile_subcommand(
                    "dom_query",
                    "Evaluate JavaScript as an expression and return its result.",
                    vec![required_message_arg(
                        "js",
                        "string",
                        "JavaScript expression to evaluate in the browser DOM.",
                    )],
                ),
                tile_subcommand(
                    "eval",
                    "Run JavaScript statements in the browser DOM.",
                    vec![required_message_arg("js", "string", "JavaScript source to execute in the browser DOM.")],
                ),
            ],
        ),
        (NetworkTileKind::Work, "stage_start") => tile_message(
            "stage_start",
            "Start the current work stage for an agent.",
            vec![required_message_arg("agent_id", "string", "Agent ID to mark as the current stage owner.")],
            Vec::new(),
        ),
        (NetworkTileKind::Work, "stage_complete") => tile_message(
            "stage_complete",
            "Complete the current work stage for an agent.",
            vec![required_message_arg("agent_id", "string", "Agent ID completing the current stage.")],
            Vec::new(),
        ),
        (NetworkTileKind::Work, "review_approve") => tile_message(
            "review_approve",
            "Approve the current work stage review.",
            Vec::new(),
            Vec::new(),
        ),
        (NetworkTileKind::Work, "review_improve") => tile_message(
            "review_improve",
            "Request improvements for the current work stage review.",
            vec![required_message_arg("comment", "string", "Review feedback explaining the requested improvement.")],
            Vec::new(),
        ),
        _ => tile_message(
            message_name,
            "Invoke the tile message.",
            Vec::new(),
            Vec::new(),
        ),
    }
}

pub fn message_api_for_access(kind: NetworkTileKind, access: TileRpcAccess) -> Vec<TileMessageSpec> {
    std::iter::once(get_message_spec())
        .chain(std::iter::once(call_message_spec(kind, access)))
        .chain(
            dispatchable_messages_for_access(kind, access)
                .iter()
                .copied()
                .filter(|message_name| *message_name != "get")
                .map(|message_name| message_spec_for_kind(kind, message_name)),
        )
        .collect()
}

pub fn message_api(kind: NetworkTileKind) -> Vec<TileMessageSpec> {
    message_api_for_access(kind, TileRpcAccess::ReadWrite)
}

pub fn rpc_access_for_sender_to_tile(
    sender_tile_id: Option<&str>,
    target_tile_id: &str,
    target_kind: NetworkTileKind,
    connections: &[NetworkConnection],
) -> TileRpcAccess {
    if matches!(target_kind, NetworkTileKind::Agent | NetworkTileKind::RootAgent) {
        return TileRpcAccess::Read;
    }

    let Some(sender_tile_id) = sender_tile_id else {
        return TileRpcAccess::Read;
    };

    let mut access = TileRpcAccess::Read;
    for connection in connections {
        let target_port = if connection.from_tile_id == target_tile_id && connection.to_tile_id == sender_tile_id {
            Some(connection.from_port)
        } else if connection.to_tile_id == target_tile_id && connection.from_tile_id == sender_tile_id {
            Some(connection.to_port)
        } else {
            None
        };

        if let Some(target_port) = target_port {
            if port_mode(target_kind, target_port) == PortMode::ReadWrite {
                return TileRpcAccess::ReadWrite;
            }
            access = TileRpcAccess::Read;
        }
    }
    access
}

pub fn parse_port(value: &str) -> Result<TilePort, rusqlite::Error> {
    match value {
        "left" => Ok(TilePort::Left),
        "top" => Ok(TilePort::Top),
        "right" => Ok(TilePort::Right),
        "bottom" => Ok(TilePort::Bottom),
        _ => Err(rusqlite::Error::FromSqlConversionFailure(
            value.len(),
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("unknown port: {value}"),
            )),
        )),
    }
}

fn canonical_connection(
    session_id: String,
    from_tile_id: String,
    from_port: TilePort,
    to_tile_id: String,
    to_port: TilePort,
) -> NetworkConnection {
    let left_key = (from_tile_id.as_str(), from_port.as_str());
    let right_key = (to_tile_id.as_str(), to_port.as_str());
    if left_key <= right_key {
        NetworkConnection {
            session_id,
            from_tile_id,
            from_port,
            to_tile_id,
            to_port,
        }
    } else {
        NetworkConnection {
            session_id,
            from_tile_id: to_tile_id,
            from_port: to_port,
            to_tile_id: from_tile_id,
            to_port: from_port,
        }
    }
}

fn validate_connect(
    conn: &Connection,
    from: &NetworkTileDescriptor,
    from_port: TilePort,
    to: &NetworkTileDescriptor,
    to_port: TilePort,
) -> Result<(), String> {
    if from.session_id != to.session_id {
        return Err("cannot connect tiles across sessions".to_string());
    }
    if from.tile_id == to.tile_id {
        return Err("cannot connect a tile to itself".to_string());
    }
    let from_mode = port_mode(from.kind, from_port);
    let to_mode = port_mode(to.kind, to_port);
    if from_mode == PortMode::Read && to_mode == PortMode::Read {
        return Err("cannot connect a read-only port to another read-only port".to_string());
    }
    validate_controlled_port(from, from_port, to)?;
    validate_controlled_port(to, to_port, from)?;

    if find_connection_for_port_with_conn(conn, &from.session_id, &from.tile_id, from_port)?.is_some() {
        return Err(format!("port {} on {} is already connected", from_port.as_str(), from.tile_id));
    }
    if find_connection_for_port_with_conn(conn, &to.session_id, &to.tile_id, to_port)?.is_some() {
        return Err(format!("port {} on {} is already connected", to_port.as_str(), to.tile_id));
    }

    Ok(())
}

fn validate_controlled_port(
    controlled: &NetworkTileDescriptor,
    controlled_port: TilePort,
    other: &NetworkTileDescriptor,
) -> Result<(), String> {
    if matches!(controlled.kind, NetworkTileKind::Work | NetworkTileKind::Browser)
        && controlled_port == TilePort::Left
        && !is_agent_kind(other.kind)
    {
        return Err(format!(
            "{} left port only accepts agent tiles",
            match controlled.kind {
                NetworkTileKind::Work => "work",
                NetworkTileKind::Browser => "browser",
                _ => "controlled",
            }
        ));
    }
    Ok(())
}

fn is_agent_kind(kind: NetworkTileKind) -> bool {
    matches!(kind, NetworkTileKind::Agent | NetworkTileKind::RootAgent)
}

fn find_connection_for_port_with_conn(
    conn: &Connection,
    session_id: &str,
    tile_id: &str,
    port: TilePort,
) -> Result<Option<NetworkConnection>, String> {
    let connections = list_connections_with_conn(conn, session_id)?;
    Ok(connections.into_iter().find(|connection| {
        (connection.from_tile_id == tile_id && connection.from_port == port)
            || (connection.to_tile_id == tile_id && connection.to_port == port)
    }))
}

#[cfg(test)]
mod tests {
    use super::{
        component_for_tile, connect_at, derived_work_owner_agent_id_at,
        disconnect_all_for_tile_at, dispatchable_messages_for_access, filter_component,
        inferred_tmux_tile_record_kind, list_connections_at, message_api, message_api_for_access,
        network_tile_kind_from_record_kind, port_mode, readable_messages, reconciled_tmux_tile_record_kind,
        responds_to, responds_to_for_access, rpc_access_for_sender_to_tile, NetworkConnection,
        NetworkTileDescriptor, NetworkTileKind, PaneTileDetails, PortMode, SessionTileInfo,
        TileDetails, TileRpcAccess, TileTypeFilter, TilePort, WorkTileDetails,
    };
    use crate::agent::{AgentInfo, AgentRole, AgentType};
    use crate::db;
    use crate::tile_registry::TileRecordKind;
    use crate::work;
    use std::collections::BTreeSet;
    use std::fs;
    use std::path::PathBuf;

    fn temp_db_path(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("herd-network-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root.join("herd.sqlite")
    }

    fn replace_agents(path: &PathBuf, agents: Vec<AgentInfo>) {
        db::replace_agents_at(path, &agents).unwrap();
    }

    fn agent(tile_id: &str, session_id: &str, agent_id: &str) -> AgentInfo {
        AgentInfo {
            agent_id: agent_id.to_string(),
            agent_type: AgentType::Claude,
            agent_role: AgentRole::Worker,
            tile_id: tile_id.to_string(),
            pane_id: tile_id.to_string(),
            window_id: format!("@{}", tile_id.trim_start_matches('%')),
            session_id: session_id.to_string(),
            title: "Agent".to_string(),
            display_name: agent_id.to_string(),
            alive: true,
            chatter_subscribed: true,
            topics: Vec::new(),
            agent_pid: None,
        }
    }

    fn session_tile(tile_id: &str, session_id: &str, kind: NetworkTileKind) -> SessionTileInfo {
        let title = match kind {
            NetworkTileKind::Work => "Work".to_string(),
            _ => format!("Tile {tile_id}"),
        };
        let command = (!matches!(kind, NetworkTileKind::Work)).then(|| "zsh".to_string());
        let details = match kind {
            NetworkTileKind::Agent | NetworkTileKind::RootAgent => TileDetails::Agent(super::AgentTileDetails {
                agent_id: format!("agent-{}", tile_id.trim_start_matches('%')),
                agent_type: AgentType::Claude,
                agent_role: if kind == NetworkTileKind::RootAgent {
                    AgentRole::Root
                } else {
                    AgentRole::Worker
                },
                display_name: "Agent".to_string(),
                alive: true,
                chatter_subscribed: true,
                topics: Vec::new(),
                agent_pid: None,
            }),
            NetworkTileKind::Browser => TileDetails::Browser(super::BrowserTileDetails {
                window_name: "Browser".to_string(),
                window_index: 0,
                pane_index: 0,
                cols: 80,
                rows: 24,
                active: false,
                dead: false,
                current_url: Some("https://example.com/".to_string()),
            }),
            NetworkTileKind::Work => TileDetails::Work(WorkTileDetails {
                work_id: "work-s1-001".to_string(),
                topic: "#work".to_string(),
                owner_agent_id: None,
                current_stage: crate::work::WorkStage::Plan,
                stages: Vec::new(),
                reviews: Vec::new(),
                created_at: 0,
                updated_at: 0,
            }),
            NetworkTileKind::Shell => TileDetails::Shell(PaneTileDetails {
                window_name: "Shell".to_string(),
                window_index: 0,
                pane_index: 0,
                cols: 80,
                rows: 24,
                active: false,
                dead: false,
            }),
        };
        SessionTileInfo {
            tile_id: tile_id.to_string(),
            session_id: session_id.to_string(),
            kind,
            title,
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 0.0,
            pane_id: (!matches!(kind, NetworkTileKind::Work)).then(|| tile_id.to_string()),
            window_id: (!matches!(kind, NetworkTileKind::Work)).then(|| format!("@{}", tile_id.trim_start_matches('%'))),
            parent_window_id: None,
            command,
            responds_to: responds_to(kind),
            message_api: message_api(kind),
            details,
        }
    }

    #[test]
    fn resolves_registry_backed_tile_kinds() {
        assert_eq!(
            inferred_tmux_tile_record_kind("Browser", "Browser"),
            TileRecordKind::Browser
        );
        assert_eq!(
            inferred_tmux_tile_record_kind("Worker-2", "Drive browser to chess website"),
            TileRecordKind::Agent
        );
        assert_eq!(
            reconciled_tmux_tile_record_kind(Some(TileRecordKind::Agent), "Browser", "Browser"),
            TileRecordKind::Agent
        );
        assert_eq!(
            reconciled_tmux_tile_record_kind(Some(TileRecordKind::Browser), "Worker-2", "Agent"),
            TileRecordKind::Browser
        );
        assert_eq!(
            reconciled_tmux_tile_record_kind(Some(TileRecordKind::Shell), "Worker-2", "Drive browser to chess website"),
            TileRecordKind::Agent
        );
        assert_eq!(
            network_tile_kind_from_record_kind(TileRecordKind::Agent, Some(AgentRole::Root), "Worker-1", "Agent"),
            NetworkTileKind::RootAgent
        );
        assert_eq!(
            network_tile_kind_from_record_kind(TileRecordKind::Agent, None, "Worker-1", "Drive browser to chess website"),
            NetworkTileKind::Agent
        );
        assert_eq!(
            network_tile_kind_from_record_kind(TileRecordKind::Browser, Some(AgentRole::Worker), "Browser", "Browser"),
            NetworkTileKind::Browser
        );
        assert_eq!(
            network_tile_kind_from_record_kind(TileRecordKind::Shell, Some(AgentRole::Worker), "Worker-2", "Agent"),
            NetworkTileKind::Shell
        );
    }

    #[test]
    fn resolves_port_modes_by_tile_kind() {
        assert_eq!(port_mode(NetworkTileKind::Agent, TilePort::Top), PortMode::ReadWrite);
        assert_eq!(port_mode(NetworkTileKind::Shell, TilePort::Bottom), PortMode::ReadWrite);
        assert_eq!(port_mode(NetworkTileKind::Work, TilePort::Left), PortMode::ReadWrite);
        assert_eq!(port_mode(NetworkTileKind::Work, TilePort::Top), PortMode::Read);
        assert_eq!(port_mode(NetworkTileKind::Browser, TilePort::Right), PortMode::ReadWrite);
        assert_eq!(readable_messages(NetworkTileKind::Shell), &["get", "output_read"]);
        assert_eq!(readable_messages(NetworkTileKind::Browser), &["get"]);
        assert_eq!(
            dispatchable_messages_for_access(NetworkTileKind::Browser, TileRpcAccess::Read),
            &["get"]
        );
        assert_eq!(
            responds_to(NetworkTileKind::Shell),
            vec!["get", "call", "output_read", "input_send", "exec", "role_set",]
        );
        assert_eq!(
            responds_to(NetworkTileKind::Browser),
            vec!["get", "call", "navigate", "load", "drive"]
        );
        assert_eq!(
            responds_to(NetworkTileKind::Agent),
            vec!["get", "call", "output_read", "input_send", "exec", "role_set",]
        );
        assert_eq!(
            responds_to(NetworkTileKind::Work),
            vec!["get", "call", "stage_start", "stage_complete", "review_approve", "review_improve",]
        );
        assert_eq!(
            responds_to_for_access(NetworkTileKind::Shell, TileRpcAccess::Read),
            vec!["get", "call", "output_read"]
        );
        assert_eq!(
            responds_to_for_access(NetworkTileKind::Browser, TileRpcAccess::Read),
            vec!["get", "call"]
        );
    }

    #[test]
    fn exposes_structured_browser_message_api_with_drive_subcommands() {
        assert_eq!(
            serde_json::to_value(message_api(NetworkTileKind::Browser)).unwrap(),
            serde_json::json!([
                {
                    "name": "get",
                    "description": "Return the current tile payload."
                },
                {
                    "name": "call",
                    "description": "Invoke one of this tile's allowed messages through network_call or tile_call.",
                    "args": [
                        {
                            "name": "action",
                            "type": "string",
                            "required": true,
                            "description": "Message name to invoke on this tile.",
                            "enum_values": ["get", "navigate", "load", "drive"]
                        },
                        {
                            "name": "args",
                            "type": "object",
                            "required": false,
                            "description": "Optional message-specific argument object."
                        }
                    ]
                },
                {
                    "name": "navigate",
                    "description": "Navigate the browser tile to a URL.",
                    "args": [
                        {
                            "name": "url",
                            "type": "string",
                            "required": true,
                            "description": "Absolute URL to load in the browser tile."
                        }
                    ]
                },
                {
                    "name": "load",
                    "description": "Load a local file path in the browser tile.",
                    "args": [
                        {
                            "name": "path",
                            "type": "string",
                            "required": true,
                            "description": "Absolute or repo-relative file path to load."
                        }
                    ]
                },
                {
                    "name": "drive",
                    "description": "Drive the browser tile through one of the supported browser automation subcommands.",
                    "args": [
                        {
                            "name": "action",
                            "type": "string",
                            "required": true,
                            "description": "Browser drive subcommand to execute.",
                            "enum_values": ["click", "type", "dom_query", "eval"]
                        },
                        {
                            "name": "args",
                            "type": "object",
                            "required": false,
                            "description": "Nested args for the selected browser drive subcommand."
                        }
                    ],
                    "subcommands": [
                        {
                            "name": "click",
                            "description": "Click the first element matching a selector.",
                            "args": [
                                {
                                    "name": "selector",
                                    "type": "string",
                                    "required": true,
                                    "description": "CSS selector for the target element."
                                }
                            ]
                        },
                        {
                            "name": "type",
                            "description": "Type text into an input, textarea, or contenteditable element.",
                            "args": [
                                {
                                    "name": "selector",
                                    "type": "string",
                                    "required": true,
                                    "description": "CSS selector for the target element."
                                },
                                {
                                    "name": "text",
                                    "type": "string",
                                    "required": true,
                                    "description": "Text to insert into the target element."
                                },
                                {
                                    "name": "clear",
                                    "type": "boolean",
                                    "required": false,
                                    "description": "Whether to clear the existing value first. Defaults to true."
                                }
                            ]
                        },
                        {
                            "name": "dom_query",
                            "description": "Evaluate JavaScript as an expression and return its result.",
                            "args": [
                                {
                                    "name": "js",
                                    "type": "string",
                                    "required": true,
                                    "description": "JavaScript expression to evaluate in the browser DOM."
                                }
                            ]
                        },
                        {
                            "name": "eval",
                            "description": "Run JavaScript statements in the browser DOM.",
                            "args": [
                                {
                                    "name": "js",
                                    "type": "string",
                                    "required": true,
                                    "description": "JavaScript source to execute in the browser DOM."
                                }
                            ]
                        }
                    ]
                }
            ])
        );
    }

    #[test]
    fn filters_structured_message_api_by_network_access() {
        assert_eq!(
            serde_json::to_value(message_api_for_access(NetworkTileKind::Browser, TileRpcAccess::Read)).unwrap(),
            serde_json::json!([
                {
                    "name": "get",
                    "description": "Return the current tile payload."
                },
                {
                    "name": "call",
                    "description": "Invoke one of this tile's allowed messages through network_call or tile_call.",
                    "args": [
                        {
                            "name": "action",
                            "type": "string",
                            "required": true,
                            "description": "Message name to invoke on this tile.",
                            "enum_values": ["get"]
                        },
                        {
                            "name": "args",
                            "type": "object",
                            "required": false,
                            "description": "Optional message-specific argument object."
                        }
                    ]
                }
            ])
        );
    }

    #[test]
    fn derives_sender_access_from_target_port_mode() {
        let connections = vec![
            NetworkConnection {
                session_id: "$1".to_string(),
                from_tile_id: "%controller".to_string(),
                from_port: TilePort::Left,
                to_tile_id: "%browser".to_string(),
                to_port: TilePort::Left,
            },
            NetworkConnection {
                session_id: "$1".to_string(),
                from_tile_id: "%observer".to_string(),
                from_port: TilePort::Left,
                to_tile_id: "%browser".to_string(),
                to_port: TilePort::Right,
            },
        ];

        assert_eq!(
            rpc_access_for_sender_to_tile(Some("%browser"), "%browser", NetworkTileKind::Browser, &connections),
            TileRpcAccess::Read
        );
        assert_eq!(
            rpc_access_for_sender_to_tile(Some("%controller"), "%browser", NetworkTileKind::Browser, &connections),
            TileRpcAccess::ReadWrite
        );
        assert_eq!(
            rpc_access_for_sender_to_tile(Some("%observer"), "%browser", NetworkTileKind::Browser, &connections),
            TileRpcAccess::ReadWrite
        );
        assert_eq!(
            rpc_access_for_sender_to_tile(Some("%observer"), "%shell", NetworkTileKind::Shell, &connections),
            TileRpcAccess::Read
        );
    }

    #[test]
    fn keeps_agent_tiles_read_only_over_direct_network_connections() {
        let connections = vec![
            NetworkConnection {
                session_id: "$1".to_string(),
                from_tile_id: "%worker-a".to_string(),
                from_port: TilePort::Left,
                to_tile_id: "%worker-b".to_string(),
                to_port: TilePort::Right,
            },
            NetworkConnection {
                session_id: "$1".to_string(),
                from_tile_id: "%worker-a".to_string(),
                from_port: TilePort::Top,
                to_tile_id: "%root".to_string(),
                to_port: TilePort::Bottom,
            },
        ];

        assert_eq!(
            rpc_access_for_sender_to_tile(Some("%worker-a"), "%worker-b", NetworkTileKind::Agent, &connections),
            TileRpcAccess::Read
        );
        assert_eq!(
            rpc_access_for_sender_to_tile(Some("%worker-a"), "%root", NetworkTileKind::RootAgent, &connections),
            TileRpcAccess::Read
        );
        assert_eq!(
            responds_to_for_access(NetworkTileKind::Agent, TileRpcAccess::Read),
            vec!["get", "call", "output_read"]
        );
        assert_eq!(
            responds_to_for_access(NetworkTileKind::RootAgent, TileRpcAccess::Read),
            vec!["get", "call", "output_read"]
        );
    }

    #[test]
    fn rejects_invalid_connection_shapes_and_enforces_port_uniqueness() {
        let path = temp_db_path("validation");
        let shell_a = NetworkTileDescriptor {
            tile_id: "%1".to_string(),
            session_id: "$1".to_string(),
            kind: NetworkTileKind::Shell,
        };
        let shell_b = NetworkTileDescriptor {
            tile_id: "%2".to_string(),
            session_id: "$1".to_string(),
            kind: NetworkTileKind::Shell,
        };
        let work = NetworkTileDescriptor {
            tile_id: "AbCdEf".to_string(),
            session_id: "$1".to_string(),
            kind: NetworkTileKind::Work,
        };
        let other_work = NetworkTileDescriptor {
            tile_id: "XyZaBc".to_string(),
            session_id: "$1".to_string(),
            kind: NetworkTileKind::Work,
        };
        let agent = NetworkTileDescriptor {
            tile_id: "%3".to_string(),
            session_id: "$1".to_string(),
            kind: NetworkTileKind::Agent,
        };

        let error = connect_at(&path, &work, TilePort::Top, &work, TilePort::Right).unwrap_err();
        assert!(error.contains("cannot connect a tile to itself"));

        let error = connect_at(&path, &work, TilePort::Top, &other_work, TilePort::Right).unwrap_err();
        assert!(error.contains("read-only"));

        let error = connect_at(&path, &work, TilePort::Left, &shell_a, TilePort::Top).unwrap_err();
        assert!(error.contains("only accepts agent"));

        connect_at(&path, &agent, TilePort::Left, &shell_a, TilePort::Right).unwrap();
        let error = connect_at(&path, &shell_b, TilePort::Left, &agent, TilePort::Left).unwrap_err();
        assert!(error.contains("already connected"));
    }

    #[test]
    fn derives_session_local_components_and_singletons() {
        let path = temp_db_path("components");
        let a = NetworkTileDescriptor {
            tile_id: "%1".to_string(),
            session_id: "$1".to_string(),
            kind: NetworkTileKind::Agent,
        };
        let b = NetworkTileDescriptor {
            tile_id: "%2".to_string(),
            session_id: "$1".to_string(),
            kind: NetworkTileKind::Shell,
        };
        let c = NetworkTileDescriptor {
            tile_id: "%3".to_string(),
            session_id: "$1".to_string(),
            kind: NetworkTileKind::Agent,
        };
        let isolated = NetworkTileDescriptor {
            tile_id: "%4".to_string(),
            session_id: "$1".to_string(),
            kind: NetworkTileKind::Shell,
        };
        let foreign = NetworkTileDescriptor {
            tile_id: "%5".to_string(),
            session_id: "$2".to_string(),
            kind: NetworkTileKind::Shell,
        };

        connect_at(&path, &a, TilePort::Right, &b, TilePort::Left).unwrap();
        connect_at(&path, &b, TilePort::Top, &c, TilePort::Bottom).unwrap();

        let session_tiles = vec![
            session_tile(&a.tile_id, "$1", a.kind),
            session_tile(&b.tile_id, "$1", b.kind),
            session_tile(&c.tile_id, "$1", c.kind),
            session_tile(&isolated.tile_id, "$1", isolated.kind),
        ];
        let component = component_for_tile("$1", &a.tile_id, &session_tiles, &list_connections_at(&path, "$1").unwrap());
        assert_eq!(
            component.tiles.iter().map(|tile| tile.tile_id.as_str()).collect::<BTreeSet<_>>(),
            BTreeSet::from(["%1", "%2", "%3"])
        );

        let singleton = component_for_tile("$1", &isolated.tile_id, &session_tiles, &list_connections_at(&path, "$1").unwrap());
        assert_eq!(singleton.tiles.len(), 1);
        assert_eq!(singleton.tiles[0].tile_id, isolated.tile_id);
        assert!(list_connections_at(&path, "$2").unwrap().is_empty());
        let _ = foreign;
    }

    #[test]
    fn filters_components_by_requested_tile_type() {
        let component = super::NetworkComponent {
            session_id: "$1".to_string(),
            sender_tile_id: Some("%1".to_string()),
            tiles: vec![
                session_tile("%1", "$1", NetworkTileKind::Agent),
                session_tile("%2", "$1", NetworkTileKind::Shell),
                session_tile("AbCdEf", "$1", NetworkTileKind::Work),
            ],
            connections: vec![
                super::NetworkConnection {
                    session_id: "$1".to_string(),
                    from_tile_id: "%1".to_string(),
                    from_port: TilePort::Left,
                    to_tile_id: "%2".to_string(),
                    to_port: TilePort::Right,
                },
                super::NetworkConnection {
                    session_id: "$1".to_string(),
                    from_tile_id: "%1".to_string(),
                    from_port: TilePort::Top,
                    to_tile_id: "AbCdEf".to_string(),
                    to_port: TilePort::Left,
                },
            ],
        };

        let filtered = filter_component(component, Some(TileTypeFilter::Agent));
        assert_eq!(filtered.tiles.len(), 1);
        assert_eq!(filtered.tiles[0].tile_id, "%1");
        assert!(filtered.connections.is_empty());
    }

    #[test]
    fn derives_work_owner_from_live_agent_connection_and_clears_on_disconnect() {
        let path = temp_db_path("owner");
        replace_agents(&path, vec![agent("%1", "$1", "agent-1")]);
        let project_root = std::env::temp_dir().join(format!("herd-network-owner-project-{}", std::process::id()));
        let _ = fs::remove_dir_all(&project_root);
        fs::create_dir_all(&project_root).unwrap();
        let created = work::create_work_item_at(&path, "$1", "Owned item").unwrap();
        let work = NetworkTileDescriptor {
            tile_id: created.tile_id.clone(),
            session_id: "$1".to_string(),
            kind: NetworkTileKind::Work,
        };
        let agent_tile = NetworkTileDescriptor {
            tile_id: "%1".to_string(),
            session_id: "$1".to_string(),
            kind: NetworkTileKind::Agent,
        };

        connect_at(&path, &agent_tile, TilePort::Left, &work, TilePort::Left).unwrap();
        assert_eq!(
            derived_work_owner_agent_id_at(&path, "$1", &created.work_id).unwrap(),
            Some("agent-1".to_string())
        );

        let removed = disconnect_all_for_tile_at(&path, "$1", "%1").unwrap();
        assert_eq!(removed.len(), 1);
        assert_eq!(derived_work_owner_agent_id_at(&path, "$1", &created.work_id).unwrap(), None);
    }
}
