use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

use crate::agent::{AgentLogEntry, AgentLogKind, ChatterEntry};
use crate::db;
use crate::runtime;
use crate::tile_message::{TileMessageLogEntry, TileMessageOutcome};

/// Tile metadata that gets persisted across Herd restarts.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct TileState {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Maps tmux pane ID -> tile state.
pub type HerdState = HashMap<String, TileState>;

fn database_path() -> String {
    runtime::database_path().to_string()
}

pub fn load() -> HerdState {
    load_from_path(Path::new(&database_path())).unwrap_or_default()
}

pub fn load_from_path(path: &Path) -> Result<HerdState, String> {
    let conn = db::open_at(path)?;
    let mut stmt = conn
        .prepare("SELECT pane_id, x, y, width, height FROM tile_state")
        .map_err(|error| format!("failed to prepare tile_state query: {error}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                TileState {
                    x: row.get(1)?,
                    y: row.get(2)?,
                    width: row.get(3)?,
                    height: row.get(4)?,
                },
            ))
        })
        .map_err(|error| format!("failed to query tile_state: {error}"))?;

    let mut state = HashMap::new();
    for row in rows {
        let (pane_id, tile) = row.map_err(|error| format!("failed to decode tile_state row: {error}"))?;
        state.insert(pane_id, tile);
    }
    Ok(state)
}

pub fn save(state: &HerdState) {
    if let Err(error) = save_to_path(Path::new(&database_path()), state) {
        log::warn!("Failed to save herd state to sqlite: {error}");
    }
}

pub fn save_to_path(path: &Path, state: &HerdState) -> Result<(), String> {
    let mut conn = db::open_at(path)?;
    let tx = conn
        .transaction()
        .map_err(|error| format!("failed to begin tile_state transaction: {error}"))?;
    tx.execute("DELETE FROM tile_state", [])
        .map_err(|error| format!("failed to clear tile_state rows: {error}"))?;
    for (pane_id, tile) in state {
        tx.execute(
            "INSERT INTO tile_state (pane_id, x, y, width, height) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![pane_id, tile.x, tile.y, tile.width, tile.height],
        )
        .map_err(|error| format!("failed to insert tile_state row {pane_id}: {error}"))?;
    }
    tx.commit()
        .map_err(|error| format!("failed to commit tile_state transaction: {error}"))?;
    Ok(())
}

pub fn load_chatter_entries() -> Vec<ChatterEntry> {
    load_chatter_entries_from_path(Path::new(&database_path())).unwrap_or_default()
}

pub fn load_agent_log_entries() -> Vec<AgentLogEntry> {
    load_agent_log_entries_from_path(Path::new(&database_path())).unwrap_or_default()
}

pub fn load_tile_message_log_entries() -> Vec<TileMessageLogEntry> {
    load_tile_message_log_entries_from_path(Path::new(&database_path())).unwrap_or_default()
}

pub fn load_chatter_entries_from_path(path: &Path) -> Result<Vec<ChatterEntry>, String> {
    let conn = db::open_at(path)?;
    let mut stmt = conn
        .prepare("SELECT entry_json FROM chatter ORDER BY id")
        .map_err(|error| format!("failed to prepare chatter query: {error}"))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("failed to query chatter rows: {error}"))?;

    let mut entries = Vec::new();
    for row in rows {
        let json = row.map_err(|error| format!("failed to decode chatter row: {error}"))?;
        let entry = serde_json::from_str::<ChatterEntry>(&json)
            .map_err(|error| format!("failed to parse chatter entry json: {error}"))?;
        entries.push(entry);
    }
    Ok(entries)
}

pub fn load_agent_log_entries_from_path(path: &Path) -> Result<Vec<AgentLogEntry>, String> {
    let conn = db::open_at(path)?;
    let mut stmt = conn
        .prepare("SELECT entry_json FROM agent_log ORDER BY id")
        .map_err(|error| format!("failed to prepare agent_log query: {error}"))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("failed to query agent_log rows: {error}"))?;

    let mut entries = Vec::new();
    for row in rows {
        let json = row.map_err(|error| format!("failed to decode agent_log row: {error}"))?;
        let entry = serde_json::from_str::<AgentLogEntry>(&json)
            .map_err(|error| format!("failed to parse agent_log entry json: {error}"))?;
        entries.push(entry);
    }
    Ok(entries)
}

pub fn load_tile_message_log_entries_from_path(path: &Path) -> Result<Vec<TileMessageLogEntry>, String> {
    let conn = db::open_at(path)?;
    let mut stmt = conn
        .prepare("SELECT entry_json FROM tile_message_log ORDER BY id")
        .map_err(|error| format!("failed to prepare tile_message_log query: {error}"))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("failed to query tile_message_log rows: {error}"))?;

    let mut entries = Vec::new();
    for row in rows {
        let json = row.map_err(|error| format!("failed to decode tile_message_log row: {error}"))?;
        let entry = serde_json::from_str::<TileMessageLogEntry>(&json)
            .map_err(|error| format!("failed to parse tile_message_log entry json: {error}"))?;
        entries.push(entry);
    }
    Ok(entries)
}

pub fn append_chatter_entry(entry: &ChatterEntry) -> Result<(), String> {
    append_chatter_entry_to_path(Path::new(&database_path()), entry)
}

pub fn append_agent_log_entry(entry: &AgentLogEntry) -> Result<(), String> {
    append_agent_log_entry_to_path(Path::new(&database_path()), entry)
}

pub fn append_tile_message_log_entry(entry: &TileMessageLogEntry) -> Result<(), String> {
    append_tile_message_log_entry_to_path(Path::new(&database_path()), entry)
}

pub fn clear_log_entries() -> Result<(), String> {
    clear_log_entries_at_path(Path::new(&database_path()))
}

pub fn append_chatter_entry_to_path(path: &Path, entry: &ChatterEntry) -> Result<(), String> {
    let conn = db::open_at(path)?;
    let entry_json = serde_json::to_string(entry)
        .map_err(|error| format!("failed to serialize chatter entry: {error}"))?;
    let kind = match entry.kind {
        crate::agent::ChatterKind::Direct => "direct",
        crate::agent::ChatterKind::Public => "public",
        crate::agent::ChatterKind::Channel => "channel",
        crate::agent::ChatterKind::Network => "network",
        crate::agent::ChatterKind::Root => "root",
        crate::agent::ChatterKind::SignOn => "sign_on",
        crate::agent::ChatterKind::SignOff => "sign_off",
    };
    conn.execute(
        "INSERT INTO chatter (kind, entry_json, timestamp_ms) VALUES (?1, ?2, ?3)",
        params![kind, entry_json, entry.timestamp_ms],
    )
    .map_err(|error| format!("failed to insert chatter entry: {error}"))?;
    Ok(())
}

pub fn append_agent_log_entry_to_path(path: &Path, entry: &AgentLogEntry) -> Result<(), String> {
    let conn = db::open_at(path)?;
    let entry_json = serde_json::to_string(entry)
        .map_err(|error| format!("failed to serialize agent log entry: {error}"))?;
    let kind = match entry.kind {
        AgentLogKind::IncomingHook => "incoming_hook",
        AgentLogKind::OutgoingCall => "outgoing_call",
    };
    conn.execute(
        "INSERT INTO agent_log (agent_id, tile_id, kind, entry_json, timestamp_ms) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![entry.agent_id, entry.tile_id, kind, entry_json, entry.timestamp_ms],
    )
    .map_err(|error| format!("failed to insert agent log entry: {error}"))?;
    Ok(())
}

pub fn append_tile_message_log_entry_to_path(path: &Path, entry: &TileMessageLogEntry) -> Result<(), String> {
    let conn = db::open_at(path)?;
    let entry_json = serde_json::to_string(entry)
        .map_err(|error| format!("failed to serialize tile message log entry: {error}"))?;
    let outcome = match entry.outcome {
        TileMessageOutcome::Ok => "ok",
        TileMessageOutcome::NotFound => "not_found",
        TileMessageOutcome::Error => "error",
    };
    conn.execute(
        "INSERT INTO tile_message_log (session_id, target_id, target_kind, wrapper_command, message_name, outcome, entry_json, timestamp_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            entry.session_id,
            entry.target_id,
            entry.target_kind,
            entry.wrapper_command,
            entry.message_name,
            outcome,
            entry_json,
            entry.timestamp_ms,
        ],
    )
    .map_err(|error| format!("failed to insert tile message log entry: {error}"))?;
    Ok(())
}

pub fn clear_log_entries_at_path(path: &Path) -> Result<(), String> {
    let conn = db::open_at(path)?;
    conn.execute("DELETE FROM chatter", [])
        .map_err(|error| format!("failed to clear chatter entries: {error}"))?;
    conn.execute("DELETE FROM agent_log", [])
        .map_err(|error| format!("failed to clear agent log entries: {error}"))?;
    conn.execute("DELETE FROM tile_message_log", [])
        .map_err(|error| format!("failed to clear tile message log entries: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        append_agent_log_entry_to_path, append_chatter_entry_to_path, append_tile_message_log_entry_to_path,
        clear_log_entries_at_path, load_agent_log_entries_from_path, load_chatter_entries_from_path, load_from_path,
        load_tile_message_log_entries_from_path, save_to_path,
        HerdState, TileState,
    };
    use crate::agent::{AgentLogEntry, AgentLogKind, ChatterEntry, ChatterKind};
    use crate::tile_message::{TileMessageChannel, TileMessageLogEntry, TileMessageLogLayer, TileMessageOutcome};
    use std::collections::HashMap;
    use std::fs;
    use std::path::PathBuf;

    fn temp_db_path(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("herd-persist-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root.join("herd.sqlite")
    }

    #[test]
    fn tile_state_round_trips_through_sqlite() {
        let path = temp_db_path("tile-state");
        let mut state: HerdState = HashMap::new();
        state.insert(
            "%1".to_string(),
            TileState {
                x: 12.0,
                y: 24.0,
                width: 640.0,
                height: 400.0,
            },
        );

        save_to_path(&path, &state).unwrap();
        let loaded = load_from_path(&path).unwrap();
        assert_eq!(loaded, state);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn chatter_entries_round_trip_through_sqlite() {
        let path = temp_db_path("chatter");
        let entry = ChatterEntry {
            session_id: "$1".to_string(),
            kind: ChatterKind::Public,
            from_agent_id: Some("agent-1".to_string()),
            from_display_name: "Agent 1".to_string(),
            to_agent_id: None,
            to_display_name: None,
            message: "Starting #work-s1-001".to_string(),
            channels: vec!["#work-s1-001".to_string()],
            mentions: vec![],
            timestamp_ms: 42,
            public: true,
            display_text: "Agent 1 -> Chatter: Starting #work-s1-001".to_string(),
        };

        append_chatter_entry_to_path(&path, &entry).unwrap();
        let loaded = load_chatter_entries_from_path(&path).unwrap();
        assert_eq!(loaded, vec![entry]);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn agent_log_entries_round_trip_through_sqlite() {
        let path = temp_db_path("agent-log");
        let entry = AgentLogEntry {
            session_id: "$1".to_string(),
            agent_id: "agent-1".to_string(),
            tile_id: "%1".to_string(),
            kind: AgentLogKind::IncomingHook,
            text: "MCP hook [direct] hello".to_string(),
            timestamp_ms: 84,
        };

        append_agent_log_entry_to_path(&path, &entry).unwrap();
        let loaded = load_agent_log_entries_from_path(&path).unwrap();
        assert_eq!(loaded, vec![entry]);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn tile_message_log_entries_round_trip_through_sqlite() {
        let path = temp_db_path("tile-message-log");
        let entry = TileMessageLogEntry {
            session_id: "$1".to_string(),
            layer: TileMessageLogLayer::Socket,
            channel: TileMessageChannel::Cli,
            target_id: "%1".to_string(),
            target_kind: "shell".to_string(),
            wrapper_command: "shell_exec".to_string(),
            message_name: "exec".to_string(),
            caller_agent_id: Some("root:1".to_string()),
            caller_tile_id: Some("%2".to_string()),
            caller_window_id: Some("@2".to_string()),
            args: serde_json::json!({ "command": "pwd" }),
            related_tile_ids: vec!["%1".to_string(), "%2".to_string()],
            outcome: TileMessageOutcome::Ok,
            error: None,
            duration_ms: 4,
            timestamp_ms: 128,
        };

        append_tile_message_log_entry_to_path(&path, &entry).unwrap();
        let loaded = load_tile_message_log_entries_from_path(&path).unwrap();
        assert_eq!(loaded, vec![entry]);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn clears_all_log_tables() {
        let path = temp_db_path("clear-logs");
        append_chatter_entry_to_path(&path, &ChatterEntry {
            session_id: "$1".to_string(),
            kind: ChatterKind::Public,
            from_agent_id: None,
            from_display_name: "Root".to_string(),
            to_agent_id: None,
            to_display_name: None,
            message: "hello".to_string(),
            channels: Vec::new(),
            mentions: Vec::new(),
            public: true,
            display_text: "Root: hello".to_string(),
            timestamp_ms: 1,
        }).unwrap();
        append_agent_log_entry_to_path(&path, &AgentLogEntry {
            session_id: "$1".to_string(),
            agent_id: "agent-1".to_string(),
            tile_id: "%1".to_string(),
            kind: AgentLogKind::IncomingHook,
            text: "hook".to_string(),
            timestamp_ms: 2,
        }).unwrap();
        append_tile_message_log_entry_to_path(&path, &TileMessageLogEntry {
            session_id: "$1".to_string(),
            layer: TileMessageLogLayer::Message,
            channel: TileMessageChannel::Socket,
            target_id: "%1".to_string(),
            target_kind: "shell".to_string(),
            wrapper_command: "tile_call".to_string(),
            message_name: "output_read".to_string(),
            caller_agent_id: None,
            caller_tile_id: Some("%2".to_string()),
            caller_window_id: None,
            args: serde_json::json!({}),
            related_tile_ids: vec!["%1".to_string(), "%2".to_string()],
            outcome: TileMessageOutcome::Ok,
            error: None,
            duration_ms: 3,
            timestamp_ms: 3,
        }).unwrap();

        clear_log_entries_at_path(&path).unwrap();

        assert!(load_chatter_entries_from_path(&path).unwrap().is_empty());
        assert!(load_agent_log_entries_from_path(&path).unwrap().is_empty());
        assert!(load_tile_message_log_entries_from_path(&path).unwrap().is_empty());

        let _ = fs::remove_file(path);
    }
}
