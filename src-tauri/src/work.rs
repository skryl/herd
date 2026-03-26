use std::fs;
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::{agent::now_ms, db, network};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum WorkStage {
    Plan,
    Prd,
    Artifact,
}

impl WorkStage {
    pub const ALL: [Self; 3] = [Self::Plan, Self::Prd, Self::Artifact];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Plan => "plan",
            Self::Prd => "prd",
            Self::Artifact => "artifact",
        }
    }

    pub fn next(self) -> Option<Self> {
        match self {
            Self::Plan => Some(Self::Prd),
            Self::Prd => Some(Self::Artifact),
            Self::Artifact => None,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkStageStatus {
    Ready,
    InProgress,
    Completed,
    Approved,
}

impl WorkStageStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::InProgress => "in_progress",
            Self::Completed => "completed",
            Self::Approved => "approved",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkReviewDecision {
    Approve,
    Improve,
}

impl WorkReviewDecision {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Approve => "approve",
            Self::Improve => "improve",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkStageState {
    pub stage: WorkStage,
    pub status: WorkStageStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkReviewEntry {
    pub stage: WorkStage,
    pub decision: WorkReviewDecision,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkItem {
    pub work_id: String,
    pub tile_id: String,
    pub session_id: String,
    pub title: String,
    pub topic: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_agent_id: Option<String>,
    pub current_stage: WorkStage,
    pub stages: Vec<WorkStageState>,
    pub reviews: Vec<WorkReviewEntry>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl WorkItem {
    pub fn current_stage_state(&self) -> Option<&WorkStageState> {
        self.stages.iter().find(|stage| stage.stage == self.current_stage)
    }

    pub fn awaiting_review(&self) -> bool {
        self.current_stage_state()
            .map(|stage| stage.status == WorkStageStatus::Completed)
            .unwrap_or(false)
    }

    pub fn complete(&self) -> bool {
        self.current_stage == WorkStage::Artifact
            && self
                .current_stage_state()
                .map(|stage| stage.status == WorkStageStatus::Approved)
                .unwrap_or(false)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkListScope {
    CurrentSession(String),
    All,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WorkItemData {
    topic: String,
}

pub fn list_work_at(db_path: &Path, scope: WorkListScope) -> Result<Vec<WorkItem>, String> {
    let conn = db::open_at(db_path)?;
    let mut work_ids = Vec::new();
    match scope {
        WorkListScope::CurrentSession(session_id) => {
            let mut stmt = conn
                .prepare("SELECT work_id FROM work_item WHERE session_id = ?1 ORDER BY updated_at DESC, work_id ASC")
                .map_err(|error| format!("failed to prepare work list query: {error}"))?;
            let rows = stmt
                .query_map([session_id], |row| row.get::<_, String>(0))
                .map_err(|error| format!("failed to query work items: {error}"))?;
            for row in rows {
                work_ids.push(row.map_err(|error| format!("failed to read work row: {error}"))?);
            }
        }
        WorkListScope::All => {
            let mut stmt = conn
                .prepare("SELECT work_id FROM work_item ORDER BY updated_at DESC, work_id ASC")
                .map_err(|error| format!("failed to prepare work list query: {error}"))?;
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|error| format!("failed to query work items: {error}"))?;
            for row in rows {
                work_ids.push(row.map_err(|error| format!("failed to read work row: {error}"))?);
            }
        }
    }
    let mut items = Vec::new();
    for work_id in work_ids {
        items.push(load_work_item_with_conn(&conn, &work_id)?);
    }
    items.sort_by(|left, right| {
        right
            .awaiting_review()
            .cmp(&left.awaiting_review())
            .then_with(|| right.updated_at.cmp(&left.updated_at))
            .then_with(|| left.work_id.cmp(&right.work_id))
    });
    Ok(items)
}

pub fn get_work_item_at(db_path: &Path, work_id: &str) -> Result<WorkItem, String> {
    let conn = db::open_at(db_path)?;
    load_work_item_with_conn(&conn, work_id)
}

pub fn get_work_item_by_tile_id_at(db_path: &Path, tile_id: &str) -> Result<WorkItem, String> {
    let conn = db::open_at(db_path)?;
    load_work_item_by_tile_id_with_conn(&conn, tile_id)
}

pub fn ensure_tile_ids_at(db_path: &Path) -> Result<Vec<(String, String)>, String> {
    let mut conn = db::open_at(db_path)?;
    let tx = conn
        .transaction()
        .map_err(|error| format!("failed to begin work tile id migration transaction: {error}"))?;
    let mut stmt = tx
        .prepare("SELECT work_id FROM work_item WHERE tile_id IS NULL OR trim(tile_id) = '' ORDER BY work_id ASC")
        .map_err(|error| format!("failed to prepare work tile id migration query: {error}"))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("failed to query work items missing tile ids: {error}"))?;
    let mut migrated = Vec::new();
    for row in rows {
        let work_id = row.map_err(|error| format!("failed to read work tile id migration row: {error}"))?;
        let tile_id = crate::tile_registry::generate_unique_tile_id_with_conn(&tx)?;
        tx.execute(
            "UPDATE work_item SET tile_id = ?2 WHERE work_id = ?1",
            params![work_id, tile_id],
        )
        .map_err(|error| format!("failed to assign tile id for {work_id}: {error}"))?;
        migrated.push((work_id, tile_id));
    }
    drop(stmt);
    tx.commit()
        .map_err(|error| format!("failed to commit work tile id migration transaction: {error}"))?;
    Ok(migrated)
}

pub fn tile_id_for_work_at(db_path: &Path, work_id: &str) -> Result<String, String> {
    let conn = db::open_at(db_path)?;
    tile_id_for_work_with_conn(&conn, work_id)
}

pub fn tile_id_for_work_with_conn(conn: &Connection, work_id: &str) -> Result<String, String> {
    conn.query_row(
        "SELECT tile_id FROM work_item WHERE work_id = ?1",
        [work_id],
        |row| row.get::<_, Option<String>>(0),
    )
    .optional()
    .map_err(|error| format!("failed to load work tile id for {work_id}: {error}"))?
    .flatten()
    .filter(|value| !value.trim().is_empty())
    .ok_or_else(|| format!("work item {work_id} is missing a tile id"))
}

pub fn create_work_item_at(
    db_path: &Path,
    session_id: &str,
    title: &str,
) -> Result<WorkItem, String> {
    let normalized_title = normalize_title(title)?;

    let mut conn = db::open_at(db_path)?;
    let tx = conn
        .transaction()
        .map_err(|error| format!("failed to begin work create transaction: {error}"))?;

    let work_id = next_work_id(&tx, session_id)?;
    let tile_id = crate::tile_registry::generate_unique_tile_id_with_conn(&tx)?;
    let topic = work_topic(&work_id);
    let created_at = now_ms();
    let data_json = serde_json::to_string(&WorkItemData {
        topic: topic.clone(),
    })
    .map_err(|error| format!("failed to serialize work item data: {error}"))?;

    tx.execute(
        "INSERT INTO work_item (work_id, tile_id, session_id, title, owner_agent_id, current_stage, data_json, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            work_id,
            tile_id,
            session_id,
            normalized_title,
            Option::<String>::None,
            WorkStage::Plan.as_str(),
            data_json,
            created_at,
            created_at,
        ],
    )
    .map_err(|error| format!("failed to insert work item: {error}"))?;

    for stage in WorkStage::ALL {
        tx.execute(
            "INSERT INTO work_stage (work_id, stage_name, status, content) VALUES (?1, ?2, ?3, ?4)",
            params![
                work_id,
                stage.as_str(),
                WorkStageStatus::Ready.as_str(),
                default_stage_content(&normalized_title, &work_id, session_id, &topic, stage),
            ],
        )
        .map_err(|error| format!("failed to insert stage {}: {error}", stage.as_str()))?;
    }

    tx.commit()
        .map_err(|error| format!("failed to commit work create transaction: {error}"))?;
    get_work_item_at(db_path, &work_id)
}

pub fn rename_work_item_at(db_path: &Path, work_id: &str, title: &str) -> Result<WorkItem, String> {
    let normalized_title = normalize_title(title)?;
    let mut conn = db::open_at(db_path)?;
    let tx = conn
        .transaction()
        .map_err(|error| format!("failed to begin work rename transaction: {error}"))?;

    tx.execute(
        "UPDATE work_item SET title = ?2, updated_at = ?3 WHERE work_id = ?1",
        params![work_id, normalized_title, now_ms()],
    )
    .map_err(|error| format!("failed to rename work item {work_id}: {error}"))?;

    tx.commit()
        .map_err(|error| format!("failed to commit work rename transaction: {error}"))?;
    get_work_item_at(db_path, work_id)
}

pub fn delete_work_item_at(
    db_path: &Path,
    work_id: &str,
) -> Result<(), String> {
    let mut conn = db::open_at(db_path)?;
    let tx = conn
        .transaction()
        .map_err(|error| format!("failed to begin work delete transaction: {error}"))?;
    let item = load_work_item_with_conn(&tx, work_id)?;

    tx.execute("DELETE FROM work_review WHERE work_id = ?1", [work_id])
        .map_err(|error| format!("failed to delete work reviews for {work_id}: {error}"))?;
    tx.execute("DELETE FROM work_stage WHERE work_id = ?1", [work_id])
        .map_err(|error| format!("failed to delete work stages for {work_id}: {error}"))?;
    tx.execute("DELETE FROM work_item WHERE work_id = ?1", [work_id])
        .map_err(|error| format!("failed to delete work item {work_id}: {error}"))?;

    tx.commit()
        .map_err(|error| format!("failed to commit work delete transaction: {error}"))?;
    let _ = network::disconnect_all_for_tile_at(db_path, &item.session_id, &item.tile_id);

    Ok(())
}

pub fn read_current_stage_preview_at(db_path: &Path, work_id: &str) -> Result<String, String> {
    let conn = db::open_at(db_path)?;
    let item = load_work_item_with_conn(&conn, work_id)?;
    load_stage_content_with_conn(&conn, work_id, item.current_stage)
}

pub fn start_work_stage_at(
    db_path: &Path,
    work_id: &str,
    owner_agent_id: &str,
) -> Result<WorkItem, String> {
    let mut conn = db::open_at(db_path)?;
    let tx = conn
        .transaction()
        .map_err(|error| format!("failed to begin work stage start transaction: {error}"))?;
    let item = load_work_item_with_conn(&tx, work_id)?;
    require_owner(&item, owner_agent_id)?;
    let current = item
        .current_stage_state()
        .ok_or_else(|| format!("missing current stage for {work_id}"))?;
    if current.status != WorkStageStatus::Ready {
        return Err(format!(
            "cannot start stage {} while status is {}",
            item.current_stage.as_str(),
            current.status.as_str()
        ));
    }
    update_stage_status(&tx, work_id, item.current_stage, WorkStageStatus::InProgress)?;
    touch_work_item(&tx, work_id)?;
    tx.commit()
        .map_err(|error| format!("failed to commit work stage start transaction: {error}"))?;
    get_work_item_at(db_path, work_id)
}

pub fn complete_work_stage_at(
    db_path: &Path,
    work_id: &str,
    owner_agent_id: &str,
) -> Result<WorkItem, String> {
    let mut conn = db::open_at(db_path)?;
    let tx = conn
        .transaction()
        .map_err(|error| format!("failed to begin work stage complete transaction: {error}"))?;
    let item = load_work_item_with_conn(&tx, work_id)?;
    require_owner(&item, owner_agent_id)?;
    let current = item
        .current_stage_state()
        .ok_or_else(|| format!("missing current stage for {work_id}"))?;
    if current.status != WorkStageStatus::InProgress {
        return Err(format!(
            "cannot complete stage {} while status is {}",
            item.current_stage.as_str(),
            current.status.as_str()
        ));
    }
    update_stage_status(&tx, work_id, item.current_stage, WorkStageStatus::Completed)?;
    touch_work_item(&tx, work_id)?;
    tx.commit()
        .map_err(|error| format!("failed to commit work stage complete transaction: {error}"))?;
    get_work_item_at(db_path, work_id)
}

pub fn approve_work_stage_at(db_path: &Path, work_id: &str) -> Result<WorkItem, String> {
    let mut conn = db::open_at(db_path)?;
    let tx = conn
        .transaction()
        .map_err(|error| format!("failed to begin work stage approval transaction: {error}"))?;
    let item = load_work_item_with_conn(&tx, work_id)?;
    let current = item
        .current_stage_state()
        .ok_or_else(|| format!("missing current stage for {work_id}"))?;
    if current.status != WorkStageStatus::Completed {
        return Err(format!(
            "cannot approve stage {} while status is {}",
            item.current_stage.as_str(),
            current.status.as_str()
        ));
    }
    update_stage_status(&tx, work_id, item.current_stage, WorkStageStatus::Approved)?;
    insert_review_entry(&tx, work_id, item.current_stage, WorkReviewDecision::Approve, None)?;
    if let Some(next_stage) = item.current_stage.next() {
        tx.execute(
            "UPDATE work_item SET current_stage = ?1, updated_at = ?2 WHERE work_id = ?3",
            params![next_stage.as_str(), now_ms(), work_id],
        )
        .map_err(|error| format!("failed to advance work item {work_id}: {error}"))?;
        update_stage_status(&tx, work_id, next_stage, WorkStageStatus::Ready)?;
    } else {
        touch_work_item(&tx, work_id)?;
    }
    tx.commit()
        .map_err(|error| format!("failed to commit work stage approval transaction: {error}"))?;
    get_work_item_at(db_path, work_id)
}

pub fn improve_work_stage_at(
    db_path: &Path,
    work_id: &str,
    comment: &str,
) -> Result<WorkItem, String> {
    let comment = comment.trim();
    if comment.is_empty() {
        return Err("improve review requires a comment".to_string());
    }
    let mut conn = db::open_at(db_path)?;
    let tx = conn
        .transaction()
        .map_err(|error| format!("failed to begin work stage improve transaction: {error}"))?;
    let item = load_work_item_with_conn(&tx, work_id)?;
    let current = item
        .current_stage_state()
        .ok_or_else(|| format!("missing current stage for {work_id}"))?;
    if current.status != WorkStageStatus::Completed {
        return Err(format!(
            "cannot improve stage {} while status is {}",
            item.current_stage.as_str(),
            current.status.as_str()
        ));
    }
    update_stage_status(&tx, work_id, item.current_stage, WorkStageStatus::InProgress)?;
    insert_review_entry(
        &tx,
        work_id,
        item.current_stage,
        WorkReviewDecision::Improve,
        Some(comment),
    )?;
    touch_work_item(&tx, work_id)?;
    tx.commit()
        .map_err(|error| format!("failed to commit work stage improve transaction: {error}"))?;
    get_work_item_at(db_path, work_id)
}

pub fn remove_legacy_work_directory(project_root: &Path) -> Result<(), String> {
    let work_root = project_root.join("work");
    if !work_root.exists() {
        return Ok(());
    }
    fs::remove_dir_all(&work_root)
        .map_err(|error| format!("failed to delete {}: {error}", work_root.display()))
}

fn normalize_title(title: &str) -> Result<String, String> {
    let title = title.trim();
    if title.is_empty() {
        Err("work title cannot be empty".to_string())
    } else {
        Ok(title.to_string())
    }
}

fn require_owner(item: &WorkItem, owner_agent_id: &str) -> Result<(), String> {
    if item.owner_agent_id.as_deref() == Some(owner_agent_id) {
        Ok(())
    } else {
        Err(format!("only the owner can update work item {}", item.work_id))
    }
}

fn next_work_id(conn: &Connection, session_id: &str) -> Result<String, String> {
    let prefix = session_prefix(session_id);
    let mut stmt = conn
        .prepare("SELECT work_id FROM work_item WHERE session_id = ?1 ORDER BY work_id ASC")
        .map_err(|error| format!("failed to prepare work id query: {error}"))?;
    let rows = stmt
        .query_map([session_id], |row| row.get::<_, String>(0))
        .map_err(|error| format!("failed to query existing work ids: {error}"))?;
    let mut next_sequence = 1u32;
    for row in rows {
        let work_id = row.map_err(|error| format!("failed to read work id row: {error}"))?;
        if let Some(sequence) = parse_work_sequence(&work_id, &prefix) {
            next_sequence = next_sequence.max(sequence + 1);
        }
    }
    Ok(format!("{prefix}{next_sequence:03}"))
}

fn parse_work_sequence(work_id: &str, prefix: &str) -> Option<u32> {
    work_id
        .strip_prefix(prefix)
        .and_then(|suffix| suffix.parse::<u32>().ok())
}

fn session_prefix(session_id: &str) -> String {
    let slug = session_numeric_or_sanitized(session_id);
    format!("work-s{slug}-")
}

fn session_numeric_or_sanitized(session_id: &str) -> String {
    let digits: String = session_id.chars().filter(char::is_ascii_digit).collect();
    if !digits.is_empty() {
        return digits;
    }
    let normalized: String = session_id
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
        .collect();
    if normalized.is_empty() {
        "unknown".to_string()
    } else {
        normalized.to_ascii_lowercase()
    }
}

fn work_topic(work_id: &str) -> String {
    format!("#{work_id}")
}

fn default_stage_content(
    title: &str,
    work_id: &str,
    session_id: &str,
    topic: &str,
    stage: WorkStage,
) -> String {
    format!(
        "# {title}\n\nWork ID: {work_id}\nSession: {session_id}\nTopic: {topic}\nStage: {}\n",
        stage.as_str()
    )
}

fn update_stage_status(
    conn: &Connection,
    work_id: &str,
    stage: WorkStage,
    status: WorkStageStatus,
) -> Result<(), String> {
    conn.execute(
        "UPDATE work_stage SET status = ?1 WHERE work_id = ?2 AND stage_name = ?3",
        params![status.as_str(), work_id, stage.as_str()],
    )
    .map_err(|error| format!("failed to update stage {} for {work_id}: {error}", stage.as_str()))?;
    Ok(())
}

fn touch_work_item(conn: &Connection, work_id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE work_item SET updated_at = ?1 WHERE work_id = ?2",
        params![now_ms(), work_id],
    )
    .map_err(|error| format!("failed to update timestamp for {work_id}: {error}"))?;
    Ok(())
}

fn insert_review_entry(
    conn: &Connection,
    work_id: &str,
    stage: WorkStage,
    decision: WorkReviewDecision,
    comment: Option<&str>,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO work_review (work_id, stage_name, decision, comment, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![work_id, stage.as_str(), decision.as_str(), comment, now_ms()],
    )
    .map_err(|error| format!("failed to insert review for {work_id}: {error}"))?;
    Ok(())
}

fn load_stage_content_with_conn(conn: &Connection, work_id: &str, stage: WorkStage) -> Result<String, String> {
    conn.query_row(
        "SELECT content FROM work_stage WHERE work_id = ?1 AND stage_name = ?2",
        params![work_id, stage.as_str()],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|error| format!("failed to load content for {work_id} stage {}: {error}", stage.as_str()))?
    .ok_or_else(|| format!("missing content for {work_id} stage {}", stage.as_str()))
}

fn load_work_item_with_conn(conn: &Connection, work_id: &str) -> Result<WorkItem, String> {
    let row = conn
        .query_row(
            "SELECT tile_id, session_id, title, owner_agent_id, current_stage, data_json, created_at, updated_at FROM work_item WHERE work_id = ?1",
            [work_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, i64>(7)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("failed to load work item {work_id}: {error}"))?
        .ok_or_else(|| format!("unknown work item: {work_id}"))?;
    let tile_id = row
        .0
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("work item {work_id} is missing a tile id"))?;
    let current_stage = parse_stage(&row.4)?;
    let data = serde_json::from_str::<WorkItemData>(&row.5)
        .map_err(|error| format!("failed to parse work item data for {work_id}: {error}"))?;
    let owner_agent_id = network::controller_agent_id_with_conn(conn, &row.1, &tile_id)?;

    let mut stages = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT stage_name, status FROM work_stage WHERE work_id = ?1")
            .map_err(|error| format!("failed to prepare work stage query: {error}"))?;
        let rows = stmt
            .query_map([work_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                ))
            })
            .map_err(|error| format!("failed to query work stages: {error}"))?;
        for row in rows {
            let (stage_name, status_name) =
                row.map_err(|error| format!("failed to read work stage row: {error}"))?;
            stages.push(WorkStageState {
                stage: parse_stage(&stage_name)?,
                status: parse_stage_status(&status_name)?,
            });
        }
    }
    stages.sort_by_key(|stage| stage.stage);

    let mut reviews = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT stage_name, decision, comment, created_at FROM work_review WHERE work_id = ?1 ORDER BY created_at ASC, id ASC")
            .map_err(|error| format!("failed to prepare review query: {error}"))?;
        let rows = stmt
            .query_map([work_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })
            .map_err(|error| format!("failed to query work reviews: {error}"))?;
        for row in rows {
            let (stage_name, decision_name, comment, created_at) =
                row.map_err(|error| format!("failed to read review row: {error}"))?;
            reviews.push(WorkReviewEntry {
                stage: parse_stage(&stage_name)?,
                decision: parse_review_decision(&decision_name)?,
                comment,
                created_at,
            });
        }
    }

    Ok(WorkItem {
        work_id: work_id.to_string(),
        tile_id,
        session_id: row.1,
        title: row.2,
        topic: data.topic,
        owner_agent_id,
        current_stage,
        stages,
        reviews,
        created_at: row.6,
        updated_at: row.7,
    })
}

fn load_work_item_by_tile_id_with_conn(conn: &Connection, tile_id: &str) -> Result<WorkItem, String> {
    let work_id = conn
        .query_row(
            "SELECT work_id FROM work_item WHERE tile_id = ?1",
            [tile_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("failed to load work id for tile {tile_id}: {error}"))?
        .ok_or_else(|| format!("unknown work tile: {tile_id}"))?;
    load_work_item_with_conn(conn, &work_id)
}

fn parse_stage(value: &str) -> Result<WorkStage, String> {
    match value {
        "plan" => Ok(WorkStage::Plan),
        "prd" => Ok(WorkStage::Prd),
        "artifact" => Ok(WorkStage::Artifact),
        _ => Err(format!("unknown work stage: {value}")),
    }
}

fn parse_stage_status(value: &str) -> Result<WorkStageStatus, String> {
    match value {
        "ready" => Ok(WorkStageStatus::Ready),
        "in_progress" => Ok(WorkStageStatus::InProgress),
        "completed" => Ok(WorkStageStatus::Completed),
        "approved" => Ok(WorkStageStatus::Approved),
        _ => Err(format!("unknown work stage status: {value}")),
    }
}

fn parse_review_decision(value: &str) -> Result<WorkReviewDecision, String> {
    match value {
        "approve" => Ok(WorkReviewDecision::Approve),
        "improve" => Ok(WorkReviewDecision::Improve),
        _ => Err(format!("unknown review decision: {value}")),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        approve_work_stage_at, complete_work_stage_at, create_work_item_at, delete_work_item_at,
        get_work_item_at, improve_work_stage_at, list_work_at, read_current_stage_preview_at,
        start_work_stage_at, WorkListScope, WorkStage, WorkStageStatus,
    };
    use crate::{
        agent::{AgentInfo, AgentRole, AgentType},
        db,
        network::{self, NetworkTileDescriptor, NetworkTileKind, TilePort},
    };
    use std::fs;
    use std::path::PathBuf;

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("herd-work-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn temp_db_path(name: &str) -> PathBuf {
        temp_root(name).join("herd.sqlite")
    }

    fn agent(agent_id: &str, session_id: &str) -> AgentInfo {
        AgentInfo {
            agent_id: agent_id.to_string(),
            agent_type: AgentType::Claude,
            agent_role: AgentRole::Worker,
            tile_id: format!("%{agent_id}"),
            pane_id: format!("%{agent_id}"),
            window_id: format!("@{agent_id}"),
            session_id: session_id.to_string(),
            title: format!("Agent {agent_id}"),
            display_name: format!("Agent {agent_id}"),
            alive: true,
            chatter_subscribed: true,
            channels: Vec::new(),
            agent_pid: None,
        }
    }

    fn owner_tile(agent: &AgentInfo) -> NetworkTileDescriptor {
        NetworkTileDescriptor {
            tile_id: agent.tile_id.clone(),
            session_id: agent.session_id.clone(),
            kind: NetworkTileKind::Agent,
        }
    }

    fn connect_owner(db_path: &PathBuf, work_id: &str, agent: &AgentInfo) {
        db::replace_agents_at(db_path, std::slice::from_ref(agent)).unwrap();
        let item = get_work_item_at(db_path, work_id).unwrap();
        network::connect_at(
            db_path,
            &owner_tile(agent),
            TilePort::Left,
            &NetworkTileDescriptor {
                tile_id: item.tile_id,
                session_id: agent.session_id.clone(),
                kind: NetworkTileKind::Work,
            },
            TilePort::Left,
        )
        .unwrap();
    }

    #[test]
    fn creates_work_item_stage_content_in_sqlite_without_stage_files() {
        let db_path = temp_db_path("create");
        let project_root = temp_root("create-project");
        db::open_at(&db_path).unwrap();

        let item = create_work_item_at(&db_path, "$4", "Socket refactor").unwrap();
        assert_eq!(item.work_id, "work-s4-001");
        assert_eq!(item.topic, "#work-s4-001");
        assert_eq!(item.current_stage, WorkStage::Plan);
        assert_eq!(item.current_stage_state().unwrap().status, WorkStageStatus::Ready);
        assert_eq!(item.owner_agent_id, None);

        let content = db::open_at(&db_path)
            .unwrap()
            .query_row(
                "SELECT content FROM work_stage WHERE work_id = ?1 AND stage_name = ?2",
                rusqlite::params![item.work_id.clone(), "plan"],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        assert!(content.contains("# Socket refactor"));
        assert!(!project_root.join("work").exists());

        let listed = list_work_at(&db_path, WorkListScope::CurrentSession("$4".to_string())).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].work_id, item.work_id);
    }

    #[test]
    fn reads_current_stage_preview_from_sqlite() {
        let db_path = temp_db_path("preview");
        let _project_root = temp_root("preview-project");
        db::open_at(&db_path).unwrap();

        let item = create_work_item_at(&db_path, "$3", "Preview item").unwrap();
        let preview = read_current_stage_preview_at(&db_path, &item.work_id).unwrap();
        assert!(preview.contains("# Preview item"));
        assert!(preview.contains("Stage: plan"));
    }

    #[test]
    fn derives_owner_only_from_work_left_port_connection() {
        let db_path = temp_db_path("owner-derivation");
        db::open_at(&db_path).unwrap();

        let owner = agent("owner-1", "$1");
        let item = create_work_item_at(&db_path, "$1", "Owned item").unwrap();
        assert_eq!(item.owner_agent_id, None);

        connect_owner(&db_path, &item.work_id, &owner);
        let owned = get_work_item_at(&db_path, &item.work_id).unwrap();
        assert_eq!(owned.owner_agent_id.as_deref(), Some(owner.agent_id.as_str()));

        network::disconnect_at(
            &db_path,
            &owner.session_id,
            &item.tile_id,
            TilePort::Left,
        )
        .unwrap();
        let unowned = get_work_item_at(&db_path, &item.work_id).unwrap();
        assert_eq!(unowned.owner_agent_id, None);
    }

    #[test]
    fn enforces_stage_lifecycle_and_review_flow() {
        let db_path = temp_db_path("lifecycle");
        db::open_at(&db_path).unwrap();

        let owner = agent("owner-1", "$7");
        let item = create_work_item_at(&db_path, "$7", "PRD flow").unwrap();
        connect_owner(&db_path, &item.work_id, &owner);
        let work_id = item.work_id.clone();

        let started = start_work_stage_at(&db_path, &work_id, &owner.agent_id).unwrap();
        assert_eq!(started.current_stage_state().unwrap().status, WorkStageStatus::InProgress);

        let completed = complete_work_stage_at(&db_path, &work_id, &owner.agent_id).unwrap();
        assert_eq!(completed.current_stage_state().unwrap().status, WorkStageStatus::Completed);
        assert!(completed.awaiting_review());

        let improved = improve_work_stage_at(&db_path, &work_id, "needs more detail").unwrap();
        assert_eq!(improved.current_stage_state().unwrap().status, WorkStageStatus::InProgress);

        let completed_again = complete_work_stage_at(&db_path, &work_id, &owner.agent_id).unwrap();
        let approved = approve_work_stage_at(&db_path, &work_id).unwrap();
        assert_eq!(completed_again.current_stage, WorkStage::Plan);
        assert_eq!(approved.current_stage, WorkStage::Prd);
        assert_eq!(approved.current_stage_state().unwrap().status, WorkStageStatus::Ready);

        let reloaded = get_work_item_at(&db_path, &work_id).unwrap();
        assert_eq!(reloaded.reviews.len(), 2);
        assert_eq!(reloaded.reviews[0].comment.as_deref(), Some("needs more detail"));
    }

    #[test]
    fn rejects_non_owner_updates_requires_improve_comment_and_completes_artifact() {
        let db_path = temp_db_path("owner-only");
        db::open_at(&db_path).unwrap();

        let owner = agent("owner-1", "$9");
        let outsider = agent("outsider-1", "$9");
        let item = create_work_item_at(&db_path, "$9", "Artifact flow").unwrap();
        connect_owner(&db_path, &item.work_id, &owner);
        let work_id = item.work_id.clone();

        let start_error = start_work_stage_at(&db_path, &work_id, &outsider.agent_id).unwrap_err();
        assert!(start_error.contains("only the owner"));

        let item = start_work_stage_at(&db_path, &work_id, &owner.agent_id).unwrap();
        assert_eq!(item.current_stage_state().unwrap().status, WorkStageStatus::InProgress);

        let complete_error = complete_work_stage_at(&db_path, &work_id, &outsider.agent_id).unwrap_err();
        assert!(complete_error.contains("only the owner"));

        let item = complete_work_stage_at(&db_path, &work_id, &owner.agent_id).unwrap();
        assert_eq!(item.current_stage_state().unwrap().status, WorkStageStatus::Completed);

        let improve_error = improve_work_stage_at(&db_path, &work_id, "   ").unwrap_err();
        assert_eq!(improve_error, "improve review requires a comment");

        let item = approve_work_stage_at(&db_path, &work_id).unwrap();
        assert_eq!(item.current_stage, WorkStage::Prd);

        let _item = start_work_stage_at(&db_path, &work_id, &owner.agent_id).unwrap();
        let item = complete_work_stage_at(&db_path, &work_id, &owner.agent_id).unwrap();
        assert_eq!(item.current_stage_state().unwrap().status, WorkStageStatus::Completed);
        let item = approve_work_stage_at(&db_path, &work_id).unwrap();
        assert_eq!(item.current_stage, WorkStage::Artifact);
        assert_eq!(item.current_stage_state().unwrap().status, WorkStageStatus::Ready);

        let _item = start_work_stage_at(&db_path, &work_id, &owner.agent_id).unwrap();
        let item = complete_work_stage_at(&db_path, &work_id, &owner.agent_id).unwrap();
        assert_eq!(item.current_stage_state().unwrap().status, WorkStageStatus::Completed);
        let item = approve_work_stage_at(&db_path, &work_id).unwrap();
        assert!(item.complete());
    }

    #[test]
    fn clears_derived_owner_when_agent_edges_are_removed() {
        let db_path = temp_db_path("dead-cleanup");
        db::open_at(&db_path).unwrap();

        let owner = agent("owner-1", "$5");
        let item = create_work_item_at(&db_path, "$5", "Cleanup flow").unwrap();
        let work_id = item.work_id.clone();
        connect_owner(&db_path, &work_id, &owner);

        let item = get_work_item_at(&db_path, &work_id).unwrap();
        assert_eq!(item.owner_agent_id.as_deref(), Some(owner.agent_id.as_str()));

        network::disconnect_all_for_tile_at(&db_path, &owner.session_id, &owner.tile_id).unwrap();
        let item = get_work_item_at(&db_path, &work_id).unwrap();
        assert_eq!(item.owner_agent_id, None);
    }

    #[test]
    fn deletes_work_item_rows_without_stage_files() {
        let db_path = temp_db_path("delete");
        let project_root = temp_root("delete-project");
        db::open_at(&db_path).unwrap();

        let item = create_work_item_at(&db_path, "$8", "Delete me").unwrap();
        let work_id = item.work_id.clone();
        assert!(!project_root.join("work").exists());

        delete_work_item_at(&db_path, &work_id).unwrap();

        let lookup_error = get_work_item_at(&db_path, &work_id).unwrap_err();
        assert!(lookup_error.contains("unknown work item"));
    }

    #[test]
    fn lists_completed_review_items_before_newer_in_progress_items() {
        let db_path = temp_db_path("ordering");
        let _project_root = temp_root("ordering-project");
        db::open_at(&db_path).unwrap();

        let review_owner = agent("owner-1", "$6");
        let review_item =
            create_work_item_at(&db_path, "$6", "Review item").unwrap();
        connect_owner(&db_path, &review_item.work_id, &review_owner);
        let review_item =
            start_work_stage_at(&db_path, &review_item.work_id, &review_owner.agent_id).unwrap();
        let review_item =
            complete_work_stage_at(&db_path, &review_item.work_id, &review_owner.agent_id).unwrap();
        assert!(review_item.awaiting_review());

        let newer_owner = agent("owner-2", "$6");
        let newer_item =
            create_work_item_at(&db_path, "$6", "Newer ready item").unwrap();
        connect_owner(&db_path, &newer_item.work_id, &newer_owner);

        let listed = list_work_at(&db_path, WorkListScope::CurrentSession("$6".to_string())).unwrap();
        assert_eq!(
            listed.iter().map(|item| item.work_id.clone()).collect::<Vec<_>>(),
            vec![review_item.work_id, newer_item.work_id]
        );
        assert!(listed[0].awaiting_review());
        assert!(!listed[1].awaiting_review());
    }
}
