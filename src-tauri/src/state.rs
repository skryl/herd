use std::collections::{BTreeSet, HashMap};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use tokio::sync::mpsc::UnboundedSender;

use crate::agent::{AgentChannelEvent, AgentDebugState, AgentInfo, AgentLogEntry, AgentRole, AgentStreamEnvelope, AgentType, ChatterEntry, TopicInfo};
use crate::db::{self, PersistedTopicRecord};
use crate::network;
use crate::persist::{self, HerdState, TileState};
use crate::tile_registry::{self, TileRecord};
use crate::tile_message::TileMessageLogEntry;
use crate::tmux_control::{TmuxControl, TmuxWriter, OutputBuffers};

type PendingTestDriverRequests = HashMap<String, Sender<Result<Value, String>>>;
type AgentSubscribers = HashMap<u64, UnboundedSender<AgentStreamEnvelope>>;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WindowParentSource {
    Hook,
    Manual,
}

#[derive(Clone)]
struct WindowParentLink {
    parent_window_id: String,
    source: WindowParentSource,
}

#[derive(Clone)]
struct AgentRecord {
    agent_id: String,
    agent_type: AgentType,
    agent_role: AgentRole,
    tile_id: String,
    pane_id: String,
    window_id: String,
    session_id: String,
    title: String,
    display_name: String,
    chatter_subscribed: bool,
    topics: BTreeSet<String>,
    alive: bool,
    welcomed: bool,
    registration_ts_ms: i64,
    last_seen_ts_ms: i64,
    last_ping_sent_at: Option<Instant>,
    last_ping_ack_at: Option<Instant>,
    ping_deadline: Option<Instant>,
    agent_pid: Option<u32>,
    subscribers: AgentSubscribers,
}

impl AgentRecord {
    fn to_info(&self) -> AgentInfo {
        AgentInfo {
            agent_id: self.agent_id.clone(),
            agent_type: self.agent_type,
            agent_role: self.agent_role,
            tile_id: self.tile_id.clone(),
            pane_id: self.pane_id.clone(),
            window_id: self.window_id.clone(),
            session_id: self.session_id.clone(),
            title: self.title.clone(),
            display_name: self.display_name.clone(),
            alive: self.alive,
            chatter_subscribed: self.chatter_subscribed,
            topics: self.topics.iter().cloned().collect(),
            agent_pid: self.agent_pid,
        }
    }
}

#[derive(Clone)]
struct TopicRecord {
    session_id: String,
    name: String,
    subscribers: BTreeSet<String>,
    last_activity_at: Option<i64>,
}

pub struct AgentSubscriptionInit {
    pub subscriber_id: u64,
    pub signed_on: bool,
    pub bootstrap: bool,
    pub info: AgentInfo,
}

pub struct AgentPingCycle {
    pub to_ping: Vec<(String, String)>,
    pub expired: Vec<String>,
}

#[derive(Clone)]
pub struct AppState {
    pub tmux_control: Arc<Mutex<Option<Arc<Mutex<TmuxControl>>>>>,
    pub tmux_writer: Arc<Mutex<Option<Arc<TmuxWriter>>>>,
    pub output_buffers: Arc<Mutex<Option<OutputBuffers>>>,
    shutting_down: Arc<AtomicBool>,
    pub tile_states: Arc<Mutex<HerdState>>,
    tile_records: Arc<Mutex<HashMap<String, TileRecord>>>,
    pub snapshot_version: Arc<AtomicU64>,
    pub last_active_session: Arc<Mutex<Option<String>>>,
    window_parents: Arc<Mutex<HashMap<String, WindowParentLink>>>,
    pub test_driver_frontend_ready: Arc<AtomicBool>,
    pub test_driver_bootstrap_complete: Arc<AtomicBool>,
    pub pending_test_driver_requests: Arc<Mutex<PendingTestDriverRequests>>,
    pub test_driver_request_counter: Arc<AtomicU64>,
    pub claude_command_cache: Arc<Mutex<HashMap<String, crate::commands::ClaudeMenuData>>>,
    agent_records: Arc<Mutex<HashMap<String, AgentRecord>>>,
    topic_records: Arc<Mutex<HashMap<String, TopicRecord>>>,
    chatter_entries: Arc<Mutex<Vec<ChatterEntry>>>,
    agent_log_entries: Arc<Mutex<Vec<AgentLogEntry>>>,
    tile_message_log_entries: Arc<Mutex<Vec<TileMessageLogEntry>>>,
    agent_display_counter: Arc<AtomicU64>,
    agent_subscriber_counter: Arc<AtomicU64>,
    agent_ping_counter: Arc<AtomicU64>,
}

impl AppState {
    pub fn new() -> Self {
        if let Err(error) = db::reset_runtime_presence_state() {
            log::warn!("Failed to reset runtime presence state in sqlite: {error}");
        }
        if let Err(error) = crate::work::ensure_tile_ids_at(std::path::Path::new(crate::runtime::database_path())) {
            log::warn!("Failed to ensure work tile ids in sqlite: {error}");
        }
        if let Err(error) = crate::work::remove_legacy_work_directory(&crate::runtime::project_root_dir()) {
            log::warn!("Failed to remove legacy work directory: {error}");
        }
        let mut persisted_agents = db::load_agents().unwrap_or_default();
        for agent in &mut persisted_agents {
            if agent.pane_id.trim().is_empty() && agent.tile_id.starts_with('%') {
                agent.pane_id = agent.tile_id.clone();
            }
        }
        let persisted_topics = db::load_topics().unwrap_or_default();
        let persisted_tiles = tile_registry::load();
        let chatter_entries = persist::load_chatter_entries();
        let agent_log_entries = persist::load_agent_log_entries();
        let tile_message_log_entries = persist::load_tile_message_log_entries();
        let agent_display_counter = persisted_agents
            .iter()
            .filter_map(|agent| parse_agent_display_index(&agent.display_name))
            .max()
            .unwrap_or(0);
        Self {
            tmux_control: Arc::new(Mutex::new(None)),
            tmux_writer: Arc::new(Mutex::new(None)),
            output_buffers: Arc::new(Mutex::new(None)),
            shutting_down: Arc::new(AtomicBool::new(false)),
            tile_states: Arc::new(Mutex::new(persist::load())),
            tile_records: Arc::new(Mutex::new(build_tile_record_map(persisted_tiles))),
            snapshot_version: Arc::new(AtomicU64::new(0)),
            last_active_session: Arc::new(Mutex::new(None)),
            window_parents: Arc::new(Mutex::new(HashMap::new())),
            test_driver_frontend_ready: Arc::new(AtomicBool::new(false)),
            test_driver_bootstrap_complete: Arc::new(AtomicBool::new(false)),
            pending_test_driver_requests: Arc::new(Mutex::new(HashMap::new())),
            test_driver_request_counter: Arc::new(AtomicU64::new(0)),
            claude_command_cache: Arc::new(Mutex::new(HashMap::new())),
            agent_records: Arc::new(Mutex::new(build_agent_record_map(persisted_agents))),
            topic_records: Arc::new(Mutex::new(build_topic_record_map(persisted_topics))),
            chatter_entries: Arc::new(Mutex::new(chatter_entries)),
            agent_log_entries: Arc::new(Mutex::new(agent_log_entries)),
            tile_message_log_entries: Arc::new(Mutex::new(tile_message_log_entries)),
            agent_display_counter: Arc::new(AtomicU64::new(agent_display_counter)),
            agent_subscriber_counter: Arc::new(AtomicU64::new(0)),
            agent_ping_counter: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn set_control(&self, control: Arc<Mutex<TmuxControl>>) {
        let old = self.tmux_control.lock()
            .ok()
            .and_then(|mut guard| guard.take());

        if let Some(ref old_control) = old {
            if let (Ok(mut new_ctrl), Ok(old_ctrl)) = (control.lock(), old_control.lock()) {
                new_ctrl.inherit_state(&old_ctrl);
            }
        }

        if let Ok(ctrl) = control.lock() {
            if let Ok(mut w) = self.tmux_writer.lock() {
                *w = Some(ctrl.writer.clone());
            }
            if let Ok(mut b) = self.output_buffers.lock() {
                *b = Some(ctrl.output_buffers.clone());
            }
        }
        if let Ok(mut c) = self.tmux_control.lock() {
            *c = Some(control);
        }

        if let Some(old_control) = old {
            if let Ok(old_ctrl) = old_control.lock() {
                old_ctrl.terminate();
            }
        }
    }

    pub fn current_control_pid(&self) -> Option<libc::pid_t> {
        let guard = self.tmux_control.lock().ok()?;
        let control = guard.as_ref()?;
        let ctrl = control.lock().ok()?;
        Some(ctrl.child_pid())
    }

    pub fn begin_shutdown(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
    }

    pub fn is_shutting_down(&self) -> bool {
        self.shutting_down.load(Ordering::SeqCst)
    }

    pub fn read_output(&self, session_id: &str) -> Result<String, String> {
        let guard = self.output_buffers.lock().map_err(|e| e.to_string())?;
        let bufs_arc = guard.as_ref().ok_or("output buffers not initialized")?;
        let mut bufs = bufs_arc.lock().map_err(|e| e.to_string())?;
        match bufs.get_mut(session_id) {
            Some(b) => {
                let bytes: Vec<u8> = b.drain(..).collect();
                Ok(String::from_utf8_lossy(&bytes).to_string())
            }
            None => Ok(String::new()),
        }
    }

    pub fn with_control<F, R>(&self, f: F) -> Result<R, String>
    where
        F: FnOnce(&mut TmuxControl) -> Result<R, String>,
    {
        let guard = self.tmux_control.lock().map_err(|e| e.to_string())?;
        let control = guard.as_ref().ok_or("tmux control not initialized")?;
        let mut ctrl = control.lock().map_err(|e| e.to_string())?;
        f(&mut ctrl)
    }

    pub fn set_tile_state(&self, pane_id: &str, tile: TileState) {
        if let Ok(mut states) = self.tile_states.lock() {
            states.insert(pane_id.to_string(), tile);
        }
    }

    pub fn get_tile_state(&self, pane_id: &str) -> Option<TileState> {
        if let Ok(states) = self.tile_states.lock() {
            states.get(pane_id).cloned()
        } else {
            None
        }
    }

    pub fn remove_tile_state(&self, pane_id: &str) {
        if let Ok(mut states) = self.tile_states.lock() {
            states.remove(pane_id);
        }
    }

    pub fn save(&self) {
        if let Ok(states) = self.tile_states.lock() {
            persist::save(&states);
        }
    }

    pub fn next_snapshot_version(&self) -> u64 {
        self.snapshot_version.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn set_last_active_session(&self, session_id: Option<String>) {
        if let Ok(mut active) = self.last_active_session.lock() {
            *active = session_id.filter(|value| !value.trim().is_empty());
        }
    }

    pub fn last_active_session(&self) -> Option<String> {
        self.last_active_session
            .lock()
            .ok()
            .and_then(|active| active.clone())
    }

    pub fn set_window_parent(&self, child_window_id: &str, parent_window_id: Option<String>) {
        self.set_window_parent_with_source(child_window_id, parent_window_id, WindowParentSource::Manual);
    }

    pub fn set_window_parent_with_source(
        &self,
        child_window_id: &str,
        parent_window_id: Option<String>,
        source: WindowParentSource,
    ) {
        if let Ok(mut parents) = self.window_parents.lock() {
            let resolved_parent = parent_window_id
                .and_then(|parent| resolve_root_parent_from_map(&parents, &parent).or(Some(parent)))
                .filter(|parent| parent != child_window_id);
            match resolved_parent {
                Some(parent_window_id) => {
                    parents.insert(
                        child_window_id.to_string(),
                        WindowParentLink {
                            parent_window_id,
                            source,
                        },
                    );
                }
                None => {
                    parents.remove(child_window_id);
                }
            }
        }
    }

    pub fn window_parents_snapshot(&self) -> HashMap<String, String> {
        self.window_parents
            .lock()
            .map(|parents| {
                parents
                    .keys()
                    .filter_map(|child| {
                        resolve_root_parent_from_map(&parents, child)
                            .map(|parent| (child.clone(), parent))
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn window_parent_sources_snapshot(&self) -> HashMap<String, WindowParentSource> {
        self.window_parents
            .lock()
            .map(|parents| {
                parents
                    .iter()
                    .map(|(child, link)| (child.clone(), link.source))
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn resolve_root_window_parent(&self, window_id: &str) -> Option<String> {
        self.window_parents
            .lock()
            .ok()
            .and_then(|parents| resolve_root_parent_from_map(&parents, window_id))
    }

    pub fn retain_window_parents<F>(&self, mut keep: F)
    where
        F: FnMut(&str, &str) -> bool,
    {
        if let Ok(mut parents) = self.window_parents.lock() {
            parents.retain(|child, parent| keep(child, &parent.parent_window_id));
        }
    }

    pub fn set_test_driver_frontend_ready(&self, ready: bool) {
        self.test_driver_frontend_ready.store(ready, Ordering::SeqCst);
    }

    pub fn test_driver_frontend_ready(&self) -> bool {
        self.test_driver_frontend_ready.load(Ordering::SeqCst)
    }

    pub fn set_test_driver_bootstrap_complete(&self, complete: bool) {
        self.test_driver_bootstrap_complete.store(complete, Ordering::SeqCst);
    }

    pub fn test_driver_bootstrap_complete(&self) -> bool {
        self.test_driver_bootstrap_complete.load(Ordering::SeqCst)
    }

    pub fn next_test_driver_request_id(&self) -> String {
        let value = self.test_driver_request_counter.fetch_add(1, Ordering::SeqCst) + 1;
        format!("test-driver-{value}")
    }

    pub fn register_test_driver_request(
        &self,
        request_id: &str,
        sender: Sender<Result<Value, String>>,
    ) -> Result<(), String> {
        let mut pending = self.pending_test_driver_requests.lock().map_err(|e| e.to_string())?;
        pending.insert(request_id.to_string(), sender);
        Ok(())
    }

    pub fn cancel_test_driver_request(&self, request_id: &str) {
        if let Ok(mut pending) = self.pending_test_driver_requests.lock() {
            pending.remove(request_id);
        }
    }

    pub fn resolve_test_driver_request(
        &self,
        request_id: &str,
        result: Result<Value, String>,
    ) -> Result<bool, String> {
        let sender = self
            .pending_test_driver_requests
            .lock()
            .map_err(|e| e.to_string())?
            .remove(request_id);

        if let Some(sender) = sender {
            let _ = sender.send(result);
            return Ok(true);
        }

        Ok(false)
    }
    pub fn cached_claude_commands(
        &self,
        cwd: &str,
    ) -> Option<crate::commands::ClaudeMenuData> {
        self.claude_command_cache
            .lock()
            .ok()
            .and_then(|cache| cache.get(cwd).cloned())
    }

    pub fn set_cached_claude_commands(
        &self,
        cwd: String,
        commands: crate::commands::ClaudeMenuData,
    ) {
        if let Ok(mut cache) = self.claude_command_cache.lock() {
            cache.insert(cwd, commands);
        }
    }

    fn next_agent_display_name(&self) -> String {
        let value = self.agent_display_counter.fetch_add(1, Ordering::SeqCst) + 1;
        format!("Agent {value}")
    }

    fn next_agent_subscriber_id(&self) -> u64 {
        self.agent_subscriber_counter.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn next_ping_id(&self) -> String {
        let value = self.agent_ping_counter.fetch_add(1, Ordering::SeqCst) + 1;
        format!("ping-{value}")
    }

    fn persist_agent_and_topic_state(&self) -> Result<(), String> {
        let agents = self
            .agent_records
            .lock()
            .map_err(|e| e.to_string())?
            .values()
            .map(AgentRecord::to_info)
            .collect::<Vec<_>>();
        let topics = self
            .topic_records
            .lock()
            .map_err(|e| e.to_string())?
            .values()
            .map(|record| PersistedTopicRecord {
                session_id: record.session_id.clone(),
                name: record.name.clone(),
                subscribers: record.subscribers.iter().cloned().collect(),
                last_activity_at: record.last_activity_at,
            })
            .collect::<Vec<_>>();
        db::replace_agents(&agents)?;
        db::replace_topics(&topics)?;
        Ok(())
    }

    fn persist_tile_registry_state(&self) -> Result<(), String> {
        let tiles = self
            .tile_records
            .lock()
            .map_err(|e| e.to_string())?
            .values()
            .cloned()
            .collect::<Vec<_>>();
        tile_registry::replace(&tiles)?;
        Ok(())
    }

    pub fn upsert_agent(
        &self,
        agent_id: String,
        tile_id: String,
        pane_id: String,
        window_id: String,
        session_id: String,
        title: String,
        agent_type: AgentType,
        agent_role: AgentRole,
        agent_pid: Option<u32>,
    ) -> Result<AgentInfo, String> {
        let now_ms = crate::agent::now_ms();
        let mut agents = self.agent_records.lock().map_err(|e| e.to_string())?;
        let record = agents.entry(agent_id.clone()).or_insert_with(|| AgentRecord {
            agent_id: agent_id.clone(),
            agent_type,
            agent_role,
            tile_id: tile_id.clone(),
            pane_id: pane_id.clone(),
            window_id: window_id.clone(),
            session_id: session_id.clone(),
            title: title.clone(),
            display_name: if agent_role == AgentRole::Root {
                "Root".to_string()
            } else {
                self.next_agent_display_name()
            },
            chatter_subscribed: true,
            topics: BTreeSet::new(),
            alive: false,
            welcomed: false,
            registration_ts_ms: now_ms,
            last_seen_ts_ms: now_ms,
            last_ping_sent_at: None,
            last_ping_ack_at: None,
            ping_deadline: None,
            agent_pid,
            subscribers: HashMap::new(),
        });
        record.tile_id = tile_id;
        record.pane_id = pane_id;
        record.window_id = window_id;
        record.session_id = session_id;
        record.title = title;
        record.agent_type = agent_type;
        record.agent_role = agent_role;
        if record.agent_role == AgentRole::Root {
            record.display_name = "Root".to_string();
        }
        record.last_seen_ts_ms = now_ms;
        if agent_pid.is_some() {
            record.agent_pid = agent_pid;
        }
        let info = record.to_info();
        drop(agents);
        self.persist_agent_and_topic_state()?;
        Ok(info)
    }

    pub fn replace_agents_snapshot(&self, agents: Vec<AgentInfo>) -> Result<(), String> {
        let mut records = self.agent_records.lock().map_err(|e| e.to_string())?;
        *records = build_agent_record_map(agents);
        drop(records);
        self.persist_agent_and_topic_state()
    }

    pub fn unregister_agent(&self, agent_id: &str) -> Result<Option<AgentInfo>, String> {
        let mut agents = self.agent_records.lock().map_err(|e| e.to_string())?;
        let removed = agents.remove(agent_id).map(|record| record.to_info());
        drop(agents);
        self.persist_agent_and_topic_state()?;
        Ok(removed)
    }

    pub fn agent_info(&self, agent_id: &str) -> Result<Option<AgentInfo>, String> {
        let agents = self.agent_records.lock().map_err(|e| e.to_string())?;
        Ok(agents.get(agent_id).map(AgentRecord::to_info))
    }

    pub fn root_agent_in_session(&self, session_id: &str) -> Result<Option<AgentInfo>, String> {
        let agents = self.agent_records.lock().map_err(|e| e.to_string())?;
        Ok(preferred_agent_record(
            agents
                .values()
                .filter(|record| record.session_id == session_id && record.agent_role == AgentRole::Root),
        )
        .map(AgentRecord::to_info))
    }

    pub fn agent_info_by_tile(&self, tile_id: &str) -> Result<Option<AgentInfo>, String> {
        let agents = self.agent_records.lock().map_err(|e| e.to_string())?;
        Ok(preferred_agent_record(agents.values().filter(|record| record.tile_id == tile_id))
            .map(AgentRecord::to_info))
    }

    pub fn agent_info_by_tile_role(&self, tile_id: &str, agent_role: AgentRole) -> Result<Option<AgentInfo>, String> {
        let agents = self.agent_records.lock().map_err(|e| e.to_string())?;
        Ok(preferred_agent_record(
            agents
                .values()
                .filter(|record| record.tile_id == tile_id && record.agent_role == agent_role),
        )
        .map(AgentRecord::to_info))
    }

    pub fn agent_info_by_pane(&self, pane_id: &str) -> Result<Option<AgentInfo>, String> {
        let agents = self.agent_records.lock().map_err(|e| e.to_string())?;
        Ok(preferred_agent_record(agents.values().filter(|record| record.pane_id == pane_id))
            .map(AgentRecord::to_info))
    }

    pub fn agent_info_by_pane_role(&self, pane_id: &str, agent_role: AgentRole) -> Result<Option<AgentInfo>, String> {
        let agents = self.agent_records.lock().map_err(|e| e.to_string())?;
        Ok(preferred_agent_record(
            agents
                .values()
                .filter(|record| record.pane_id == pane_id && record.agent_role == agent_role),
        )
        .map(AgentRecord::to_info))
    }

    pub fn tile_record(&self, tile_id: &str) -> Result<Option<TileRecord>, String> {
        let tiles = self.tile_records.lock().map_err(|e| e.to_string())?;
        Ok(tiles.get(tile_id).cloned())
    }

    pub fn tile_record_by_pane(&self, pane_id: &str) -> Result<Option<TileRecord>, String> {
        let tiles = self.tile_records.lock().map_err(|e| e.to_string())?;
        Ok(tiles.values().find(|record| record.pane_id == pane_id).cloned())
    }

    pub fn tile_record_by_window(&self, window_id: &str) -> Result<Option<TileRecord>, String> {
        let tiles = self.tile_records.lock().map_err(|e| e.to_string())?;
        Ok(tiles.values().find(|record| record.window_id == window_id).cloned())
    }

    pub fn list_tile_records_in_session(&self, session_id: &str) -> Result<Vec<TileRecord>, String> {
        let tiles = self.tile_records.lock().map_err(|e| e.to_string())?;
        let mut list = tiles
            .values()
            .filter(|record| record.session_id == session_id)
            .cloned()
            .collect::<Vec<_>>();
        list.sort_by(|left, right| left.tile_id.cmp(&right.tile_id));
        Ok(list)
    }

    pub fn tile_records_snapshot(&self) -> Result<Vec<TileRecord>, String> {
        let tiles = self.tile_records.lock().map_err(|e| e.to_string())?;
        let mut list = tiles.values().cloned().collect::<Vec<_>>();
        list.sort_by(|left, right| {
            left.session_id
                .cmp(&right.session_id)
                .then_with(|| left.tile_id.cmp(&right.tile_id))
        });
        Ok(list)
    }

    pub fn replace_tile_records(&self, records: Vec<TileRecord>) -> Result<(), String> {
        let mut tiles = self.tile_records.lock().map_err(|e| e.to_string())?;
        *tiles = build_tile_record_map(records);
        drop(tiles);
        self.persist_tile_registry_state()
    }

    pub fn upsert_tile_record(&self, record: TileRecord) -> Result<TileRecord, String> {
        let mut tiles = self.tile_records.lock().map_err(|e| e.to_string())?;
        tiles.insert(record.tile_id.clone(), record.clone());
        drop(tiles);
        self.persist_tile_registry_state()?;
        Ok(record)
    }

    pub fn remove_tile_record(&self, tile_id: &str) -> Result<Option<TileRecord>, String> {
        let mut tiles = self.tile_records.lock().map_err(|e| e.to_string())?;
        let removed = tiles.remove(tile_id);
        drop(tiles);
        self.persist_tile_registry_state()?;
        Ok(removed)
    }

    pub fn list_agents_in_session(&self, session_id: &str) -> Result<Vec<AgentInfo>, String> {
        let agents = self.agent_records.lock().map_err(|e| e.to_string())?;
        let mut list = agents
            .values()
            .filter(|record| record.session_id == session_id)
            .map(AgentRecord::to_info)
            .collect::<Vec<_>>();
        list.sort_by(|left, right| left.display_name.cmp(&right.display_name));
        Ok(list)
    }

    pub fn agent_infos_snapshot(&self) -> Result<Vec<AgentInfo>, String> {
        let agents = self.agent_records.lock().map_err(|e| e.to_string())?;
        let mut list = agents.values().map(AgentRecord::to_info).collect::<Vec<_>>();
        list.sort_by(|left, right| {
            left.session_id
                .cmp(&right.session_id)
                .then_with(|| left.display_name.cmp(&right.display_name))
        });
        Ok(list)
    }

    pub fn list_topics_in_session(&self, session_id: &str) -> Result<Vec<TopicInfo>, String> {
        let topics = self.topic_records.lock().map_err(|e| e.to_string())?;
        let mut list = topics
            .values()
            .filter(|record| record.session_id == session_id)
            .map(|record| TopicInfo {
                session_id: record.session_id.clone(),
                name: record.name.clone(),
                subscriber_count: record.subscribers.len(),
                last_activity_at: record.last_activity_at,
            })
            .collect::<Vec<_>>();
        list.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(list)
    }

    pub fn chatter_entries(&self) -> Result<Vec<ChatterEntry>, String> {
        self.chatter_entries
            .lock()
            .map(|entries| entries.clone())
            .map_err(|e| e.to_string())
    }

    pub fn chatter_entries_in_session(&self, session_id: &str) -> Result<Vec<ChatterEntry>, String> {
        let entries = self.chatter_entries.lock().map_err(|e| e.to_string())?;
        Ok(entries
            .iter()
            .filter(|entry| entry.session_id == session_id)
            .cloned()
            .collect())
    }

    pub fn agent_log_entries_in_session(&self, session_id: &str) -> Result<Vec<AgentLogEntry>, String> {
        let entries = self.agent_log_entries.lock().map_err(|e| e.to_string())?;
        Ok(entries
            .iter()
            .filter(|entry| entry.session_id == session_id)
            .cloned()
            .collect())
    }

    pub fn tile_message_log_entries_in_session(&self, session_id: &str) -> Result<Vec<TileMessageLogEntry>, String> {
        let entries = self.tile_message_log_entries.lock().map_err(|e| e.to_string())?;
        Ok(entries
            .iter()
            .filter(|entry| entry.session_id == session_id)
            .cloned()
            .collect())
    }

    pub fn public_chatter_since_in_session(
        &self,
        session_id: &str,
        cutoff_ms: i64,
    ) -> Result<Vec<ChatterEntry>, String> {
        let entries = self.chatter_entries.lock().map_err(|e| e.to_string())?;
        Ok(entries
            .iter()
            .filter(|entry| entry.session_id == session_id && entry.public && entry.timestamp_ms >= cutoff_ms)
            .cloned()
            .collect())
    }

    pub fn append_chatter_entry(&self, entry: ChatterEntry) -> Result<(), String> {
        persist::append_chatter_entry(&entry)?;
        self.chatter_entries
            .lock()
            .map_err(|e| e.to_string())?
            .push(entry);
        Ok(())
    }

    pub fn append_agent_log_entry(&self, entry: AgentLogEntry) -> Result<(), String> {
        persist::append_agent_log_entry(&entry)?;
        self.agent_log_entries
            .lock()
            .map_err(|e| e.to_string())?
            .push(entry);
        Ok(())
    }

    pub fn append_tile_message_log_entry(&self, entry: TileMessageLogEntry) -> Result<(), String> {
        persist::append_tile_message_log_entry(&entry)?;
        self.tile_message_log_entries
            .lock()
            .map_err(|e| e.to_string())?
            .push(entry);
        Ok(())
    }

    pub fn clear_debug_logs(&self) -> Result<(), String> {
        persist::clear_log_entries()?;
        self.chatter_entries
            .lock()
            .map_err(|e| e.to_string())?
            .clear();
        self.agent_log_entries
            .lock()
            .map_err(|e| e.to_string())?
            .clear();
        self.tile_message_log_entries
            .lock()
            .map_err(|e| e.to_string())?
            .clear();
        Ok(())
    }

    pub fn snapshot_agent_debug_state_for_session(&self, session_id: &str) -> Result<AgentDebugState, String> {
        Ok(AgentDebugState {
            agents: self.list_agents_in_session(session_id)?,
            topics: self.list_topics_in_session(session_id)?,
            chatter: self.chatter_entries_in_session(session_id)?,
            agent_logs: self.agent_log_entries_in_session(session_id)?,
            tile_message_logs: self.tile_message_log_entries_in_session(session_id)?,
            connections: network::list_connections_at(std::path::Path::new(crate::runtime::database_path()), session_id)?,
        })
    }

    pub fn subscribe_agent_events(
        &self,
        agent_id: &str,
        sender: UnboundedSender<AgentStreamEnvelope>,
    ) -> Result<AgentSubscriptionInit, String> {
        let subscriber_id = self.next_agent_subscriber_id();
        let now_ms = crate::agent::now_ms();
        let now = Instant::now();
        let mut agents = self.agent_records.lock().map_err(|e| e.to_string())?;
        let record = agents
            .get_mut(agent_id)
            .ok_or_else(|| format!("unknown agent: {agent_id}"))?;
        record.subscribers.insert(subscriber_id, sender);
        record.last_seen_ts_ms = now_ms;
        record.last_ping_ack_at = Some(now);
        record.ping_deadline = None;
        let signed_on = !record.alive;
        record.alive = true;
        let bootstrap = !record.welcomed;
        if bootstrap {
            record.welcomed = true;
        }
        let init = AgentSubscriptionInit {
            subscriber_id,
            signed_on,
            bootstrap,
            info: record.to_info(),
        };
        drop(agents);
        self.persist_agent_and_topic_state()?;
        Ok(init)
    }

    pub fn unsubscribe_agent_events(&self, agent_id: &str, subscriber_id: u64) -> Result<Option<AgentInfo>, String> {
        let mut agents = self.agent_records.lock().map_err(|e| e.to_string())?;
        let Some(record) = agents.get_mut(agent_id) else {
            return Ok(None);
        };
        record.subscribers.remove(&subscriber_id);
        if !record.alive || !record.subscribers.is_empty() {
            return Ok(None);
        }
        record.alive = false;
        record.ping_deadline = None;
        record.subscribers.clear();
        let info = record.to_info();
        drop(agents);
        self.persist_agent_and_topic_state()?;
        Ok(Some(info))
    }

    pub fn send_event_to_agent(
        &self,
        agent_id: &str,
        event: AgentChannelEvent,
    ) -> Result<(), String> {
        let mut agents = self.agent_records.lock().map_err(|e| e.to_string())?;
        let record = agents
            .get_mut(agent_id)
            .ok_or_else(|| format!("unknown agent: {agent_id}"))?;
        let envelope = AgentStreamEnvelope::Event { event };
        record
            .subscribers
            .retain(|_, sender| sender.send(envelope.clone()).is_ok());
        if record.subscribers.is_empty() {
            return Err(format!("agent {agent_id} has no live subscribers"));
        }
        record.last_seen_ts_ms = crate::agent::now_ms();
        Ok(())
    }

    pub fn broadcast_event_in_session(
        &self,
        session_id: &str,
        event: AgentChannelEvent,
        include_dead: bool,
    ) -> Result<Vec<String>, String> {
        let mut failed = Vec::new();
        let mut agents = self.agent_records.lock().map_err(|e| e.to_string())?;
        for record in agents.values_mut() {
            if record.session_id != session_id {
                continue;
            }
            if !include_dead && !record.alive {
                continue;
            }
            let envelope = AgentStreamEnvelope::Event {
                event: event.clone(),
            };
            record
                .subscribers
                .retain(|_, sender| sender.send(envelope.clone()).is_ok());
            if record.subscribers.is_empty() && record.alive {
                failed.push(record.agent_id.clone());
            }
        }
        Ok(failed)
    }

    pub fn ack_agent_ping(&self, agent_id: &str) -> Result<AgentInfo, String> {
        let now_ms = crate::agent::now_ms();
        let now = Instant::now();
        let mut agents = self.agent_records.lock().map_err(|e| e.to_string())?;
        let record = agents
            .get_mut(agent_id)
            .ok_or_else(|| format!("unknown agent: {agent_id}"))?;
        record.alive = true;
        record.last_seen_ts_ms = now_ms;
        record.last_ping_ack_at = Some(now);
        record.ping_deadline = None;
        let info = record.to_info();
        drop(agents);
        self.persist_agent_and_topic_state()?;
        Ok(info)
    }

    pub fn prepare_agent_ping_cycle(
        &self,
        interval: Duration,
        timeout: Duration,
    ) -> Result<AgentPingCycle, String> {
        let now = Instant::now();
        let mut agents = self.agent_records.lock().map_err(|e| e.to_string())?;
        let mut expired = Vec::new();
        let mut to_ping = Vec::new();
        for record in agents.values_mut() {
            if !record.alive {
                continue;
            }
            if let Some(deadline) = record.ping_deadline {
                if now >= deadline {
                    expired.push(record.agent_id.clone());
                    continue;
                }
                continue;
            }
            let due = record
                .last_ping_sent_at
                .map(|sent| now.duration_since(sent) >= interval)
                .unwrap_or(true);
            if due {
                let ping_id = self.next_ping_id();
                record.last_ping_sent_at = Some(now);
                record.ping_deadline = Some(now + timeout);
                to_ping.push((record.agent_id.clone(), ping_id));
            }
        }
        Ok(AgentPingCycle { to_ping, expired })
    }

    pub fn mark_agent_dead(&self, agent_id: &str) -> Result<Option<AgentInfo>, String> {
        let mut agents = self.agent_records.lock().map_err(|e| e.to_string())?;
        let Some(record) = agents.get_mut(agent_id) else {
            return Ok(None);
        };
        if !record.alive {
            return Ok(None);
        }
        record.alive = false;
        record.ping_deadline = None;
        record.subscribers.clear();
        let info = record.to_info();
        drop(agents);
        self.persist_agent_and_topic_state()?;
        Ok(Some(info))
    }

    pub fn topic_subscribe(&self, agent_id: &str, topic: &str) -> Result<TopicInfo, String> {
        let mut agents = self.agent_records.lock().map_err(|e| e.to_string())?;
        let record = agents
            .get_mut(agent_id)
            .ok_or_else(|| format!("unknown agent: {agent_id}"))?;
        let session_id = record.session_id.clone();
        record.topics.insert(topic.to_string());
        drop(agents);

        let mut topics = self.topic_records.lock().map_err(|e| e.to_string())?;
        let topic_record = topics
            .entry(topic_key(&session_id, topic))
            .or_insert_with(|| TopicRecord {
            session_id: session_id.clone(),
            name: topic.to_string(),
            subscribers: BTreeSet::new(),
            last_activity_at: None,
        });
        topic_record.subscribers.insert(agent_id.to_string());
        let info = TopicInfo {
            session_id: topic_record.session_id.clone(),
            name: topic_record.name.clone(),
            subscriber_count: topic_record.subscribers.len(),
            last_activity_at: topic_record.last_activity_at,
        };
        drop(topics);
        self.persist_agent_and_topic_state()?;
        Ok(info)
    }

    pub fn topic_unsubscribe(&self, agent_id: &str, topic: &str) -> Result<TopicInfo, String> {
        let session_id = if let Ok(mut agents) = self.agent_records.lock() {
            if let Some(record) = agents.get_mut(agent_id) {
                record.topics.remove(topic);
                record.session_id.clone()
            } else {
                return Err(format!("unknown agent: {agent_id}"));
            }
        } else {
            return Err("failed to acquire agent registry lock".to_string());
        };

        let mut topics = self.topic_records.lock().map_err(|e| e.to_string())?;
        let topic_record = topics
            .entry(topic_key(&session_id, topic))
            .or_insert_with(|| TopicRecord {
            session_id: session_id.clone(),
            name: topic.to_string(),
            subscribers: BTreeSet::new(),
            last_activity_at: None,
        });
        topic_record.subscribers.remove(agent_id);
        let info = TopicInfo {
            session_id: topic_record.session_id.clone(),
            name: topic_record.name.clone(),
            subscriber_count: topic_record.subscribers.len(),
            last_activity_at: topic_record.last_activity_at,
        };
        drop(topics);
        self.persist_agent_and_topic_state()?;
        Ok(info)
    }

    pub fn touch_topics_in_session(&self, session_id: &str, topics_to_touch: &[String]) -> Result<(), String> {
        let now = crate::agent::now_ms();
        let mut topics = self.topic_records.lock().map_err(|e| e.to_string())?;
        for topic in topics_to_touch {
            let record = topics
                .entry(topic_key(session_id, topic))
                .or_insert_with(|| TopicRecord {
                session_id: session_id.to_string(),
                name: topic.clone(),
                subscribers: BTreeSet::new(),
                last_activity_at: None,
            });
            record.last_activity_at = Some(now);
        }
        drop(topics);
        self.persist_agent_and_topic_state()?;
        Ok(())
    }

    pub fn resolve_display_name(&self, agent_id: Option<&str>, fallback: &str) -> String {
        if let Some(agent_id) = agent_id {
            if let Ok(agents) = self.agent_records.lock() {
                if let Some(record) = agents.get(agent_id) {
                    return record.display_name.clone();
                }
            }
        }
        fallback.to_string()
    }
}

fn build_agent_record_map(agents: Vec<AgentInfo>) -> HashMap<String, AgentRecord> {
    agents
        .into_iter()
        .map(|agent| {
            let record = AgentRecord {
                agent_id: agent.agent_id.clone(),
                agent_type: agent.agent_type,
                agent_role: agent.agent_role,
                tile_id: agent.tile_id.clone(),
                pane_id: if agent.pane_id.trim().is_empty() {
                    agent.tile_id.clone()
                } else {
                    agent.pane_id.clone()
                },
                window_id: agent.window_id.clone(),
                session_id: agent.session_id.clone(),
                title: agent.title.clone(),
                display_name: agent.display_name.clone(),
                chatter_subscribed: agent.chatter_subscribed,
                topics: agent.topics.iter().cloned().collect(),
                alive: agent.alive,
                welcomed: true,
                registration_ts_ms: 0,
                last_seen_ts_ms: 0,
                last_ping_sent_at: None,
                last_ping_ack_at: None,
                ping_deadline: None,
                agent_pid: agent.agent_pid,
                subscribers: HashMap::new(),
            };
            (record.agent_id.clone(), record)
        })
        .collect()
}

fn preferred_agent_record<'a, I>(records: I) -> Option<&'a AgentRecord>
where
    I: IntoIterator<Item = &'a AgentRecord>,
{
    records.into_iter().max_by(|left, right| {
        left.alive
            .cmp(&right.alive)
            .then_with(|| left.last_seen_ts_ms.cmp(&right.last_seen_ts_ms))
            .then_with(|| left.registration_ts_ms.cmp(&right.registration_ts_ms))
            .then_with(|| left.agent_id.cmp(&right.agent_id))
    })
}

fn build_topic_record_map(topics: Vec<PersistedTopicRecord>) -> HashMap<String, TopicRecord> {
    topics
        .into_iter()
        .map(|topic| {
            let record = TopicRecord {
                session_id: topic.session_id.clone(),
                name: topic.name.clone(),
                subscribers: topic.subscribers.into_iter().collect(),
                last_activity_at: topic.last_activity_at,
            };
            (topic_key(&record.session_id, &record.name), record)
        })
        .collect()
}

fn build_tile_record_map(records: Vec<TileRecord>) -> HashMap<String, TileRecord> {
    records
        .into_iter()
        .map(|record| (record.tile_id.clone(), record))
        .collect()
}

fn topic_key(session_id: &str, topic: &str) -> String {
    format!("{session_id}::{topic}")
}

fn parse_agent_display_index(display_name: &str) -> Option<u64> {
    display_name
        .strip_prefix("Agent ")
        .and_then(|value| value.trim().parse::<u64>().ok())
}

fn resolve_root_parent_from_map(
    parents: &HashMap<String, WindowParentLink>,
    window_id: &str,
) -> Option<String> {
    let mut current = parents.get(window_id)?.parent_window_id.clone();
    let mut seen = std::collections::HashSet::from([window_id.to_string()]);

    loop {
      if !seen.insert(current.clone()) {
          return None;
      }
      match parents.get(&current) {
          Some(next) => current = next.parent_window_id.clone(),
          None => return Some(current),
      }
    }
}

#[cfg(test)]
mod tests {
    use super::{preferred_agent_record, AgentRecord};
    use crate::agent::{AgentRole, AgentType};
    use std::collections::{BTreeSet, HashMap};

    fn record(agent_id: &str, tile_id: &str, alive: bool, last_seen_ts_ms: i64) -> AgentRecord {
        AgentRecord {
            agent_id: agent_id.to_string(),
            agent_type: AgentType::Claude,
            agent_role: AgentRole::Worker,
            tile_id: tile_id.to_string(),
            pane_id: tile_id.to_string(),
            window_id: "@1".to_string(),
            session_id: "$1".to_string(),
            title: "Agent".to_string(),
            display_name: agent_id.to_string(),
            chatter_subscribed: true,
            topics: BTreeSet::new(),
            alive,
            welcomed: true,
            registration_ts_ms: last_seen_ts_ms,
            last_seen_ts_ms,
            last_ping_sent_at: None,
            last_ping_ack_at: None,
            ping_deadline: None,
            agent_pid: None,
            subscribers: HashMap::new(),
        }
    }

    #[test]
    fn prefers_live_agents_for_a_tile_over_dead_ones() {
        let dead = record("agent-dead", "%7", false, 10);
        let live = record("agent-live", "%7", true, 5);
        let selected = preferred_agent_record([&dead, &live]).unwrap();
        assert_eq!(selected.agent_id, "agent-live");
    }

    #[test]
    fn prefers_most_recent_dead_agent_when_no_live_agent_exists() {
        let older = record("agent-older", "%7", false, 10);
        let newer = record("agent-newer", "%7", false, 20);
        let selected = preferred_agent_record([&older, &newer]).unwrap();
        assert_eq!(selected.agent_id, "agent-newer");
    }
}
