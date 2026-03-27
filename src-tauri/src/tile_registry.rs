use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::{db, runtime};

const TILE_ID_ALPHABET: &[u8; 52] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const TILE_ID_LENGTH: usize = 6;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TileRecordKind {
    Shell,
    Browser,
    Agent,
    Work,
}

impl TileRecordKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Shell => "shell",
            Self::Browser => "browser",
            Self::Agent => "agent",
            Self::Work => "work",
        }
    }

    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "shell" => Ok(Self::Shell),
            "browser" => Ok(Self::Browser),
            "agent" => Ok(Self::Agent),
            "work" => Ok(Self::Work),
            other => Err(format!("unknown tile kind: {other}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TileRecord {
    pub tile_id: String,
    pub session_id: String,
    pub kind: TileRecordKind,
    pub window_id: String,
    pub pane_id: String,
    #[serde(default)]
    pub browser_incognito: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

fn database_path() -> String {
    runtime::database_path().to_string()
}

pub fn load() -> Vec<TileRecord> {
    load_at(Path::new(&database_path())).unwrap_or_default()
}

pub fn load_at(path: &Path) -> Result<Vec<TileRecord>, String> {
    let conn = db::open_at(path)?;
    load_with_conn(&conn)
}

pub fn load_with_conn(conn: &Connection) -> Result<Vec<TileRecord>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT tile_id, session_id, kind, window_id, pane_id, browser_incognito, created_at, updated_at
             FROM tile_registry
             ORDER BY session_id ASC, tile_id ASC",
        )
        .map_err(|error| format!("failed to prepare tile registry query: {error}"))?;
    let rows = stmt
        .query_map([], |row| {
            let kind = TileRecordKind::parse(&row.get::<_, String>(2)?)
                .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    error,
                ))))?;
            Ok(TileRecord {
                tile_id: row.get(0)?,
                session_id: row.get(1)?,
                kind,
                window_id: row.get(3)?,
                pane_id: row.get(4)?,
                browser_incognito: row.get::<_, i64>(5)? != 0,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        })
        .map_err(|error| format!("failed to query tile registry: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to decode tile registry rows: {error}"))
}

pub fn replace(records: &[TileRecord]) -> Result<(), String> {
    replace_at(Path::new(&database_path()), records)
}

pub fn replace_at(path: &Path, records: &[TileRecord]) -> Result<(), String> {
    let mut conn = db::open_at(path)?;
    let tx = conn
        .transaction()
        .map_err(|error| format!("failed to begin tile registry transaction: {error}"))?;
    replace_with_conn(&tx, records)?;
    tx.commit()
        .map_err(|error| format!("failed to commit tile registry transaction: {error}"))?;
    Ok(())
}

pub fn replace_with_conn(conn: &Connection, records: &[TileRecord]) -> Result<(), String> {
    conn.execute("DELETE FROM tile_registry", [])
        .map_err(|error| format!("failed to clear tile registry rows: {error}"))?;
    for record in records {
        conn.execute(
            "INSERT INTO tile_registry (tile_id, session_id, kind, window_id, pane_id, browser_incognito, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                record.tile_id,
                record.session_id,
                record.kind.as_str(),
                record.window_id,
                record.pane_id,
                if record.browser_incognito { 1 } else { 0 },
                record.created_at,
                record.updated_at,
            ],
        )
        .map_err(|error| format!("failed to insert tile registry row {}: {error}", record.tile_id))?;
    }
    Ok(())
}

fn next_tile_id_candidate() -> String {
    let bytes = uuid::Uuid::new_v4().into_bytes();
    (0..TILE_ID_LENGTH)
        .map(|index| {
            let offset = bytes[index] as usize % TILE_ID_ALPHABET.len();
            TILE_ID_ALPHABET[offset] as char
        })
        .collect()
}

fn tile_id_exists_with_conn(conn: &Connection, tile_id: &str) -> Result<bool, String> {
    let tmux_exists = conn
        .query_row(
            "SELECT 1 FROM tile_registry WHERE tile_id = ?1 LIMIT 1",
            [tile_id],
            |_row| Ok(()),
        )
        .optional()
        .map_err(|error| format!("failed to query tile registry for {tile_id}: {error}"))?
        .is_some();
    if tmux_exists {
        return Ok(true);
    }
    let work_exists = conn
        .query_row(
            "SELECT 1 FROM work_item WHERE tile_id = ?1 LIMIT 1",
            [tile_id],
            |_row| Ok(()),
        )
        .optional()
        .map_err(|error| format!("failed to query work item tile ids for {tile_id}: {error}"))?
        .is_some();
    Ok(work_exists)
}

pub fn generate_unique_tile_id_at(path: &Path) -> Result<String, String> {
    let conn = db::open_at(path)?;
    generate_unique_tile_id_with_conn(&conn)
}

pub fn generate_unique_tile_id_with_conn(conn: &Connection) -> Result<String, String> {
    for _ in 0..256 {
        let candidate = next_tile_id_candidate();
        if !tile_id_exists_with_conn(conn, &candidate)? {
            return Ok(candidate);
        }
    }
    Err("failed to generate a unique tile id".to_string())
}

#[cfg(test)]
mod tests {
    use super::{generate_unique_tile_id_at, replace_at, TileRecord, TileRecordKind};
    use crate::db;
    use std::fs;
    use std::path::PathBuf;

    fn temp_db_path(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("herd-tile-registry-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root.join("herd.sqlite")
    }

    #[test]
    fn generates_short_mixed_case_ids() {
        let path = temp_db_path("id");
        let tile_id = generate_unique_tile_id_at(&path).unwrap();
        assert_eq!(tile_id.len(), 6);
        assert!(tile_id.chars().all(|ch| ch.is_ascii_alphabetic()));
    }

    #[test]
    fn rejects_existing_registry_ids() {
        let path = temp_db_path("existing");
        replace_at(
            &path,
            &[TileRecord {
                tile_id: "AbCdEf".to_string(),
                session_id: "$1".to_string(),
                kind: TileRecordKind::Shell,
                window_id: "@1".to_string(),
                pane_id: "%1".to_string(),
                browser_incognito: false,
                created_at: 1,
                updated_at: 1,
            }],
        )
        .unwrap();
        let conn = db::open_at(&path).unwrap();
        conn.execute(
            "INSERT INTO work_item (work_id, tile_id, session_id, title, owner_agent_id, current_stage, data_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            rusqlite::params!["work-s1-001", "GhIjKl", "$1", "Work", Option::<String>::None, "plan", "{\"topic\":\"#work-s1-001\"}", 1i64, 1i64],
        )
        .unwrap();
        let tile_id = generate_unique_tile_id_at(&path).unwrap();
        assert_ne!(tile_id, "AbCdEf");
        assert_ne!(tile_id, "GhIjKl");
    }
}
