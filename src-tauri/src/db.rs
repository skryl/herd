use std::fs;
use rusqlite::{params, Connection};
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::agent::{now_ms, AgentInfo, AgentRole, AgentType};
use crate::runtime;

const SCHEMA_SQL: &str = r#"
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS tile_state (
  pane_id TEXT PRIMARY KEY,
  x REAL NOT NULL,
  y REAL NOT NULL,
  width REAL NOT NULL,
  height REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS tile_registry (
  tile_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  window_id TEXT NOT NULL,
  pane_id TEXT NOT NULL,
  browser_incognito INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chatter (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  entry_json TEXT NOT NULL,
  timestamp_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  tile_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  entry_json TEXT NOT NULL,
  timestamp_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tile_message_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  wrapper_command TEXT NOT NULL,
  message_name TEXT NOT NULL,
  outcome TEXT NOT NULL,
  entry_json TEXT NOT NULL,
  timestamp_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent (
  agent_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  tile_id TEXT NOT NULL,
  data_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS topic (
  name TEXT PRIMARY KEY,
  data_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS network_connection (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  from_tile_id TEXT NOT NULL,
  from_port TEXT NOT NULL,
  to_tile_id TEXT NOT NULL,
  to_port TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS work_item (
  work_id TEXT PRIMARY KEY,
  tile_id TEXT,
  session_id TEXT NOT NULL,
  title TEXT NOT NULL,
  owner_agent_id TEXT,
  current_stage TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS work_stage (
  work_id TEXT NOT NULL,
  stage_name TEXT NOT NULL,
  status TEXT NOT NULL,
  content TEXT NOT NULL,
  PRIMARY KEY (work_id, stage_name)
);

CREATE TABLE IF NOT EXISTS work_review (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id TEXT NOT NULL,
  stage_name TEXT NOT NULL,
  decision TEXT NOT NULL,
  comment TEXT,
  created_at INTEGER NOT NULL
);
"#;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PersistedChannelRecord {
    #[serde(default)]
    pub session_id: String,
    pub name: String,
    pub subscribers: Vec<String>,
    pub last_activity_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct PersistedAgentInfo {
    agent_id: String,
    #[serde(default)]
    agent_type: AgentType,
    #[serde(default)]
    agent_role: AgentRole,
    tile_id: String,
    #[serde(default)]
    pane_id: String,
    window_id: String,
    session_id: String,
    title: String,
    display_name: String,
    alive: bool,
    chatter_subscribed: bool,
    #[serde(default)]
    channels: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent_pid: Option<u32>,
}

impl From<PersistedAgentInfo> for AgentInfo {
    fn from(value: PersistedAgentInfo) -> Self {
        Self {
            agent_id: value.agent_id,
            agent_type: value.agent_type,
            agent_role: value.agent_role,
            tile_id: value.tile_id,
            pane_id: value.pane_id,
            window_id: value.window_id,
            session_id: value.session_id,
            title: value.title,
            display_name: value.display_name,
            alive: value.alive,
            chatter_subscribed: value.chatter_subscribed,
            channels: value.channels,
            agent_pid: value.agent_pid,
        }
    }
}

impl From<&AgentInfo> for PersistedAgentInfo {
    fn from(value: &AgentInfo) -> Self {
        Self {
            agent_id: value.agent_id.clone(),
            agent_type: value.agent_type,
            agent_role: value.agent_role,
            tile_id: value.tile_id.clone(),
            pane_id: value.pane_id.clone(),
            window_id: value.window_id.clone(),
            session_id: value.session_id.clone(),
            title: value.title.clone(),
            display_name: value.display_name.clone(),
            alive: value.alive,
            chatter_subscribed: value.chatter_subscribed,
            channels: value.channels.clone(),
            agent_pid: value.agent_pid,
        }
    }
}

pub fn open() -> Result<Connection, String> {
    open_at(Path::new(runtime::database_path()))
}

pub fn open_at(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    }
    let mut conn = Connection::open(path)
        .map_err(|error| format!("failed to open sqlite db {}: {error}", path.display()))?;
    conn.execute_batch(SCHEMA_SQL)
        .map_err(|error| format!("failed to initialize sqlite schema {}: {error}", path.display()))?;
    ensure_optional_work_item_tile_id_column(&conn)?;
    ensure_tile_registry_browser_incognito_column(&conn)?;
    ensure_work_stage_content_storage(&mut conn)?;
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_work_item_tile_id ON work_item(tile_id)",
        [],
    )
    .map_err(|error| format!("failed to ensure work item tile_id index {}: {error}", path.display()))?;
    Ok(conn)
}

fn table_has_column(conn: &Connection, table_name: &str, column_name: &str) -> Result<bool, String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table_name})"))
        .map_err(|error| format!("failed to inspect sqlite table {table_name}: {error}"))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| format!("failed to query sqlite table info for {table_name}: {error}"))?;
    for row in rows {
        if row.map_err(|error| format!("failed to decode sqlite table info for {table_name}: {error}"))? == column_name {
            return Ok(true);
        }
    }
    Ok(false)
}

fn ensure_optional_work_item_tile_id_column(conn: &Connection) -> Result<(), String> {
    if table_has_column(conn, "work_item", "tile_id")? {
        return Ok(());
    }
    conn.execute("ALTER TABLE work_item ADD COLUMN tile_id TEXT", [])
        .map_err(|error| format!("failed to add work_item.tile_id column: {error}"))?;
    Ok(())
}

fn ensure_tile_registry_browser_incognito_column(conn: &Connection) -> Result<(), String> {
    if table_has_column(conn, "tile_registry", "browser_incognito")? {
        return Ok(());
    }
    conn.execute(
        "ALTER TABLE tile_registry ADD COLUMN browser_incognito INTEGER NOT NULL DEFAULT 0",
        [],
    )
    .map_err(|error| format!("failed to add tile_registry.browser_incognito column: {error}"))?;
    Ok(())
}

fn ensure_work_stage_content_storage(conn: &mut Connection) -> Result<(), String> {
    let has_content = table_has_column(conn, "work_stage", "content")?;
    let has_file_path = table_has_column(conn, "work_stage", "file_path")?;
    if has_content && !has_file_path {
        return Ok(());
    }
    if !has_content && !has_file_path {
        return Err("work_stage is missing both content and file_path columns".to_string());
    }

    let tx = conn
        .transaction()
        .map_err(|error| format!("failed to begin work_stage migration transaction: {error}"))?;
    tx.execute(
        "CREATE TABLE work_stage_new (
          work_id TEXT NOT NULL,
          stage_name TEXT NOT NULL,
          status TEXT NOT NULL,
          content TEXT NOT NULL,
          PRIMARY KEY (work_id, stage_name)
        )",
        [],
    )
    .map_err(|error| format!("failed to create migrated work_stage table: {error}"))?;

    if has_content {
        let mut stmt = tx
            .prepare("SELECT work_id, stage_name, status, content FROM work_stage ORDER BY work_id ASC, stage_name ASC")
            .map_err(|error| format!("failed to prepare work_stage content migration query: {error}"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|error| format!("failed to query work_stage content rows: {error}"))?;
        for row in rows {
            let (work_id, stage_name, status, content) =
                row.map_err(|error| format!("failed to decode work_stage content row: {error}"))?;
            tx.execute(
                "INSERT INTO work_stage_new (work_id, stage_name, status, content) VALUES (?1, ?2, ?3, ?4)",
                params![work_id, stage_name, status, content],
            )
            .map_err(|error| format!("failed to insert migrated work_stage content row: {error}"))?;
        }
    } else {
        let mut stmt = tx
            .prepare("SELECT work_id, stage_name, status, file_path FROM work_stage ORDER BY work_id ASC, stage_name ASC")
            .map_err(|error| format!("failed to prepare legacy work_stage migration query: {error}"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|error| format!("failed to query legacy work_stage rows: {error}"))?;
        for row in rows {
            let (work_id, stage_name, status, file_path) =
                row.map_err(|error| format!("failed to decode legacy work_stage row: {error}"))?;
            let content = match fs::read_to_string(&file_path) {
                Ok(content) => content,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    missing_legacy_work_stage_content(&file_path)
                }
                Err(error) => {
                    return Err(format!("failed to migrate legacy work stage file {file_path}: {error}"));
                }
            };
            tx.execute(
                "INSERT INTO work_stage_new (work_id, stage_name, status, content) VALUES (?1, ?2, ?3, ?4)",
                params![work_id, stage_name, status, content],
            )
            .map_err(|error| format!("failed to insert migrated legacy work_stage row: {error}"))?;
        }
    }

    tx.execute("DROP TABLE work_stage", [])
        .map_err(|error| format!("failed to drop legacy work_stage table: {error}"))?;
    tx.execute("ALTER TABLE work_stage_new RENAME TO work_stage", [])
        .map_err(|error| format!("failed to rename migrated work_stage table: {error}"))?;
    tx.commit()
        .map_err(|error| format!("failed to commit work_stage migration transaction: {error}"))?;
    Ok(())
}

fn missing_legacy_work_stage_content(file_path: &str) -> String {
    format!(
        "# Missing legacy work stage content\n\nHerd migrated this work stage into SQLite after removing the legacy `work/` directory, but the previous file was already missing.\n\nLegacy path: {file_path}\n"
    )
}

pub fn load_agents() -> Result<Vec<AgentInfo>, String> {
    load_agents_at(Path::new(runtime::database_path()))
}

pub fn load_agents_at(path: &Path) -> Result<Vec<AgentInfo>, String> {
    let conn = open_at(path)?;
    let mut stmt = conn
        .prepare("SELECT data_json FROM agent ORDER BY updated_at, agent_id")
        .map_err(|error| format!("failed to prepare agent query: {error}"))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("failed to query agents: {error}"))?;
    let mut agents = Vec::new();
    for row in rows {
        let json = row.map_err(|error| format!("failed to decode agent row: {error}"))?;
        let agent = serde_json::from_str::<PersistedAgentInfo>(&json)
            .map_err(|error| format!("failed to parse agent json: {error}"))?;
        agents.push(agent.into());
    }
    Ok(agents)
}

pub fn replace_agents(agents: &[AgentInfo]) -> Result<(), String> {
    replace_agents_at(Path::new(runtime::database_path()), agents)
}

pub fn replace_agents_at(path: &Path, agents: &[AgentInfo]) -> Result<(), String> {
    let mut conn = open_at(path)?;
    let tx = conn
        .transaction()
        .map_err(|error| format!("failed to begin agent transaction: {error}"))?;
    tx.execute("DELETE FROM agent", [])
        .map_err(|error| format!("failed to clear agent rows: {error}"))?;
    let updated_at = now_ms();
    for agent in agents {
        let data_json = serde_json::to_string(&PersistedAgentInfo::from(agent))
            .map_err(|error| format!("failed to serialize agent {}: {error}", agent.agent_id))?;
        tx.execute(
            "INSERT INTO agent (agent_id, session_id, tile_id, data_json, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![agent.agent_id, agent.session_id, agent.tile_id, data_json, updated_at],
        )
        .map_err(|error| format!("failed to insert agent {}: {error}", agent.agent_id))?;
    }
    tx.commit()
        .map_err(|error| format!("failed to commit agent transaction: {error}"))?;
    Ok(())
}

pub fn load_channels() -> Result<Vec<PersistedChannelRecord>, String> {
    load_channels_at(Path::new(runtime::database_path()))
}

pub fn load_channels_at(path: &Path) -> Result<Vec<PersistedChannelRecord>, String> {
    let conn = open_at(path)?;
    let mut stmt = conn
        .prepare("SELECT data_json FROM topic ORDER BY name")
        .map_err(|error| format!("failed to prepare topic query: {error}"))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("failed to query channels: {error}"))?;
    let mut channels = Vec::new();
    for row in rows {
        let json = row.map_err(|error| format!("failed to decode topic row: {error}"))?;
        let channel = serde_json::from_str::<PersistedChannelRecord>(&json)
            .map_err(|error| format!("failed to parse topic json: {error}"))?;
        channels.push(channel);
    }
    Ok(channels)
}

pub fn replace_channels(channels: &[PersistedChannelRecord]) -> Result<(), String> {
    replace_channels_at(Path::new(runtime::database_path()), channels)
}

pub fn replace_channels_at(path: &Path, channels: &[PersistedChannelRecord]) -> Result<(), String> {
    let mut conn = open_at(path)?;
    let tx = conn
        .transaction()
        .map_err(|error| format!("failed to begin topic transaction: {error}"))?;
    tx.execute("DELETE FROM topic", [])
        .map_err(|error| format!("failed to clear topic rows: {error}"))?;
    let updated_at = now_ms();
    for channel in channels {
        let data_json = serde_json::to_string(channel)
            .map_err(|error| format!("failed to serialize topic {}: {error}", channel.name))?;
        let storage_key = format!("{}::{}", channel.session_id, channel.name);
        tx.execute(
            "INSERT INTO topic (name, data_json, updated_at) VALUES (?1, ?2, ?3)",
            params![storage_key, data_json, updated_at],
        )
        .map_err(|error| format!("failed to insert topic {}: {error}", channel.name))?;
    }
    tx.commit()
        .map_err(|error| format!("failed to commit topic transaction: {error}"))?;
    Ok(())
}

pub fn reset_runtime_presence_state() -> Result<(), String> {
    reset_runtime_presence_state_at(Path::new(runtime::database_path()))
}

pub fn reset_runtime_presence_state_at(path: &Path) -> Result<(), String> {
    let mut agents = load_agents_at(path)?;
    for agent in &mut agents {
        agent.alive = false;
    }
    replace_agents_at(path, &agents)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        load_agents_at, load_channels_at, open_at, replace_agents_at, replace_channels_at,
        reset_runtime_presence_state_at, PersistedChannelRecord,
    };
    use crate::agent::{AgentInfo, AgentRole, AgentType};
    use rusqlite::{params, Connection};
    use std::fs;
    use std::path::PathBuf;

    fn temp_db_path(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("herd-db-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root.join("herd.sqlite")
    }

    #[test]
    fn initializes_expected_schema_tables() {
        let path = temp_db_path("schema");
        let conn = open_at(&path).unwrap();
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap();
        let names = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

        assert!(names.contains(&"tile_state".to_string()));
        assert!(names.contains(&"chatter".to_string()));
        assert!(names.contains(&"agent_log".to_string()));
        assert!(names.contains(&"tile_message_log".to_string()));
        assert!(names.contains(&"agent".to_string()));
        assert!(names.contains(&"topic".to_string()));
        assert!(names.contains(&"network_connection".to_string()));
        assert!(names.contains(&"work_item".to_string()));
        assert!(names.contains(&"work_stage".to_string()));
        assert!(names.contains(&"work_review".to_string()));
        assert!(names.contains(&"tile_registry".to_string()));

        let _ = fs::remove_file(path);
    }

    #[test]
    fn agents_and_channels_round_trip_through_sqlite() {
        let path = temp_db_path("registry");
        let agents = vec![AgentInfo {
            agent_id: "agent-1".to_string(),
            agent_type: AgentType::Claude,
            agent_role: AgentRole::Worker,
            tile_id: "%1".to_string(),
            pane_id: "%1".to_string(),
            window_id: "@1".to_string(),
            session_id: "$1".to_string(),
            title: "Agent".to_string(),
            display_name: "Agent 1".to_string(),
            alive: true,
            chatter_subscribed: true,
            channels: vec!["#work-s1-001".to_string()],
            agent_pid: Some(42),
        }];
        let channels = vec![PersistedChannelRecord {
            session_id: "$1".to_string(),
            name: "#work-s1-001".to_string(),
            subscribers: vec!["agent-1".to_string()],
            last_activity_at: Some(123),
        }, PersistedChannelRecord {
            session_id: "$2".to_string(),
            name: "#work-s1-001".to_string(),
            subscribers: vec!["agent-2".to_string()],
            last_activity_at: Some(456),
        }];

        replace_agents_at(&path, &agents).unwrap();
        replace_channels_at(&path, &channels).unwrap();

        assert_eq!(load_agents_at(&path).unwrap(), agents);
        assert_eq!(load_channels_at(&path).unwrap(), channels);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn startup_reset_clears_alive_agents() {
        let path = temp_db_path("reset");
        let agents = vec![AgentInfo {
            agent_id: "agent-1".to_string(),
            agent_type: AgentType::Claude,
            agent_role: AgentRole::Worker,
            tile_id: "%1".to_string(),
            pane_id: "%1".to_string(),
            window_id: "@1".to_string(),
            session_id: "$1".to_string(),
            title: "Agent".to_string(),
            display_name: "Agent 1".to_string(),
            alive: true,
            chatter_subscribed: true,
            channels: vec![],
            agent_pid: None,
        }];
        replace_agents_at(&path, &agents).unwrap();

        let conn = open_at(&path).unwrap();
        conn.execute(
            "INSERT INTO work_item (work_id, session_id, title, owner_agent_id, current_stage, data_json, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params!["work-s1-001", "$1", "Socket refactor", "agent-1", "plan", "{}", 1i64, 1i64],
        )
        .unwrap();

        reset_runtime_presence_state_at(&path).unwrap();

        let loaded_agents = load_agents_at(&path).unwrap();
        assert_eq!(loaded_agents.len(), 1);
        assert!(!loaded_agents[0].alive);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn migrates_legacy_work_stage_file_paths_into_sqlite_content() {
        let root = std::env::temp_dir().join(format!("herd-db-work-migrate-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("work/session-1/work-s1-001")).unwrap();
        let path = root.join("herd.sqlite");
        let legacy_file = root.join("work/session-1/work-s1-001/plan.md");
        fs::write(&legacy_file, "# Migrated plan\n\nStored in sqlite now.\n").unwrap();

        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE work_stage (
              work_id TEXT NOT NULL,
              stage_name TEXT NOT NULL,
              status TEXT NOT NULL,
              file_path TEXT NOT NULL,
              PRIMARY KEY (work_id, stage_name)
            );
            "#,
        )
        .unwrap();
        conn.execute(
            "INSERT INTO work_stage (work_id, stage_name, status, file_path) VALUES (?1, ?2, ?3, ?4)",
            params!["work-s1-001", "plan", "ready", legacy_file.to_string_lossy().to_string()],
        )
        .unwrap();
        drop(conn);

        let migrated = open_at(&path).unwrap();
        let content = migrated
            .query_row(
                "SELECT content FROM work_stage WHERE work_id = ?1 AND stage_name = ?2",
                params!["work-s1-001", "plan"],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        assert_eq!(content, "# Migrated plan\n\nStored in sqlite now.\n");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn migrates_missing_legacy_work_stage_files_to_placeholder_content() {
        let root = std::env::temp_dir().join(format!("herd-db-work-migrate-missing-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let path = root.join("herd.sqlite");
        let missing_file = root.join("work/session-1/work-s1-001/plan.md");

        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE work_stage (
              work_id TEXT NOT NULL,
              stage_name TEXT NOT NULL,
              status TEXT NOT NULL,
              file_path TEXT NOT NULL,
              PRIMARY KEY (work_id, stage_name)
            );
            "#,
        )
        .unwrap();
        conn.execute(
            "INSERT INTO work_stage (work_id, stage_name, status, file_path) VALUES (?1, ?2, ?3, ?4)",
            params!["work-s1-001", "plan", "ready", missing_file.to_string_lossy().to_string()],
        )
        .unwrap();
        drop(conn);

        let migrated = open_at(&path).unwrap();
        let content = migrated
            .query_row(
                "SELECT content FROM work_stage WHERE work_id = ?1 AND stage_name = ?2",
                params!["work-s1-001", "plan"],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        assert!(content.contains("Missing legacy work stage content"));
        assert!(content.contains(&missing_file.to_string_lossy().to_string()));

        let _ = fs::remove_dir_all(root);
    }
}
