use std::fs::OpenOptions;
use std::io::Write as IoWrite;
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::collections::BTreeSet;
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use serde::{de::DeserializeOwned, Deserialize};
use tokio::sync::mpsc as tokio_mpsc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixListener;
use tauri::{AppHandle, Emitter, Manager};

use crate::agent::{
    collect_mentions, format_channel_display, format_direct_display, format_network_display,
    format_public_display, format_root_display, format_sign_off_display,
    format_sign_on_display, now_ms, AgentChannelEvent,
    AgentChannelEventKind, AgentRole, ChatterEntry, ChatterKind,
};
use crate::persist::TileState;
use crate::state::AppState;
use crate::tile_message::{TileMessageChannel, TileMessageLogEntry, TileMessageLogLayer, TileMessageOutcome};
use crate::{network, runtime, tmux, work};

use super::protocol::{SocketCommand, SocketResponse, TestDriverRequest};

const AGENT_PING_INTERVAL: Duration = Duration::from_secs(15);
const AGENT_PING_TIMEOUT: Duration = Duration::from_secs(10);
const AGENT_REPLAY_WINDOW_MS: i64 = 60 * 60 * 1000;
const HERD_WORKER_WELCOME_MESSAGE: &str = "Welcome to Herd. Review the /herd-worker skill, inspect the recent public activity in your session, and coordinate through public, network, direct, or root messages. Root manages the full session-wide MCP surface.";
const HERD_ROOT_WELCOME_MESSAGE: &str = "You are the Root agent for this session. Review the /herd-root skill, handle messages sent to Root, coordinate session work, and use the full Herd MCP surface on behalf of this session.";
const GRID_SNAP: f64 = 20.0;
const GAP: f64 = 30.0;
const DEFAULT_TILE_WIDTH: f64 = 640.0;
const DEFAULT_TILE_HEIGHT: f64 = 400.0;
const WORK_CARD_WIDTH: f64 = 360.0;
const WORK_CARD_HEIGHT: f64 = 320.0;

fn parse_agent_type(value: Option<&str>) -> Result<crate::agent::AgentType, String> {
    match value.unwrap_or("claude").trim() {
        "" | "claude" => Ok(crate::agent::AgentType::Claude),
        "fixture" if runtime::test_driver_enabled() => Ok(crate::agent::AgentType::Fixture),
        other => Err(format!("unsupported agent type: {other}")),
    }
}

fn parse_agent_role(value: Option<&str>) -> Result<crate::agent::AgentRole, String> {
    match value.unwrap_or("worker").trim() {
        "root" => Ok(crate::agent::AgentRole::Root),
        "" | "worker" => Ok(crate::agent::AgentRole::Worker),
        other => Err(format!("unsupported agent role: {other}")),
    }
}

struct SocketLogger {
    file: std::fs::File,
}

impl SocketLogger {
    fn open() -> Option<Self> {
        let log_path = runtime::socket_log_path().to_string();
        log::info!("Socket traffic logging to {log_path}");
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .ok()
            .map(|file| Self { file })
    }

    fn log(&mut self, direction: &str, data: &str) {
        let now = chrono::Local::now().format("%H:%M:%S%.3f");
        let _ = writeln!(self.file, "[{now}] {direction} {}", data.trim());
    }
}

type SharedLogger = Arc<Mutex<Option<SocketLogger>>>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct SocketPathIdentity {
    dev: u64,
    ino: u64,
}

fn socket_binding_identity() -> &'static Mutex<Option<SocketPathIdentity>> {
    static SOCKET_BINDING_IDENTITY: OnceLock<Mutex<Option<SocketPathIdentity>>> = OnceLock::new();
    SOCKET_BINDING_IDENTITY.get_or_init(|| Mutex::new(None))
}

fn current_socket_path_identity(path: &Path) -> Option<SocketPathIdentity> {
    let metadata = std::fs::metadata(path).ok()?;
    Some(SocketPathIdentity {
        dev: metadata.dev(),
        ino: metadata.ino(),
    })
}

fn remember_socket_binding(path: &Path) {
    *socket_binding_identity().lock().expect("socket binding identity lock poisoned") =
        current_socket_path_identity(path);
}

fn remove_stale_socket_path(path: &Path) {
    if path.exists() {
        let _ = std::fs::remove_file(path);
    }
}

fn cleanup_owned_socket_path(path: &Path) {
    let recorded = socket_binding_identity()
        .lock()
        .expect("socket binding identity lock poisoned")
        .take();
    let current = current_socket_path_identity(path);
    if current.is_some() && current == recorded {
        let _ = std::fs::remove_file(path);
    }
}

fn emit_agent_state(app: &AppHandle, state: &AppState) {
    let Ok(session_id) = resolve_ui_session_id(state) else {
        return;
    };
    if let Ok(snapshot) = state.snapshot_agent_debug_state_for_session(&session_id) {
        let _ = app.emit("herd-agent-state", snapshot);
    }
}

fn emit_work_updated(app: &AppHandle, item: &work::WorkItem) {
    let _ = app.emit(
        "herd-work-updated",
        serde_json::json!({
            "session_id": item.session_id,
            "work_id": item.work_id,
        }),
    );
}

fn emit_layout_updated(
    app: &AppHandle,
    tile: &network::SessionTileInfo,
    layout: &TileState,
    request_resize: bool,
) {
    let _ = app.emit(
        "herd-layout-entry",
        serde_json::json!({
            "entry_id": tile
                .window_id
                .as_deref()
                .unwrap_or(tile.tile_id.as_str()),
            "tile_id": tile.tile_id.clone(),
            "pane_id": tile.pane_id.clone(),
            "window_id": tile.window_id.clone(),
            "x": layout.x,
            "y": layout.y,
            "width": layout.width,
            "height": layout.height,
            "request_resize": request_resize,
        }),
    );
}

fn emit_arrange_elk(app: &AppHandle, session_id: &str) {
    let _ = app.emit(
        "herd-arrange-elk",
        serde_json::json!({
            "session_id": session_id,
        }),
    );
}

fn append_chatter_entry(state: &AppState, app: &AppHandle, entry: ChatterEntry) -> Result<(), String> {
    state.append_chatter_entry(entry.clone())?;
    if resolve_ui_session_id(state).ok().as_deref() == Some(entry.session_id.as_str()) {
        let _ = app.emit("herd-chatter-entry", &entry);
    }
    Ok(())
}

fn append_tile_message_log_entry(
    state: &AppState,
    app: &AppHandle,
    entry: TileMessageLogEntry,
) -> Result<(), String> {
    state.append_tile_message_log_entry(entry)?;
    emit_agent_state(app, state);
    Ok(())
}

#[derive(Clone)]
struct SenderContext {
    session_id: String,
    sender_agent_id: Option<String>,
    display_name: String,
    sender_agent_role: Option<AgentRole>,
    sender_tile_id: Option<String>,
    sender_window_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DispatchErrorKind {
    NotFound,
    Error,
}

#[derive(Debug, Clone)]
struct DispatchError {
    kind: DispatchErrorKind,
    message: String,
}

type DispatchResult = Result<Option<serde_json::Value>, DispatchError>;

impl DispatchError {
    fn not_found(message: impl Into<String>) -> Self {
        Self {
            kind: DispatchErrorKind::NotFound,
            message: message.into(),
        }
    }

    fn error(message: impl Into<String>) -> Self {
        Self {
            kind: DispatchErrorKind::Error,
            message: message.into(),
        }
    }
}

impl From<String> for DispatchError {
    fn from(message: String) -> Self {
        Self::error(message)
    }
}

fn is_tile_target_kind(target_kind: &str) -> bool {
    matches!(target_kind, "shell" | "browser" | "agent" | "root_agent" | "work" | "network")
}

fn collect_related_tile_ids_from_value(value: &serde_json::Value, related_tile_ids: &mut BTreeSet<String>) {
    let Some(object) = value.as_object() else {
        return;
    };
    for key in ["tile_id", "from_tile_id", "to_tile_id"] {
        if let Some(tile_id) = object.get(key).and_then(serde_json::Value::as_str) {
            related_tile_ids.insert(tile_id.to_string());
        }
    }
}

fn related_tile_ids_for_dispatch(
    target_kind: &str,
    target_id: &str,
    sender: Option<&SenderContext>,
    args: &serde_json::Value,
    result: &DispatchResult,
) -> Vec<String> {
    let mut related_tile_ids = BTreeSet::new();
    if let Some(sender_tile_id) = sender.and_then(|context| context.sender_tile_id.as_deref()) {
        related_tile_ids.insert(sender_tile_id.to_string());
    }
    if is_tile_target_kind(target_kind) {
        related_tile_ids.insert(target_id.to_string());
    }
    collect_related_tile_ids_from_value(args, &mut related_tile_ids);
    if let Ok(Some(data)) = result {
        collect_related_tile_ids_from_value(data, &mut related_tile_ids);
    }
    related_tile_ids.into_iter().collect()
}

fn dispatch_result_with_log<F>(
    state: &AppState,
    app: &AppHandle,
    layer: TileMessageLogLayer,
    channel: TileMessageChannel,
    session_id: String,
    target_id: String,
    target_kind: String,
    wrapper_command: &str,
    message_name: &str,
    sender: Option<&SenderContext>,
    args: serde_json::Value,
    dispatch: F,
) -> DispatchResult
where
    F: FnOnce() -> DispatchResult,
{
    let started = Instant::now();
    let result = dispatch();
    let duration_ms = started.elapsed().as_millis() as i64;
    let (outcome, error) = match &result {
        Ok(_) => (TileMessageOutcome::Ok, None),
        Err(dispatch_error) => (
            match dispatch_error.kind {
                DispatchErrorKind::NotFound => TileMessageOutcome::NotFound,
                DispatchErrorKind::Error => TileMessageOutcome::Error,
            },
            Some(dispatch_error.message.clone()),
        ),
    };
    let related_tile_ids = related_tile_ids_for_dispatch(&target_kind, &target_id, sender, &args, &result);

    if let Err(log_error) = append_tile_message_log_entry(
        state,
        app,
        TileMessageLogEntry {
            session_id,
            layer,
            channel,
            target_id,
            target_kind,
            wrapper_command: wrapper_command.to_string(),
            message_name: message_name.to_string(),
            caller_agent_id: sender.and_then(|context| context.sender_agent_id.clone()),
            caller_tile_id: sender.and_then(|context| context.sender_tile_id.clone()),
            caller_window_id: sender.and_then(|context| context.sender_window_id.clone()),
            args,
            related_tile_ids,
            outcome,
            error: error.clone(),
            duration_ms,
            timestamp_ms: now_ms(),
        },
    ) {
        log::warn!("Failed to append tile message log entry: {log_error}");
    }

    result
}

fn dispatch_with_log<F>(
    state: &AppState,
    app: &AppHandle,
    channel: TileMessageChannel,
    session_id: String,
    target_id: String,
    target_kind: String,
    wrapper_command: &str,
    message_name: &str,
    sender: Option<&SenderContext>,
    args: serde_json::Value,
    dispatch: F,
) -> SocketResponse
where
    F: FnOnce() -> DispatchResult,
{
    let result = dispatch_result_with_log(
        state,
        app,
        TileMessageLogLayer::Socket,
        channel,
        session_id,
        target_id,
        target_kind,
        wrapper_command,
        message_name,
        sender,
        args,
        dispatch,
    );

    match result {
        Ok(data) => SocketResponse::success(data),
        Err(error) => SocketResponse::error(error.message),
    }
}

fn resolve_ui_session_id(state: &AppState) -> Result<String, String> {
    if let Some(session_id) = state.last_active_session() {
        return Ok(session_id);
    }
    crate::tmux_state::snapshot(state)?
        .active_session_id
        .ok_or("no active session available".to_string())
}

fn resolve_session_id_for_tile(state: &AppState, tile_id: &str) -> Result<String, String> {
    if let Ok(item) = work::get_work_item_by_tile_id_at(Path::new(runtime::database_path()), tile_id) {
        return Ok(item.session_id);
    }
    state
        .tile_record(tile_id)?
        .map(|record| record.session_id)
        .ok_or_else(|| format!("unknown tile: {tile_id}"))
}

fn resolve_sender_context(
    state: &AppState,
    sender_agent_id: Option<String>,
    sender_tile_id: Option<String>,
) -> Result<SenderContext, String> {
    if let Some(agent_id) = sender_agent_id {
        let agent = live_agent_info(state, &agent_id)?;
        return Ok(SenderContext {
            session_id: agent.session_id,
            sender_agent_id: Some(agent.agent_id),
            display_name: agent.display_name,
            sender_agent_role: Some(agent.agent_role),
            sender_tile_id: Some(agent.tile_id),
            sender_window_id: Some(agent.window_id),
        });
    }

    if let Some(tile_id) = sender_tile_id {
        if let Ok(Some(agent)) = state.agent_info_by_tile(&tile_id) {
            if agent.alive {
                return Ok(SenderContext {
                    session_id: agent.session_id,
                    sender_agent_id: Some(agent.agent_id.clone()),
                    display_name: agent.display_name,
                    sender_agent_role: Some(agent.agent_role),
                    sender_tile_id: Some(agent.tile_id),
                    sender_window_id: Some(agent.window_id),
                });
            }
        }
        if let Ok(item) = work::get_work_item_by_tile_id_at(Path::new(runtime::database_path()), &tile_id) {
            return Ok(SenderContext {
                session_id: item.session_id,
                sender_agent_id: None,
                display_name: "HERD".to_string(),
                sender_agent_role: None,
                sender_tile_id: Some(tile_id),
                sender_window_id: None,
            });
        }
        let record = state
            .tile_record(&tile_id)?
            .ok_or_else(|| format!("unknown tile: {tile_id}"))?;
        return Ok(SenderContext {
            session_id: record.session_id,
            sender_agent_id: None,
            display_name: "HERD".to_string(),
            sender_agent_role: None,
            sender_tile_id: Some(record.tile_id),
            sender_window_id: Some(record.window_id),
        });
    }

    Ok(SenderContext {
        session_id: resolve_ui_session_id(state)?,
        sender_agent_id: None,
        display_name: "HERD".to_string(),
        sender_agent_role: None,
        sender_tile_id: None,
        sender_window_id: None,
    })
}

fn resolve_user_sender_context(state: &AppState) -> Result<SenderContext, String> {
    Ok(SenderContext {
        session_id: resolve_ui_session_id(state)?,
        sender_agent_id: None,
        display_name: "User".to_string(),
        sender_agent_role: None,
        sender_tile_id: None,
        sender_window_id: None,
    })
}

fn send_direct_message_from_sender(
    state: &AppState,
    app: &AppHandle,
    sender: SenderContext,
    to_agent_id: String,
    message: String,
) -> Result<(), String> {
    let target = live_agent_info(state, &to_agent_id)?;
    if sender.session_id != target.session_id {
        return Err(format!(
            "agent {} cannot direct-message {} across sessions",
            sender.sender_agent_id.unwrap_or_else(|| sender.display_name.clone()),
            to_agent_id,
        ));
    }
    let to_display_name = target.display_name.clone();
    let event = AgentChannelEvent {
        kind: AgentChannelEventKind::Direct,
        from_agent_id: sender.sender_agent_id.clone(),
        from_display_name: sender.display_name.clone(),
        to_agent_id: Some(to_agent_id.clone()),
        to_display_name: Some(to_display_name.clone()),
        message: message.clone(),
        channels: Vec::new(),
        mentions: Vec::new(),
        replay: false,
        ping_id: None,
        timestamp_ms: now_ms(),
    };
    if let Err(error) = state.send_event_to_agent(&to_agent_id, event) {
        let _ = mark_agent_dead(state, app, &to_agent_id);
        return Err(error);
    }
    let entry = build_direct_entry(
        sender.session_id,
        sender.sender_agent_id,
        sender.display_name,
        to_agent_id,
        to_display_name,
        message,
    );
    append_chatter_entry(state, app, entry)
}

fn send_public_message_from_sender(
    state: &AppState,
    app: &AppHandle,
    sender: SenderContext,
    message: String,
    mentions: Vec<String>,
) -> Result<(), String> {
    let normalized_mentions = collect_mentions(&message, &mentions);
    let entry = build_chatter_entry(
        sender.session_id,
        sender.sender_agent_id.clone(),
        sender.display_name.clone(),
        message,
        normalized_mentions,
    );
    append_chatter_entry(state, app, entry.clone())?;
    broadcast_public_event(state, app, &entry);
    Ok(())
}

fn send_channel_message_from_sender(
    state: &AppState,
    app: &AppHandle,
    sender: SenderContext,
    channel_name: String,
    message: String,
    mentions: Vec<String>,
) -> Result<(), String> {
    let Some(sender_agent_id) = sender.sender_agent_id.clone() else {
        return Err("message_channel requires an agent sender".to_string());
    };
    if !state.agent_has_channel(&sender_agent_id, &channel_name)? {
        return Err(format!("agent {sender_agent_id} is not subscribed to channel {channel_name}"));
    }
    let normalized_mentions = collect_mentions(&message, &mentions);
    state.touch_channels_in_session(&sender.session_id, std::slice::from_ref(&channel_name))?;
    let entry = build_channel_entry(
        sender.session_id,
        sender.sender_agent_id.clone(),
        sender.display_name.clone(),
        channel_name.clone(),
        message,
        normalized_mentions,
    );
    append_chatter_entry(state, app, entry.clone())?;
    broadcast_channel_event(state, app, &entry);
    Ok(())
}

fn send_root_message_from_sender(
    state: &AppState,
    app: &AppHandle,
    sender: SenderContext,
    message: String,
) -> Result<(), String> {
    let root_agent = session_root_agent(state, &sender.session_id)?;
    let event = AgentChannelEvent {
        kind: AgentChannelEventKind::Direct,
        from_agent_id: sender.sender_agent_id.clone(),
        from_display_name: sender.display_name.clone(),
        to_agent_id: Some(root_agent.agent_id.clone()),
        to_display_name: Some(root_agent.display_name.clone()),
        message: message.clone(),
        channels: Vec::new(),
        mentions: Vec::new(),
        replay: false,
        ping_id: None,
        timestamp_ms: now_ms(),
    };
    if let Err(error) = state.send_event_to_agent(&root_agent.agent_id, event) {
        let _ = mark_agent_dead(state, app, &root_agent.agent_id);
        return Err(error);
    }
    let entry = build_root_entry(
        sender.session_id,
        sender.sender_agent_id,
        sender.display_name,
        message,
    );
    append_chatter_entry(state, app, entry)
}

fn resolve_user_message_target(
    state: &AppState,
    session_id: &str,
    target: &str,
) -> Result<crate::agent::AgentInfo, String> {
    let normalized = target.trim();
    if normalized.is_empty() {
        return Err("direct message target may not be empty".to_string());
    }
    if normalized.eq_ignore_ascii_case("root") {
        return session_root_agent(state, session_id);
    }
    let agent_index = normalized.parse::<u64>().ok();
    state
        .list_agents_in_session(session_id)?
        .into_iter()
        .find(|agent| {
            agent.alive
                && (agent.agent_id.eq_ignore_ascii_case(normalized)
                    || agent.display_name.eq_ignore_ascii_case(normalized)
                    || agent_index
                        .map(|index| agent.display_name == format!("Agent {index}"))
                        .unwrap_or(false))
        })
        .ok_or_else(|| format!("no live agent target found for {normalized} in session {session_id}"))
}

fn build_direct_entry(
    session_id: String,
    from_agent_id: Option<String>,
    from_display_name: String,
    to_agent_id: String,
    to_display_name: String,
    message: String,
) -> ChatterEntry {
    ChatterEntry {
        session_id,
        kind: ChatterKind::Direct,
        from_agent_id,
        from_display_name: from_display_name.clone(),
        to_agent_id: Some(to_agent_id),
        to_display_name: Some(to_display_name.clone()),
        message: message.clone(),
        channels: Vec::new(),
        mentions: Vec::new(),
        timestamp_ms: now_ms(),
        public: false,
        display_text: format_direct_display(&from_display_name, &to_display_name, &message),
    }
}

fn build_chatter_entry(
    session_id: String,
    from_agent_id: Option<String>,
    from_display_name: String,
    message: String,
    mentions: Vec<String>,
) -> ChatterEntry {
    ChatterEntry {
        session_id,
        kind: ChatterKind::Public,
        from_agent_id,
        from_display_name: from_display_name.clone(),
        to_agent_id: None,
        to_display_name: None,
        message: message.clone(),
        channels: Vec::new(),
        mentions,
        timestamp_ms: now_ms(),
        public: true,
        display_text: format_public_display(&from_display_name, &message),
    }
}

fn build_channel_entry(
    session_id: String,
    from_agent_id: Option<String>,
    from_display_name: String,
    channel_name: String,
    message: String,
    mentions: Vec<String>,
) -> ChatterEntry {
    ChatterEntry {
        session_id,
        kind: ChatterKind::Channel,
        from_agent_id,
        from_display_name: from_display_name.clone(),
        to_agent_id: None,
        to_display_name: None,
        message: message.clone(),
        channels: vec![channel_name.clone()],
        mentions,
        timestamp_ms: now_ms(),
        public: true,
        display_text: format_channel_display(&from_display_name, &channel_name, &message),
    }
}

fn build_network_entry(
    session_id: String,
    from_agent_id: Option<String>,
    from_display_name: String,
    message: String,
) -> ChatterEntry {
    ChatterEntry {
        session_id,
        kind: ChatterKind::Network,
        from_agent_id,
        from_display_name: from_display_name.clone(),
        to_agent_id: None,
        to_display_name: None,
        message: message.clone(),
        channels: Vec::new(),
        mentions: Vec::new(),
        timestamp_ms: now_ms(),
        public: false,
        display_text: format_network_display(&from_display_name, &message),
    }
}

fn build_root_entry(
    session_id: String,
    from_agent_id: Option<String>,
    from_display_name: String,
    message: String,
) -> ChatterEntry {
    ChatterEntry {
        session_id,
        kind: ChatterKind::Root,
        from_agent_id,
        from_display_name: from_display_name.clone(),
        to_agent_id: None,
        to_display_name: None,
        message: message.clone(),
        channels: Vec::new(),
        mentions: Vec::new(),
        timestamp_ms: now_ms(),
        public: false,
        display_text: format_root_display(&from_display_name, &message),
    }
}

fn build_sign_on_entry(session_id: &str, display_name: &str) -> ChatterEntry {
    ChatterEntry {
        session_id: session_id.to_string(),
        kind: ChatterKind::SignOn,
        from_agent_id: None,
        from_display_name: display_name.to_string(),
        to_agent_id: None,
        to_display_name: None,
        message: "Signed On".to_string(),
        channels: Vec::new(),
        mentions: Vec::new(),
        timestamp_ms: now_ms(),
        public: true,
        display_text: format_sign_on_display(display_name),
    }
}

fn build_sign_off_entry(session_id: &str, display_name: &str) -> ChatterEntry {
    ChatterEntry {
        session_id: session_id.to_string(),
        kind: ChatterKind::SignOff,
        from_agent_id: None,
        from_display_name: display_name.to_string(),
        to_agent_id: None,
        to_display_name: None,
        message: "Signed Off".to_string(),
        channels: Vec::new(),
        mentions: Vec::new(),
        timestamp_ms: now_ms(),
        public: true,
        display_text: format_sign_off_display(display_name),
    }
}

fn channel_event_from_entry(entry: &ChatterEntry, replay: bool) -> AgentChannelEvent {
    let kind = match entry.kind {
        ChatterKind::Direct => AgentChannelEventKind::Direct,
        ChatterKind::Public => AgentChannelEventKind::Public,
        ChatterKind::Channel => AgentChannelEventKind::Channel,
        ChatterKind::Network => AgentChannelEventKind::Network,
        ChatterKind::Root => AgentChannelEventKind::Root,
        ChatterKind::SignOn | ChatterKind::SignOff => AgentChannelEventKind::System,
    };
    AgentChannelEvent {
        kind,
        from_agent_id: entry.from_agent_id.clone(),
        from_display_name: entry.from_display_name.clone(),
        to_agent_id: entry.to_agent_id.clone(),
        to_display_name: entry.to_display_name.clone(),
        message: entry.message.clone(),
        channels: entry.channels.clone(),
        mentions: entry.mentions.clone(),
        replay,
        ping_id: None,
        timestamp_ms: entry.timestamp_ms,
    }
}

fn broadcast_public_event(state: &AppState, app: &AppHandle, entry: &ChatterEntry) {
    let failed = state
        .broadcast_event_in_session(&entry.session_id, channel_event_from_entry(entry, false), false)
        .unwrap_or_default();
    for agent_id in failed {
        let _ = mark_agent_dead(state, app, &agent_id);
    }
}

fn broadcast_channel_event(state: &AppState, app: &AppHandle, entry: &ChatterEntry) {
    let failed = state
        .broadcast_channel_event_in_session(&entry.session_id, &entry.channels, channel_event_from_entry(entry, false), false)
        .unwrap_or_default();
    for agent_id in failed {
        let _ = mark_agent_dead(state, app, &agent_id);
    }
}

fn work_ids_touched_by_connections(connections: &[network::NetworkConnection]) -> BTreeSet<String> {
    let mut work_ids = BTreeSet::new();
    for connection in connections {
        if let Ok(item) = work::get_work_item_by_tile_id_at(Path::new(runtime::database_path()), &connection.from_tile_id) {
            work_ids.insert(item.work_id);
        }
        if let Ok(item) = work::get_work_item_by_tile_id_at(Path::new(runtime::database_path()), &connection.to_tile_id) {
            work_ids.insert(item.work_id);
        }
    }
    work_ids
}

fn process_dead_agent(state: &AppState, app: &AppHandle, info: crate::agent::AgentInfo) -> Result<(), String> {
    match network::disconnect_all_for_tile_at(
        Path::new(runtime::database_path()),
        &info.session_id,
        &info.tile_id,
    ) {
        Ok(removed_connections) => {
            for connection in &removed_connections {
                notify_agents_about_connection_change(state, app, connection, false);
            }
            for work_id in work_ids_touched_by_connections(&removed_connections) {
                if let Ok(item) = work::get_work_item_at(Path::new(runtime::database_path()), &work_id) {
                    emit_work_updated(app, &item);
                }
            }
        }
        Err(error) => {
            log::warn!(
                "Failed to clear dead-agent network edges for {}: {error}",
                info.agent_id
            );
        }
    }
    let entry = build_sign_off_entry(&info.session_id, &info.display_name);
    append_chatter_entry(state, app, entry.clone())?;
    broadcast_public_event(state, app, &entry);
    emit_agent_state(app, state);
    if info.agent_role == AgentRole::Root {
        if let Err(error) = crate::commands::repair_root_agent(app.clone(), &info) {
            log::warn!(
                "Failed to respawn root agent {} for session {}: {error}",
                info.agent_id,
                info.session_id
            );
        }
    }
    Ok(())
}

fn mark_agent_dead(state: &AppState, app: &AppHandle, agent_id: &str) -> Result<(), String> {
    let Some(info) = state.mark_agent_dead(agent_id)? else {
        return Ok(());
    };
    process_dead_agent(state, app, info)
}

fn live_agent_info(state: &AppState, agent_id: &str) -> Result<crate::agent::AgentInfo, String> {
    let Some(info) = state.agent_info(agent_id)? else {
        return Err(format!("unknown agent: {agent_id}"));
    };
    if !info.alive {
        return Err(format!("agent {agent_id} is not alive"));
    }
    Ok(info)
}

fn connection_event_message(connection: &network::NetworkConnection, connected: bool) -> String {
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
    app: &AppHandle,
    connection: &network::NetworkConnection,
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
            log::warn!("Failed to deliver connection event to {}: {error}", agent.agent_id);
            let _ = mark_agent_dead(state, app, &agent.agent_id);
        }
    }
}

fn ensure_root_sender(context: &SenderContext, action: &str) -> Result<(), String> {
    if matches!(context.sender_agent_role, Some(AgentRole::Worker)) {
        return Err(format!(
            "non-root agents may not call {action}; send a message to Root instead"
        ));
    }
    Ok(())
}

fn ensure_root_for_sender(
    state: &AppState,
    sender_agent_id: Option<String>,
    sender_tile_id: Option<String>,
    action: &str,
) -> Result<SenderContext, String> {
    let sender = resolve_sender_context(state, sender_agent_id, sender_tile_id)?;
    ensure_root_sender(&sender, action)?;
    Ok(sender)
}

fn maybe_respawn_root_agent(
    _state: &AppState,
    app: &AppHandle,
    info: &crate::agent::AgentInfo,
) {
    if info.agent_role != AgentRole::Root {
        return;
    }
    if let Err(error) = crate::commands::repair_root_agent(app.clone(), info) {
        log::warn!(
            "Failed to respawn root agent {} for session {}: {error}",
            info.agent_id,
            info.session_id
        );
    }
}

fn session_root_agent(state: &AppState, session_id: &str) -> Result<crate::agent::AgentInfo, String> {
    let Some(info) = state.root_agent_in_session(session_id)? else {
        return Err(format!("no root agent registered for session {session_id}"));
    };
    if !info.alive {
        return Err(format!("root agent for session {session_id} is not alive"));
    }
    Ok(info)
}

pub fn send_root_message_as_user(
    state: &AppState,
    app: &AppHandle,
    message: String,
) -> Result<(), String> {
    let sender = resolve_user_sender_context(state)?;
    let response = dispatch_with_log(
        state,
        app,
        TileMessageChannel::Internal,
        sender.session_id.clone(),
        sender.session_id.clone(),
        "message".to_string(),
        "message_root",
        "message_root",
        Some(&sender),
        serde_json::json!({ "message": message }),
        || {
            send_root_message_from_sender(state, app, sender.clone(), message.clone())
                .map(|()| None)
                .map_err(DispatchError::error)
        },
    );
    if response.ok {
        Ok(())
    } else {
        Err(response.error.unwrap_or_else(|| "message_root failed".to_string()))
    }
}

pub fn send_direct_message_as_user(
    state: &AppState,
    app: &AppHandle,
    target: String,
    message: String,
) -> Result<(), String> {
    let sender = resolve_user_sender_context(state)?;
    let target = resolve_user_message_target(state, &sender.session_id, &target)?;
    let response = dispatch_with_log(
        state,
        app,
        TileMessageChannel::Internal,
        sender.session_id.clone(),
        target.agent_id.clone(),
        "message".to_string(),
        "message_direct",
        "message_direct",
        Some(&sender),
        serde_json::json!({ "message": message }),
        || {
            send_direct_message_from_sender(state, app, sender.clone(), target.agent_id.clone(), message.clone())
                .map(|()| None)
                .map_err(DispatchError::error)
        },
    );
    if response.ok {
        Ok(())
    } else {
        Err(response.error.unwrap_or_else(|| "message_direct failed".to_string()))
    }
}

pub fn send_public_message_as_user(
    state: &AppState,
    app: &AppHandle,
    message: String,
) -> Result<(), String> {
    let sender = resolve_user_sender_context(state)?;
    let response = dispatch_with_log(
        state,
        app,
        TileMessageChannel::Internal,
        sender.session_id.clone(),
        sender.session_id.clone(),
        "message".to_string(),
        "message_public",
        "message_public",
        Some(&sender),
        serde_json::json!({ "message": message }),
        || {
            send_public_message_from_sender(state, app, sender.clone(), message.clone(), Vec::new())
                .map(|()| None)
                .map_err(DispatchError::error)
        },
    );
    if response.ok {
        Ok(())
    } else {
        Err(response.error.unwrap_or_else(|| "message_public failed".to_string()))
    }
}

fn resolve_create_target(
    state: &AppState,
    snapshot: &crate::tmux_state::TmuxSnapshot,
    fallback_session_id: Option<String>,
    parent_session_id: Option<String>,
    parent_tile_id: Option<String>,
) -> (Option<String>, Option<String>) {
    let target_session_id = parent_tile_id
        .as_ref()
        .and_then(|tile_id| resolve_session_id_for_tile(state, tile_id).ok())
        .or(parent_session_id)
        .or(fallback_session_id)
        .or(snapshot.active_session_id.clone());

    let parent_window_id = parent_tile_id
        .as_ref()
        .and_then(|tile_id| state.tile_record(tile_id).ok().flatten())
        .map(|record| record.window_id);

    (target_session_id, parent_window_id)
}

fn network_tile_kind_for_parts(
    record_kind: crate::tile_registry::TileRecordKind,
    agent_role: Option<crate::agent::AgentRole>,
    window_name: &str,
    pane_title: &str,
) -> network::NetworkTileKind {
    network::network_tile_kind_from_record_kind(record_kind, agent_role, window_name, pane_title)
}

fn preferred_agent_role_for_record(
    state: &AppState,
    record: &crate::tile_registry::TileRecord,
) -> Result<Option<crate::agent::AgentRole>, String> {
    if record.kind != crate::tile_registry::TileRecordKind::Agent {
        return Ok(None);
    }
    if state.agent_info_by_tile_role(&record.tile_id, crate::agent::AgentRole::Root)?.is_some()
        || state.agent_info_by_pane_role(&record.pane_id, crate::agent::AgentRole::Root)?.is_some()
    {
        return Ok(Some(crate::agent::AgentRole::Root));
    }
    Ok(None)
}

fn preferred_agent_for_record(
    state: &AppState,
    record: &crate::tile_registry::TileRecord,
    kind: network::NetworkTileKind,
) -> Result<Option<crate::agent::AgentInfo>, String> {
    match kind {
        network::NetworkTileKind::RootAgent => Ok(state
            .agent_info_by_tile_role(&record.tile_id, crate::agent::AgentRole::Root)?
            .or_else(|| {
                state
                    .agent_info_by_pane_role(&record.pane_id, crate::agent::AgentRole::Root)
                    .ok()
                    .flatten()
            })),
        network::NetworkTileKind::Agent => Ok(state
            .agent_info_by_tile_role(&record.tile_id, crate::agent::AgentRole::Worker)?
            .or_else(|| {
                state
                    .agent_info_by_pane_role(&record.pane_id, crate::agent::AgentRole::Worker)
                    .ok()
                    .flatten()
            })
            .or_else(|| state.agent_info_by_tile(&record.tile_id).ok().flatten())),
        _ => Ok(None),
    }
}

fn network_tile_kind_for_pane(
    state: &AppState,
    snapshot: &crate::tmux_state::TmuxSnapshot,
    pane_id: &str,
) -> Result<network::NetworkTileKind, String> {
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
    let agent_role = preferred_agent_role_for_record(state, &record)?;
    Ok(network_tile_kind_for_parts(
        record.kind,
        agent_role,
        window_name,
        &pane.title,
    ))
}

fn snap_to_grid(value: f64) -> f64 {
    (value / GRID_SNAP).round() * GRID_SNAP
}

fn rects_overlap(a: &TileState, b: &TileState) -> bool {
    a.x < b.x + b.width
        && a.x + a.width > b.x
        && a.y < b.y + b.height
        && a.y + a.height > b.y
}

fn find_open_position(
    desired_x: f64,
    desired_y: f64,
    width: f64,
    height: f64,
    occupied_ids: &[String],
    entries: &std::collections::HashMap<String, TileState>,
) -> TileState {
    let overlaps = |candidate: &TileState| {
        occupied_ids.iter().any(|entry_id| {
            entries
                .get(entry_id)
                .map(|entry| rects_overlap(candidate, entry))
                .unwrap_or(false)
        })
    };

    let candidate = TileState {
        x: snap_to_grid(desired_x),
        y: snap_to_grid(desired_y),
        width,
        height,
    };
    if !overlaps(&candidate) {
        return candidate;
    }

    for ring in 1..=20 {
        let step_x = (width + GAP) * ring as f64;
        let step_y = (height + GAP) * ring as f64;
        let candidates = [
            (desired_x + step_x, desired_y),
            (desired_x - step_x, desired_y),
            (desired_x, desired_y + step_y),
            (desired_x, desired_y - step_y),
            (desired_x + step_x, desired_y + step_y),
            (desired_x - step_x, desired_y + step_y),
            (desired_x + step_x, desired_y - step_y),
            (desired_x - step_x, desired_y - step_y),
        ];
        for (x, y) in candidates {
            let candidate = TileState {
                x: snap_to_grid(x),
                y: snap_to_grid(y),
                width,
                height,
            };
            if !overlaps(&candidate) {
                return candidate;
            }
        }
    }

    TileState {
        x: snap_to_grid(desired_x),
        y: snap_to_grid(desired_y + occupied_ids.len() as f64 * (height + GAP)),
        width,
        height,
    }
}

fn session_layout_entries(
    state: &AppState,
    snapshot: &crate::tmux_state::TmuxSnapshot,
    session_id: &str,
    work_items: &[work::WorkItem],
) -> std::collections::HashMap<String, TileState> {
    let persisted = state
        .tile_states
        .lock()
        .map(|entries| entries.clone())
        .unwrap_or_default();
    let tile_records = state.list_tile_records_in_session(session_id).unwrap_or_default();
    let mut entries = std::collections::HashMap::new();
    let session_tile_ids = tile_records
        .iter()
        .map(|record| record.tile_id.clone())
        .collect::<Vec<_>>();
    let tile_id_by_window = tile_records
        .iter()
        .map(|record| (record.window_id.clone(), record.tile_id.clone()))
        .collect::<std::collections::HashMap<_, _>>();

    for record in &tile_records {
        if let Some(entry) = persisted.get(&record.tile_id) {
            entries.insert(record.tile_id.clone(), entry.clone());
        }
    }
    for item in work_items {
        if let Some(entry) = persisted.get(&item.tile_id) {
            entries.insert(item.tile_id.clone(), entry.clone());
        }
    }

    for (index, record) in tile_records.iter().enumerate() {
        if entries.contains_key(&record.tile_id) {
            continue;
        }
        let Some(window) = snapshot
            .windows
            .iter()
            .find(|window| window.id == record.window_id && window.session_id == session_id)
        else {
            continue;
        };

        let occupied_ids = session_tile_ids
            .iter()
            .filter(|tile_id| *tile_id != &record.tile_id)
            .cloned()
            .collect::<Vec<_>>();
        let next_entry = if let Some(parent_entry) = window
            .parent_window_id
            .as_ref()
            .and_then(|parent_window_id| tile_id_by_window.get(parent_window_id))
            .and_then(|parent_tile_id| entries.get(parent_tile_id).cloned())
        {
            find_open_position(
                parent_entry.x + parent_entry.width + GAP + GRID_SNAP,
                parent_entry.y,
                DEFAULT_TILE_WIDTH,
                DEFAULT_TILE_HEIGHT,
                &occupied_ids,
                &entries,
            )
        } else {
            let offset = index as f64 * 40.0;
            find_open_position(
                100.0 + offset,
                100.0 + offset,
                DEFAULT_TILE_WIDTH,
                DEFAULT_TILE_HEIGHT,
                &occupied_ids,
                &entries,
            )
        };
        entries.insert(record.tile_id.clone(), next_entry);
    }

    let max_x = session_tile_ids
        .iter()
        .filter_map(|tile_id| entries.get(tile_id))
        .fold(80.0_f64, |value, entry| value.max(entry.x + entry.width));
    let min_y = session_tile_ids
        .iter()
        .filter_map(|tile_id| entries.get(tile_id))
        .fold(f64::INFINITY, |value, entry| value.min(entry.y));
    let base_x = max_x + GAP * 2.0;
    let base_y = if min_y.is_finite() { min_y } else { 80.0 };

    for (index, item) in work_items.iter().enumerate() {
        if entries.contains_key(&item.tile_id) {
            continue;
        }
        let occupied_ids = session_tile_ids
            .iter()
            .cloned()
            .chain(
                work_items
                    .iter()
                    .filter(|other| other.work_id != item.work_id)
                    .map(|other| other.tile_id.clone()),
            )
            .collect::<Vec<_>>();
        let next_entry = find_open_position(
            base_x,
            base_y + index as f64 * (WORK_CARD_HEIGHT + GAP),
            WORK_CARD_WIDTH,
            WORK_CARD_HEIGHT,
            &occupied_ids,
            &entries,
        );
        entries.insert(item.tile_id.clone(), next_entry);
    }

    entries
}

fn tile_state_from_info(tile: &network::SessionTileInfo) -> TileState {
    TileState {
        x: tile.x,
        y: tile.y,
        width: tile.width,
        height: tile.height,
    }
}

fn tile_with_layout(tile: &network::SessionTileInfo, layout: &TileState) -> network::SessionTileInfo {
    let mut next = tile.clone();
    next.x = layout.x;
    next.y = layout.y;
    next.width = layout.width;
    next.height = layout.height;
    next
}

fn tile_layout_entry_id(tile: &network::SessionTileInfo) -> Result<String, String> {
    Ok(tile.tile_id.clone())
}

fn session_tile_by_id(
    app: &AppHandle,
    state: &AppState,
    session_id: &str,
    tile_id: &str,
) -> Result<network::SessionTileInfo, String> {
    session_network_tiles(app, state, session_id)?
        .into_iter()
        .find(|tile| tile.tile_id == tile_id)
        .ok_or_else(|| format!("tile {tile_id} is not available from session {session_id}"))
}

fn pending_agent_tile_info(
    tile: &network::SessionTileInfo,
    agent_id: &str,
    agent_type: crate::agent::AgentType,
    title: Option<&str>,
) -> network::SessionTileInfo {
    let mut next = tile.clone();
    next.kind = network::NetworkTileKind::Agent;
    if let Some(title) = title.filter(|value| !value.trim().is_empty()) {
        next.title = title.to_string();
    }
    next.responds_to = network::responds_to(network::NetworkTileKind::Agent);
    next.message_api = network::message_api(network::NetworkTileKind::Agent);
    next.details = network::TileDetails::Agent(network::AgentTileDetails {
        agent_id: agent_id.to_string(),
        agent_type,
        agent_role: AgentRole::Worker,
        display_name: next.title.clone(),
        alive: false,
        chatter_subscribed: false,
        channels: Vec::new(),
        agent_pid: None,
    });
    next
}

fn apply_create_layout(
    app: &AppHandle,
    state: &AppState,
    tile: &network::SessionTileInfo,
    x: Option<f64>,
    y: Option<f64>,
    width: Option<f64>,
    height: Option<f64>,
) -> Result<network::SessionTileInfo, DispatchError> {
    if width.is_none() && height.is_none() && x.is_none() && y.is_none() {
        return Ok(tile.clone());
    }

    if matches!(width, Some(value) if value <= 0.0) || matches!(height, Some(value) if value <= 0.0) {
        return Err(DispatchError::error(
            "tile dimensions must be greater than zero".to_string(),
        ));
    }

    let updated = update_tile_layout(
        app,
        state,
        tile,
        TileState {
            x: x.unwrap_or(tile.x),
            y: y.unwrap_or(tile.y),
            width: width.unwrap_or(tile.width),
            height: height.unwrap_or(tile.height),
        },
        tile.pane_id.is_some() && (width.is_some() || height.is_some()),
    )
    .map_err(DispatchError::from)?;
    Ok(updated)
}

fn destroy_session_tile(
    app: &AppHandle,
    state: &AppState,
    tile: &network::SessionTileInfo,
) -> Result<(), String> {
    if tile.kind == network::NetworkTileKind::Work {
        let work_id = work_id_from_tile(tile).map_err(|error| error.message)?;
        let item = work::get_work_item_at(Path::new(runtime::database_path()), work_id)?;
        let removed_connections = network::disconnect_all_for_tile_at(
            Path::new(runtime::database_path()),
            &item.session_id,
            &tile.tile_id,
        )
        .unwrap_or_default();
        work::delete_work_item_at(
            Path::new(runtime::database_path()),
            work_id,
        )?;
        for connection in &removed_connections {
            notify_agents_about_connection_change(state, app, connection, false);
        }
        state.remove_tile_state(&tile.tile_id);
        state.save();
        emit_agent_state(app, state);
        emit_work_updated(app, &item);
        return Ok(());
    }

    let pane_id = tile
        .pane_id
        .clone()
        .ok_or_else(|| format!("tile {} cannot be destroyed", tile.tile_id))?;
    crate::commands::kill_pane(app.clone(), pane_id)
}

fn rename_session_tile(
    app: &AppHandle,
    state: &AppState,
    tile: &network::SessionTileInfo,
    title: &str,
) -> Result<network::SessionTileInfo, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("tile title cannot be empty".to_string());
    }

    if tile.kind == network::NetworkTileKind::Work {
        let work_id = work_id_from_tile(tile).map_err(|error| error.message)?;
        let item = work::rename_work_item_at(Path::new(runtime::database_path()), work_id, title)?;
        emit_work_updated(app, &item);
    } else {
        let pane_id = tile
            .pane_id
            .clone()
            .ok_or_else(|| format!("tile {} is missing a pane id", tile.tile_id))?;
        crate::commands::set_pane_title(app.clone(), pane_id, title.to_string())?;
    }

    session_tile_by_id(app, state, &tile.session_id, &tile.tile_id)
}

fn pane_tile_details(
    pane: &crate::tmux_state::TmuxPane,
    window: &crate::tmux_state::TmuxWindow,
) -> network::PaneTileDetails {
    network::PaneTileDetails {
        window_name: window.name.clone(),
        window_index: window.index,
        pane_index: pane.pane_index,
        cols: pane.cols,
        rows: pane.rows,
        active: pane.active,
        dead: pane.dead,
    }
}

fn session_network_tiles(
    app: &AppHandle,
    state: &AppState,
    session_id: &str,
) -> Result<Vec<network::SessionTileInfo>, String> {
    let snapshot = crate::tmux_state::snapshot(state)?;
    let work_items = work::list_work_at(
        Path::new(runtime::database_path()),
        work::WorkListScope::CurrentSession(session_id.to_string()),
    )?;
    let layout_entries = session_layout_entries(state, &snapshot, session_id, &work_items);
    let mut tiles = Vec::new();
    for record in state.list_tile_records_in_session(session_id)? {
        let Some(window) = snapshot
            .windows
            .iter()
            .find(|window| window.id == record.window_id && window.session_id == session_id)
        else {
            continue;
        };
        let Some(pane) = snapshot
            .panes
            .iter()
            .find(|pane| pane.id == record.pane_id && pane.window_id == record.window_id)
        else {
            continue;
        };
        let agent_role = preferred_agent_role_for_record(state, &record)?;
        let kind = network_tile_kind_for_parts(record.kind, agent_role, &window.name, &pane.title);
        let agent = preferred_agent_for_record(state, &record, kind)?;
        let title = match agent.as_ref() {
            Some(agent)
                if matches!(
                    kind,
                    network::NetworkTileKind::Agent | network::NetworkTileKind::RootAgent
                ) && !agent.title.trim().is_empty() =>
            {
                agent.title.clone()
            }
            _ if !window.name.trim().is_empty() => window.name.clone(),
            _ if !pane.title.trim().is_empty() => pane.title.clone(),
            _ => pane.id.clone(),
        };
        let browser_extension = if kind == network::NetworkTileKind::Browser {
            crate::browser::browser_extension_info_for_pane(app, &record.pane_id)
        } else {
            None
        };
        let details = match kind {
            network::NetworkTileKind::Agent | network::NetworkTileKind::RootAgent => {
                let role = match kind {
                    network::NetworkTileKind::RootAgent => crate::agent::AgentRole::Root,
                    _ => crate::agent::AgentRole::Worker,
                };
                let agent = agent.as_ref();
                network::TileDetails::Agent(network::AgentTileDetails {
                    agent_id: agent
                        .map(|agent| agent.agent_id.clone())
                        .unwrap_or_else(|| format!("tile:{}", record.tile_id)),
                    agent_type: agent
                        .map(|agent| agent.agent_type)
                        .unwrap_or(crate::agent::AgentType::Claude),
                    agent_role: agent.map(|agent| agent.agent_role).unwrap_or(role),
                    display_name: agent
                        .map(|agent| agent.display_name.clone())
                        .unwrap_or_else(|| if role == crate::agent::AgentRole::Root {
                            "Root".to_string()
                        } else {
                            "Agent".to_string()
                        }),
                    alive: agent.map(|agent| agent.alive).unwrap_or(false),
                    chatter_subscribed: agent.map(|agent| agent.chatter_subscribed).unwrap_or(false),
                    channels: agent.map(|agent| agent.channels.clone()).unwrap_or_default(),
                    agent_pid: agent.and_then(|agent| agent.agent_pid),
                })
            }
            network::NetworkTileKind::Browser => network::TileDetails::Browser(network::BrowserTileDetails {
                window_name: window.name.clone(),
                window_index: window.index,
                pane_index: pane.pane_index,
                cols: pane.cols,
                rows: pane.rows,
                active: pane.active,
                dead: pane.dead,
                current_url: crate::browser::current_url_for_pane(app, &record.pane_id),
                extension: browser_extension.clone(),
            }),
            network::NetworkTileKind::Shell => {
                network::TileDetails::Shell(pane_tile_details(pane, window))
            }
            network::NetworkTileKind::Work => unreachable!("work tiles are built from the work registry"),
        };
        let layout = layout_entries
            .get(&window.id)
            .cloned()
            .unwrap_or(TileState {
                x: 0.0,
                y: 0.0,
                width: DEFAULT_TILE_WIDTH,
                height: DEFAULT_TILE_HEIGHT,
            });
        let mut tile = network::SessionTileInfo {
            tile_id: record.tile_id.clone(),
            session_id: session_id.to_string(),
            kind,
            title,
            x: layout.x,
            y: layout.y,
            width: layout.width,
            height: layout.height,
            pane_id: Some(record.pane_id.clone()),
            window_id: Some(record.window_id.clone()),
            parent_window_id: window.parent_window_id.clone(),
            command: Some(pane.command.clone()),
            responds_to: network::responds_to(kind),
            message_api: network::message_api(kind),
            details,
        };
        if kind == network::NetworkTileKind::Browser {
            network::extend_browser_api_with_extension(
                &mut tile.responds_to,
                &mut tile.message_api,
                network::TileRpcAccess::ReadWrite,
                browser_extension.as_ref(),
            );
        }
        tiles.push(tile);
    }

    for item in work_items {
        let entry_id = item.tile_id.clone();
        let layout = layout_entries
            .get(&entry_id)
            .cloned()
            .unwrap_or(TileState {
                x: 0.0,
                y: 0.0,
                width: WORK_CARD_WIDTH,
                height: WORK_CARD_HEIGHT,
            });
        tiles.push(network::SessionTileInfo {
            tile_id: entry_id,
            session_id: session_id.to_string(),
            kind: network::NetworkTileKind::Work,
            title: item.title.clone(),
            x: layout.x,
            y: layout.y,
            width: layout.width,
            height: layout.height,
            pane_id: None,
            window_id: None,
            parent_window_id: None,
            command: None,
            responds_to: network::responds_to(network::NetworkTileKind::Work),
            message_api: network::message_api(network::NetworkTileKind::Work),
            details: network::TileDetails::Work(network::WorkTileDetails {
                work_id: item.work_id.clone(),
                topic: item.topic.clone(),
                owner_agent_id: item.owner_agent_id.clone(),
                current_stage: item.current_stage,
                stages: item.stages.clone(),
                reviews: item.reviews.clone(),
                created_at: item.created_at,
                updated_at: item.updated_at,
            }),
        });
    }

    tiles.sort_by(|left, right| left.tile_id.cmp(&right.tile_id));
    Ok(tiles)
}

fn component_tile_by_id(
    component: &network::NetworkComponent,
    tile_id: &str,
) -> Result<network::SessionTileInfo, String> {
    component
        .tiles
        .iter()
        .find(|tile| tile.tile_id == tile_id)
        .cloned()
        .ok_or_else(|| format!("tile {tile_id} is not visible on the sender network"))
}

fn session_tile_receiver(
    app: &AppHandle,
    state: &AppState,
    session_id: &str,
    tile_id: &str,
) -> Result<TileMessageReceiver, DispatchError> {
    session_tile_by_id(app, state, session_id, tile_id)
        .map(TileMessageReceiver::new)
        .map_err(DispatchError::not_found)
}

fn component_tile_receiver(
    component: &network::NetworkComponent,
    tile_id: &str,
) -> Result<TileMessageReceiver, DispatchError> {
    component_tile_by_id(component, tile_id)
        .map(TileMessageReceiver::new)
        .map_err(DispatchError::not_found)
}

fn create_session_tile(
    app: &AppHandle,
    state: &AppState,
    session_id: &str,
    args: SessionTileCreateMessageArgs,
) -> Result<network::SessionTileInfo, DispatchError> {
    let SessionTileCreateMessageArgs {
        tile_type,
        title,
        x,
        y,
        width,
        height,
        parent_window_id,
        browser_incognito,
        browser_path,
    } = args;

    match tile_type {
        network::TileTypeFilter::Shell => {
            let created = crate::commands::new_shell_window_detached(app.clone(), Some(session_id.to_string()))
                .map_err(DispatchError::error)?;
            if let Some(parent_window_id) = parent_window_id {
                state.set_window_parent(&created.window_id, Some(parent_window_id));
                let _ = crate::tmux_state::emit_snapshot(app);
            }
            if let Some(title) = title.as_ref().filter(|value| !value.trim().is_empty()) {
                crate::commands::set_pane_title(app.clone(), created.pane_id.clone(), title.clone())
                    .map_err(DispatchError::from)?;
            }
            let tile = session_tile_by_id(app, state, session_id, &created.tile_id)
                .map_err(DispatchError::from)?;
            apply_create_layout(app, state, &tile, x, y, width, height)
        }
        network::TileTypeFilter::Browser => {
            let created = crate::commands::spawn_browser_window_with_pane(
                app.clone(),
                Some(session_id.to_string()),
                browser_incognito.unwrap_or(false),
                browser_path,
            )
                .map_err(DispatchError::error)?;
            if let Some(parent_window_id) = parent_window_id {
                state.set_window_parent(&created.window_id, Some(parent_window_id));
                let _ = crate::tmux_state::emit_snapshot(app);
            }
            if let Some(title) = title.as_ref().filter(|value| !value.trim().is_empty()) {
                crate::commands::set_pane_title(app.clone(), created.pane_id.clone(), title.clone())
                    .map_err(DispatchError::from)?;
            }
            let tile = session_tile_by_id(app, state, session_id, &created.tile_id)
                .map_err(DispatchError::from)?;
            apply_create_layout(app, state, &tile, x, y, width, height)
        }
        network::TileTypeFilter::Agent => {
            let created = crate::commands::spawn_agent_window(app.clone(), Some(session_id.to_string()))
                .map_err(DispatchError::error)?;
            let pane_id = created
                .get("pane_id")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| DispatchError::error("created agent payload is missing pane_id".to_string()))?
                .to_string();
            let tile_id = created
                .get("tile_id")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| DispatchError::error("created agent payload is missing tile_id".to_string()))?
                .to_string();
            let agent_id = created
                .get("agent_id")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| DispatchError::error("created agent payload is missing agent_id".to_string()))?
                .to_string();
            let agent_type = parse_agent_type(
                created.get("agent_type").and_then(serde_json::Value::as_str),
            )
            .map_err(DispatchError::error)?;
            let window_id = created
                .get("window_id")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| DispatchError::error("created agent payload is missing window_id".to_string()))?
                .to_string();
            if let Some(parent_window_id) = parent_window_id {
                state.set_window_parent(&window_id, Some(parent_window_id));
                let _ = crate::tmux_state::emit_snapshot(app);
            }
            if let Some(title) = title.as_ref().filter(|value| !value.trim().is_empty()) {
                crate::commands::set_pane_title(app.clone(), pane_id.clone(), title.clone())
                    .map_err(DispatchError::from)?;
                if agent_type == crate::agent::AgentType::Fixture {
                    let agent_pid = crate::tmux_state::pane_pid(&pane_id).ok().flatten();
                    state
                        .upsert_agent(
                            agent_id.clone(),
                            tile_id.clone(),
                            pane_id.clone(),
                            window_id.clone(),
                            session_id.to_string(),
                            title.clone(),
                            agent_type,
                            AgentRole::Worker,
                            agent_pid,
                        )
                        .map_err(DispatchError::error)?;
                    emit_agent_state(app, state);
                }
            }
            let tile = session_tile_by_id(app, state, session_id, &tile_id)
                .map(|tile| {
                    if agent_type == crate::agent::AgentType::Fixture {
                        tile
                    } else {
                        pending_agent_tile_info(&tile, &agent_id, agent_type, title.as_deref())
                    }
                })
                .map_err(DispatchError::from)?;
            apply_create_layout(app, state, &tile, x, y, width, height)
        }
        network::TileTypeFilter::Work => {
            let title = title
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| DispatchError::error("tile_create for work requires a title".to_string()))?;
            let item = work::create_work_item_at(
                Path::new(runtime::database_path()),
                session_id,
                &title,
            )
            .map_err(DispatchError::from)?;
            if let Err(error) = state.touch_channels_in_session(&item.session_id, std::slice::from_ref(&item.topic)) {
                log::warn!("Failed to register work channel {}: {error}", item.topic);
            } else {
                emit_agent_state(app, state);
            }
            emit_work_updated(app, &item);
            let tile = session_tile_by_id(app, state, session_id, &item.tile_id)
                .map_err(DispatchError::from)?;
            apply_create_layout(app, state, &tile, x, y, width, height)
        }
    }
}

fn required_string_arg(
    args: Option<&serde_json::Value>,
    key: &str,
    message_name: &str,
) -> Result<String, DispatchError> {
    args
        .and_then(|value| value.get(key))
        .and_then(serde_json::Value::as_str)
        .map(ToString::to_string)
        .ok_or_else(|| DispatchError::error(format!("message {message_name} requires string arg {key}")))
}

fn deserialize_message_args<T: DeserializeOwned>(
    args: Option<&serde_json::Value>,
    message_name: &str,
) -> Result<T, DispatchError> {
    serde_json::from_value(args.cloned().unwrap_or_else(|| serde_json::json!({})))
        .map_err(|error| DispatchError::error(format!("invalid args for message {message_name}: {error}")))
}

fn message_not_supported(target_kind: &str, target_id: &str, message_name: &str) -> DispatchError {
    DispatchError::not_found(format!(
        "message {message_name} is not supported by {target_kind} {target_id}"
    ))
}

#[derive(Deserialize)]
struct SessionTileCreateMessageArgs {
    tile_type: network::TileTypeFilter,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    x: Option<f64>,
    #[serde(default)]
    y: Option<f64>,
    #[serde(default)]
    width: Option<f64>,
    #[serde(default)]
    height: Option<f64>,
    #[serde(default)]
    parent_window_id: Option<String>,
    #[serde(default)]
    browser_incognito: Option<bool>,
    #[serde(default)]
    browser_path: Option<String>,
}

#[derive(Deserialize)]
struct TileDestroyMessageArgs {
    tile_id: String,
}

#[derive(Deserialize)]
struct AgentRegisterMessageArgs {
    agent_id: String,
    tile_id: String,
    #[serde(default)]
    agent_type: Option<String>,
    #[serde(default)]
    agent_role: Option<String>,
    #[serde(default)]
    agent_pid: Option<u32>,
    #[serde(default)]
    title: Option<String>,
}

#[derive(Deserialize)]
struct AgentIdentityMessageArgs {
    agent_id: String,
}

#[derive(Deserialize)]
struct TileListMessageArgs {
    #[serde(default)]
    tile_type: Option<network::TileTypeFilter>,
}

#[derive(Deserialize)]
struct TileIdentityMessageArgs {
    tile_id: String,
}

#[derive(Deserialize)]
struct TileMoveMessageArgs {
    tile_id: String,
    x: f64,
    y: f64,
}

#[derive(Deserialize)]
struct TileResizeMessageArgs {
    tile_id: String,
    width: f64,
    height: f64,
}

#[derive(Deserialize)]
struct TileRenameMessageArgs {
    tile_id: String,
    title: String,
}

#[derive(Deserialize)]
struct NetworkConnectMessageArgs {
    from_tile_id: String,
    from_port: String,
    to_tile_id: String,
    to_port: String,
}

#[derive(Deserialize)]
struct NetworkDisconnectMessageArgs {
    tile_id: String,
    port: String,
}

#[derive(Deserialize)]
struct MessageDirectArgs {
    to_agent_id: String,
    message: String,
}

#[derive(Deserialize)]
struct MessagePublicArgs {
    message: String,
    #[serde(default)]
    mentions: Vec<String>,
}

#[derive(Deserialize)]
struct MessageChannelArgs {
    channel_name: String,
    message: String,
    #[serde(default)]
    mentions: Vec<String>,
}

#[derive(Deserialize)]
struct MessageTextArgs {
    message: String,
}

#[derive(Deserialize)]
struct ChannelSubscriptionArgs {
    agent_id: String,
    channel_name: String,
}

#[derive(Deserialize)]
struct NetworkCallMessageArgs {
    tile_id: String,
    action: String,
    #[serde(default)]
    args: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct BrowserDriveMessageArgs {
    action: String,
    #[serde(default)]
    args: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct BrowserExtensionCallMessageArgs {
    method: String,
    #[serde(default)]
    args: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct TestDriverMessageArgs {
    request: TestDriverRequest,
}

#[derive(Deserialize)]
struct TestDomQueryMessageArgs {
    js: String,
}

#[derive(Deserialize)]
struct TestDomKeysMessageArgs {
    keys: String,
}

fn work_id_from_tile(tile: &network::SessionTileInfo) -> Result<&str, DispatchError> {
    match &tile.details {
        network::TileDetails::Work(details) => Ok(details.work_id.as_str()),
        _ => Err(DispatchError::error(format!(
            "tile {} is not a work tile",
            tile.tile_id
        ))),
    }
}

fn ensure_browser_tile_receiver(receiver: &TileMessageReceiver, action: &str) -> Result<(), DispatchError> {
    if receiver.tile.kind == network::NetworkTileKind::Browser {
        return Ok(());
    }
    Err(DispatchError::error(format!(
        "{action} requires a browser tile target; {} is {}",
        receiver.target_id(),
        receiver.target_kind(),
    )))
}

fn ensure_browser_drive_action_supported(action: &str) -> Result<(), DispatchError> {
    if matches!(action, "click" | "select" | "type" | "dom_query" | "eval" | "screenshot") {
        return Ok(());
    }
    Err(DispatchError::error(format!(
        "unsupported browser_drive action: {action}",
    )))
}

fn network_access_for_tile(
    sender: &SenderContext,
    component: &network::NetworkComponent,
    tile: &network::SessionTileInfo,
) -> network::TileRpcAccess {
    network::rpc_access_for_sender_to_tile(
        sender.sender_tile_id.as_deref(),
        &tile.tile_id,
        tile.kind,
        &component.connections,
    )
}

fn network_visible_tile_for_sender(
    sender: &SenderContext,
    component: &network::NetworkComponent,
    tile: &network::SessionTileInfo,
) -> network::SessionTileInfo {
    let mut visible = tile.clone();
    let access = network_access_for_tile(sender, component, tile);
    visible.responds_to = network::responds_to_for_access(tile.kind, access);
    visible.message_api = network::message_api_for_access(tile.kind, access);
    if let network::TileDetails::Browser(details) = &tile.details {
        network::extend_browser_api_with_extension(
            &mut visible.responds_to,
            &mut visible.message_api,
            access,
            details.extension.as_ref(),
        );
    }
    visible
}

fn network_visible_component_for_sender(
    sender: &SenderContext,
    component: &network::NetworkComponent,
) -> network::NetworkComponent {
    let mut visible = component.clone();
    visible.tiles = component
        .tiles
        .iter()
        .map(|tile| network_visible_tile_for_sender(sender, component, tile))
        .collect();
    visible
}

fn ensure_network_message_allowed(
    sender: &SenderContext,
    component: &network::NetworkComponent,
    receiver: &TileMessageReceiver,
    message_name: &str,
) -> Result<(), DispatchError> {
    let access = network_access_for_tile(sender, component, &receiver.tile);
    let mut allowed = network::dispatchable_messages_for_access(receiver.tile.kind, access)
        .iter()
        .any(|candidate| *candidate == message_name);
    if !allowed
        && message_name == "extension_call"
        && access == network::TileRpcAccess::ReadWrite
        && matches!(
            &receiver.tile.details,
            network::TileDetails::Browser(details) if details.extension.is_some()
        )
    {
        allowed = true;
    }
    if allowed {
        return Ok(());
    }
    Err(message_not_supported(receiver.target_kind(), receiver.target_id(), message_name))
}

struct TileMessageReceiver {
    tile: network::SessionTileInfo,
}

impl TileMessageReceiver {
    fn new(tile: network::SessionTileInfo) -> Self {
        Self { tile }
    }

    fn target_id(&self) -> &str {
        &self.tile.tile_id
    }

    fn target_kind(&self) -> &'static str {
        match self.tile.kind {
            network::NetworkTileKind::Agent => "agent",
            network::NetworkTileKind::RootAgent => "root_agent",
            network::NetworkTileKind::Shell => "shell",
            network::NetworkTileKind::Work => "work",
            network::NetworkTileKind::Browser => "browser",
        }
    }

    fn session_id(&self) -> &str {
        &self.tile.session_id
    }

    fn responds_to_message(&self, message_name: &str) -> bool {
        if message_name == "extension_call" {
            return matches!(
                &self.tile.details,
                network::TileDetails::Browser(details) if details.extension.is_some()
            );
        }
        network::dispatchable_messages(self.tile.kind)
            .iter()
            .any(|candidate| *candidate == message_name)
    }

    fn send(
        &self,
        app: &AppHandle,
        state: &AppState,
        message_name: &str,
        sender: Option<&SenderContext>,
        args: Option<&serde_json::Value>,
    ) -> DispatchResult {
        if !self.responds_to_message(message_name) {
            return Err(message_not_supported(self.target_kind(), self.target_id(), message_name));
        }

        match message_name {
            "get" => Ok(Some(serde_json::json!(self.tile))),
            "output_read" => {
                let pane_id = self
                    .tile
                    .pane_id
                    .as_deref()
                    .ok_or_else(|| DispatchError::error(format!("shell tile {} is missing a pane id", self.tile.tile_id)))?;
                let output = state
                    .with_control(|ctrl| ctrl.read_output(pane_id))
                    .map_err(DispatchError::from)?;
                Ok(Some(serde_json::json!({ "output": output })))
            }
            "input_send" => {
                let pane_id = self
                    .tile
                    .pane_id
                    .as_deref()
                    .ok_or_else(|| DispatchError::error(format!("shell tile {} is missing a pane id", self.tile.tile_id)))?;
                let input = required_string_arg(args, "input", message_name)?;
                state
                    .with_control(|ctrl| ctrl.writer.send_input_by_id(pane_id, input.as_bytes()))
                    .map_err(DispatchError::from)?;
                Ok(None)
            }
            "exec" => {
                let pane_id = self
                    .tile
                    .pane_id
                    .as_deref()
                    .ok_or_else(|| DispatchError::error(format!("shell tile {} is missing a pane id", self.tile.tile_id)))?;
                let command = required_string_arg(args, "command", message_name)?;
                let mut input = command;
                if !input.ends_with('\n') {
                    input.push('\n');
                }
                state
                    .with_control(|ctrl| ctrl.writer.send_input_by_id(pane_id, input.as_bytes()))
                    .map_err(DispatchError::from)?;
                let _ = crate::tmux_state::emit_snapshot(app);
                Ok(None)
            }
            "role_set" => {
                let pane_id = self
                    .tile
                    .pane_id
                    .clone()
                    .ok_or_else(|| DispatchError::error(format!("tile {} is missing a pane id", self.tile.tile_id)))?;
                let role = required_string_arg(args, "role", message_name)?;
                let payload = serde_json::json!({
                    "session_id": pane_id,
                    "role": role,
                });
                let _ = app.emit("shell-role", payload);
                Ok(None)
            }
            "navigate" => {
                let pane_id = self
                    .tile
                    .pane_id
                    .as_deref()
                    .ok_or_else(|| DispatchError::error(format!("browser tile {} is missing a pane id", self.tile.tile_id)))?;
                let url = required_string_arg(args, "url", message_name)?;
                let browser_state = crate::browser::navigate_browser_webview(app, pane_id, &url)
                    .map_err(DispatchError::from)?;
                serde_json::to_value(browser_state)
                    .map(Some)
                    .map_err(|error| DispatchError::error(format!("failed to serialize browser state: {error}")))
            }
            "load" => {
                let pane_id = self
                    .tile
                    .pane_id
                    .as_deref()
                    .ok_or_else(|| DispatchError::error(format!("browser tile {} is missing a pane id", self.tile.tile_id)))?;
                let path = required_string_arg(args, "path", message_name)?;
                let browser_state = crate::browser::load_browser_webview(app, pane_id, &path)
                    .map_err(DispatchError::from)?;
                serde_json::to_value(browser_state)
                    .map(Some)
                    .map_err(|error| DispatchError::error(format!("failed to serialize browser state: {error}")))
            }
            "drive" => {
                ensure_browser_tile_receiver(self, "drive")?;
                let drive: BrowserDriveMessageArgs = deserialize_message_args(args, message_name)?;
                ensure_browser_drive_action_supported(&drive.action)?;
                let pane_id = self
                    .tile
                    .pane_id
                    .as_deref()
                    .ok_or_else(|| DispatchError::error(format!(
                        "browser tile {} is missing a pane id",
                        self.target_id()
                    )))?;
                let result = crate::browser::drive_browser_webview(
                    app,
                    state,
                    pane_id,
                    &drive.action,
                    &drive.args.unwrap_or_else(|| serde_json::json!({})),
                )
                .map_err(DispatchError::from)?;
                Ok(Some(result))
            }
            "extension_call" => {
                ensure_browser_tile_receiver(self, "extension_call")?;
                let sender = sender.ok_or_else(|| {
                    DispatchError::error("extension_call requires a sender context".to_string())
                })?;
                let sender_tile_id = sender.sender_tile_id.clone().ok_or_else(|| {
                    DispatchError::error("extension_call requires a sender tile id".to_string())
                })?;
                let extension_call: BrowserExtensionCallMessageArgs = deserialize_message_args(args, message_name)?;
                let pane_id = self
                    .tile
                    .pane_id
                    .as_deref()
                    .ok_or_else(|| DispatchError::error(format!(
                        "browser tile {} is missing a pane id",
                        self.target_id()
                    )))?;
                let result = crate::browser::call_browser_extension(
                    app,
                    pane_id,
                    &extension_call.method,
                    &extension_call.args.unwrap_or_else(|| serde_json::json!({})),
                    &crate::browser::BrowserExtensionCallerContext {
                        sender_tile_id,
                        sender_agent_id: sender.sender_agent_id.clone(),
                        sender_agent_role: sender.sender_agent_role,
                        target_tile_id: self.tile.tile_id.clone(),
                        target_pane_id: pane_id.to_string(),
                    },
                )
                .map_err(DispatchError::from)?;
                Ok(Some(result))
            }
            "stage_start" => {
                let work_id = work_id_from_tile(&self.tile)?;
                let agent_id = required_string_arg(args, "agent_id", message_name)?;
                let item = work::start_work_stage_at(Path::new(runtime::database_path()), work_id, &agent_id)
                    .map_err(DispatchError::from)?;
                emit_work_updated(app, &item);
                serde_json::to_value(item)
                    .map(Some)
                    .map_err(|error| DispatchError::error(format!("failed to serialize work item: {error}")))
            }
            "stage_complete" => {
                let work_id = work_id_from_tile(&self.tile)?;
                let agent_id = required_string_arg(args, "agent_id", message_name)?;
                let item = work::complete_work_stage_at(Path::new(runtime::database_path()), work_id, &agent_id)
                    .map_err(DispatchError::from)?;
                emit_work_updated(app, &item);
                serde_json::to_value(item)
                    .map(Some)
                    .map_err(|error| DispatchError::error(format!("failed to serialize work item: {error}")))
            }
            "review_approve" => {
                let work_id = work_id_from_tile(&self.tile)?;
                let item = work::approve_work_stage_at(Path::new(runtime::database_path()), work_id)
                    .map_err(DispatchError::from)?;
                emit_work_updated(app, &item);
                serde_json::to_value(item)
                    .map(Some)
                    .map_err(|error| DispatchError::error(format!("failed to serialize work item: {error}")))
            }
            "review_improve" => {
                let work_id = work_id_from_tile(&self.tile)?;
                let comment = required_string_arg(args, "comment", message_name)?;
                let item = work::improve_work_stage_at(Path::new(runtime::database_path()), work_id, &comment)
                    .map_err(DispatchError::from)?;
                emit_work_updated(app, &item);
                serde_json::to_value(item)
                    .map(Some)
                    .map_err(|error| DispatchError::error(format!("failed to serialize work item: {error}")))
            }
            _ => Err(message_not_supported(self.target_kind(), self.target_id(), message_name)),
        }
    }
}

struct SessionMessageReceiver {
    session_id: String,
    sender: Option<SenderContext>,
}

impl SessionMessageReceiver {
    fn new(session_id: impl Into<String>, sender: Option<SenderContext>) -> Self {
        Self {
            session_id: session_id.into(),
            sender,
        }
    }

    fn session_id(&self) -> &str {
        &self.session_id
    }

    fn target_id(&self) -> &str {
        &self.session_id
    }

    fn target_kind(&self) -> &'static str {
        "session"
    }

    fn responds_to(&self) -> &'static [&'static str] {
        &[
            "tile_create",
            "tile_destroy",
            "tile_list",
            "tile_rename",
            "agent_register",
            "agent_unregister",
            "agent_ping_ack",
            "message_channel_list",
            "network_list",
            "network_get",
            "network_call",
            "tile_move",
            "tile_resize",
            "tile_arrange_elk",
            "network_connect",
            "network_disconnect",
            "message_direct",
            "message_public",
            "message_channel",
            "message_network",
            "message_root",
            "message_channel_subscribe",
            "message_channel_unsubscribe",
        ]
    }

    fn responds_to_message(&self, message_name: &str) -> bool {
        self.responds_to()
            .iter()
            .any(|candidate| *candidate == message_name)
    }

    fn sender(&self, message_name: &str) -> Result<&SenderContext, DispatchError> {
        self.sender
            .as_ref()
            .ok_or_else(|| DispatchError::error(format!("message {message_name} requires a sender context")))
    }

    fn send(
        &self,
        app: &AppHandle,
        state: &AppState,
        channel: TileMessageChannel,
        message_name: &str,
        args: Option<&serde_json::Value>,
    ) -> DispatchResult {
        if !self.responds_to_message(message_name) {
            return Err(message_not_supported(self.target_kind(), self.target_id(), message_name));
        }

        match message_name {
            "tile_create" => {
                let args: SessionTileCreateMessageArgs = deserialize_message_args(args, message_name)?;
                let tile = create_session_tile(app, state, &self.session_id, args)?;
                serde_json::to_value(tile)
                    .map(Some)
                    .map_err(|error| DispatchError::error(format!("failed to serialize tile: {error}")))
            }
            "tile_destroy" => {
                let args: TileDestroyMessageArgs = deserialize_message_args(args, message_name)?;
                let tile = session_tile_by_id(app, state, &self.session_id, &args.tile_id)
                    .map_err(DispatchError::not_found)?;
                destroy_session_tile(app, state, &tile).map_err(DispatchError::from)?;
                Ok(None)
            }
            "tile_rename" => {
                let args: TileRenameMessageArgs = deserialize_message_args(args, message_name)?;
                let tile = session_tile_by_id(app, state, &self.session_id, &args.tile_id)
                    .map_err(DispatchError::not_found)?;
                let renamed = rename_session_tile(app, state, &tile, &args.title).map_err(DispatchError::from)?;
                Ok(Some(serde_json::json!(renamed)))
            }
            "agent_register" => {
                let args: AgentRegisterMessageArgs = deserialize_message_args(args, message_name)?;
                let agent_type = parse_agent_type(args.agent_type.as_deref()).map_err(DispatchError::error)?;
                let agent_role = parse_agent_role(args.agent_role.as_deref()).map_err(DispatchError::error)?;
                let (window_id, session_id, pane_id, resolved_title) =
                    resolve_agent_snapshot_metadata(state, &args.tile_id, args.title)
                        .map_err(DispatchError::error)?;
                if session_id != self.session_id {
                    return Err(DispatchError::error(format!(
                        "tile {} belongs to session {}, not {}",
                        args.tile_id, session_id, self.session_id
                    )));
                }
                let resolved_agent_pid = match crate::tmux_state::pane_pid(&pane_id) {
                    Ok(Some(pid)) => Some(pid),
                    Ok(None) => args.agent_pid,
                    Err(error) => {
                        log::warn!("failed to resolve pane pid for tile {}: {error}", args.tile_id);
                        args.agent_pid
                    }
                };
                match state.upsert_agent(
                    args.agent_id,
                    args.tile_id,
                    pane_id,
                    window_id,
                    session_id,
                    resolved_title,
                    agent_type,
                    agent_role,
                    resolved_agent_pid,
                ) {
                    Ok(info) => {
                        emit_agent_state(app, state);
                        Ok(Some(serde_json::json!({ "agent": info })))
                    }
                    Err(error) => Err(DispatchError::error(error)),
                }
            }
            "agent_unregister" => {
                let args: AgentIdentityMessageArgs = deserialize_message_args(args, message_name)?;
                match state.unregister_agent(&args.agent_id) {
                    Ok(Some(info)) => {
                        emit_agent_state(app, state);
                        maybe_respawn_root_agent(state, app, &info);
                        Ok(None)
                    }
                    Ok(None) => Ok(None),
                    Err(error) => Err(DispatchError::error(error)),
                }
            }
            "agent_ping_ack" => {
                let args: AgentIdentityMessageArgs = deserialize_message_args(args, message_name)?;
                match state.ack_agent_ping(&args.agent_id) {
                    Ok(info) => Ok(Some(serde_json::json!({ "agent": info }))),
                    Err(error) => Err(DispatchError::error(error)),
                }
            }
            "message_channel_list" => state
                .list_channels_in_session(&self.session_id)
                .map(|channels| Some(serde_json::json!(channels)))
                .map_err(DispatchError::error),
            "network_list" => {
                let args: TileListMessageArgs = deserialize_message_args(args, message_name)?;
                let sender = self.sender(message_name)?;
                component_for_sender(app, state, sender)
                    .map(|component| network_visible_component_for_sender(sender, &component))
                    .map(|component| Some(serde_json::json!(network::filter_component(component, args.tile_type))))
                    .map_err(DispatchError::error)
            }
            "network_get" => {
                let sender = self.sender(message_name)?;
                let args: TileIdentityMessageArgs = deserialize_message_args(args, message_name)?;
                let component = component_for_sender(app, state, sender).map_err(DispatchError::error)?;
                component_tile_by_id(&component, &args.tile_id)
                    .map(|tile| network_visible_tile_for_sender(sender, &component, &tile))
                    .map(|tile| Some(serde_json::json!(tile)))
                    .map_err(DispatchError::not_found)
            }
            "network_call" => {
                let sender = self.sender(message_name)?.clone();
                let args: NetworkCallMessageArgs = deserialize_message_args(args, message_name)?;
                let component = component_for_sender(app, state, &sender).map_err(DispatchError::error)?;
                let receiver = component_tile_receiver(&component, &args.tile_id)?;
                ensure_network_message_allowed(&sender, &component, &receiver, &args.action)?;
                let call_args = args.args.unwrap_or_else(|| serde_json::json!({}));
                let result = dispatch_network_interface_message(
                    state,
                    app,
                    channel,
                    receiver.session_id(),
                    receiver.target_id(),
                    "network_call",
                    &args.action,
                    Some(&sender),
                    serde_json::json!({
                        "tile_id": receiver.target_id(),
                        "action": args.action.clone(),
                        "args": call_args.clone(),
                    }),
                    || {
                        dispatch_result_with_log(
                            state,
                            app,
                            TileMessageLogLayer::Message,
                            channel,
                            receiver.session_id().to_string(),
                            receiver.target_id().to_string(),
                            receiver.target_kind().to_string(),
                            "network_call",
                            &args.action,
                            Some(&sender),
                            call_args.clone(),
                            || receiver.send(app, state, &args.action, Some(&sender), Some(&call_args)),
                        )
                    },
                )?;
                Ok(Some(serde_json::json!({
                    "tile_id": receiver.target_id(),
                    "action": args.action,
                    "result": result,
                })))
            }
            "tile_list" => {
                let args: TileListMessageArgs = deserialize_message_args(args, message_name)?;
                session_component(app, state, &self.session_id)
                    .map(|component| Some(serde_json::json!(network::filter_component(component, args.tile_type))))
                    .map_err(DispatchError::error)
            }
            "tile_move" => {
                let args: TileMoveMessageArgs = deserialize_message_args(args, message_name)?;
                let tile = session_tile_by_id(app, state, &self.session_id, &args.tile_id)
                    .map_err(DispatchError::not_found)?;
                let current = tile_state_from_info(&tile);
                let updated = update_tile_layout(
                    app,
                    state,
                    &tile,
                    TileState {
                        x: args.x,
                        y: args.y,
                        width: current.width,
                        height: current.height,
                    },
                    false,
                )
                .map_err(DispatchError::from)?;
                Ok(Some(serde_json::json!(updated)))
            }
            "tile_resize" => {
                let args: TileResizeMessageArgs = deserialize_message_args(args, message_name)?;
                if args.width <= 0.0 || args.height <= 0.0 {
                    return Err(DispatchError::error(
                        "tile dimensions must be greater than zero".to_string(),
                    ));
                }
                let tile = session_tile_by_id(app, state, &self.session_id, &args.tile_id)
                    .map_err(DispatchError::not_found)?;
                let current = tile_state_from_info(&tile);
                let updated = update_tile_layout(
                    app,
                    state,
                    &tile,
                    TileState {
                        x: current.x,
                        y: current.y,
                        width: args.width,
                        height: args.height,
                    },
                    tile.pane_id.is_some(),
                )
                .map_err(DispatchError::from)?;
                Ok(Some(serde_json::json!(updated)))
            }
            "tile_arrange_elk" => {
                emit_arrange_elk(app, &self.session_id);
                Ok(Some(serde_json::json!({
                    "session_id": self.session_id,
                    "arrange_mode": "elk",
                    "scheduled": true,
                })))
            }
            "network_connect" => {
                let args: NetworkConnectMessageArgs = deserialize_message_args(args, message_name)?;
                let from_descriptor = resolve_network_tile_descriptor(state, &self.session_id, &args.from_tile_id)
                    .map_err(DispatchError::error)?;
                let to_descriptor = resolve_network_tile_descriptor(state, &self.session_id, &args.to_tile_id)
                    .map_err(DispatchError::error)?;
                let from_port = network::parse_port(&args.from_port)
                    .map_err(|_| DispatchError::error("invalid from_port".to_string()))?;
                let to_port = network::parse_port(&args.to_port)
                    .map_err(|_| DispatchError::error("invalid to_port".to_string()))?;
                match network::connect_at(
                    Path::new(runtime::database_path()),
                    &from_descriptor,
                    from_port,
                    &to_descriptor,
                    to_port,
                ) {
                    Ok(connection) => {
                        notify_agents_about_connection_change(state, app, &connection, true);
                        for work_id in work_ids_touched_by_connections(std::slice::from_ref(&connection)) {
                            if let Ok(item) = work::get_work_item_at(Path::new(runtime::database_path()), &work_id) {
                                emit_work_updated(app, &item);
                            }
                        }
                        emit_agent_state(app, state);
                        Ok(Some(serde_json::json!(connection)))
                    }
                    Err(error) => Err(DispatchError::error(error)),
                }
            }
            "network_disconnect" => {
                let args: NetworkDisconnectMessageArgs = deserialize_message_args(args, message_name)?;
                let descriptor = resolve_network_tile_descriptor(state, &self.session_id, &args.tile_id)
                    .map_err(DispatchError::error)?;
                let port = network::parse_port(&args.port)
                    .map_err(|_| DispatchError::error("invalid port".to_string()))?;
                match network::disconnect_at(
                    Path::new(runtime::database_path()),
                    &descriptor.session_id,
                    &descriptor.tile_id,
                    port,
                ) {
                    Ok(removed) => {
                        if let Some(connection) = removed.as_ref() {
                            notify_agents_about_connection_change(state, app, connection, false);
                            for work_id in work_ids_touched_by_connections(std::slice::from_ref(connection)) {
                                if let Ok(item) = work::get_work_item_at(Path::new(runtime::database_path()), &work_id) {
                                    emit_work_updated(app, &item);
                                }
                            }
                        }
                        emit_agent_state(app, state);
                        Ok(Some(serde_json::json!(removed)))
                    }
                    Err(error) => Err(DispatchError::error(error)),
                }
            }
            "message_direct" => {
                let sender = self.sender(message_name)?.clone();
                let args: MessageDirectArgs = deserialize_message_args(args, message_name)?;
                send_direct_message_from_sender(state, app, sender, args.to_agent_id, args.message)
                    .map(|()| None)
                    .map_err(DispatchError::error)
            }
            "message_public" => {
                let sender = self.sender(message_name)?.clone();
                let args: MessagePublicArgs = deserialize_message_args(args, message_name)?;
                send_public_message_from_sender(state, app, sender, args.message, args.mentions)
                    .map(|()| None)
                    .map_err(DispatchError::error)
            }
            "message_channel" => {
                let sender = self.sender(message_name)?.clone();
                let args: MessageChannelArgs = deserialize_message_args(args, message_name)?;
                send_channel_message_from_sender(state, app, sender, args.channel_name, args.message, args.mentions)
                    .map(|()| None)
                    .map_err(DispatchError::error)
            }
            "message_network" => {
                let sender = self.sender(message_name)?.clone();
                let args: MessageTextArgs = deserialize_message_args(args, message_name)?;
                let Some(from_agent_id) = sender.sender_agent_id.clone() else {
                    return Err(DispatchError::error("message_network requires an agent sender".to_string()));
                };
                let component = component_for_sender(app, state, &sender).map_err(DispatchError::error)?;
                let recipient_tile_ids = component
                    .tiles
                    .into_iter()
                    .map(|tile| tile.tile_id)
                    .collect::<BTreeSet<_>>();
                let recipients = state.list_agents_in_session(&sender.session_id).map_err(DispatchError::error)?;
                for recipient in recipients
                    .into_iter()
                    .filter(|agent| agent.alive)
                    .filter(|agent| agent.agent_id != from_agent_id)
                    .filter(|agent| recipient_tile_ids.contains(&agent.tile_id))
                {
                    let event = AgentChannelEvent {
                        kind: AgentChannelEventKind::Direct,
                        from_agent_id: Some(from_agent_id.clone()),
                        from_display_name: sender.display_name.clone(),
                        to_agent_id: Some(recipient.agent_id.clone()),
                        to_display_name: Some(recipient.display_name.clone()),
                        message: args.message.clone(),
                        channels: Vec::new(),
                        mentions: Vec::new(),
                        replay: false,
                        ping_id: None,
                        timestamp_ms: now_ms(),
                    };
                    if let Err(error) = state.send_event_to_agent(&recipient.agent_id, event) {
                        let _ = mark_agent_dead(state, app, &recipient.agent_id);
                        return Err(DispatchError::error(error));
                    }
                }
                let entry = build_network_entry(
                    sender.session_id,
                    sender.sender_agent_id,
                    sender.display_name,
                    args.message,
                );
                append_chatter_entry(state, app, entry)
                    .map(|()| None)
                    .map_err(DispatchError::error)
            }
            "message_root" => {
                let sender = self.sender(message_name)?.clone();
                let args: MessageTextArgs = deserialize_message_args(args, message_name)?;
                send_root_message_from_sender(state, app, sender, args.message)
                    .map(|()| None)
                    .map_err(DispatchError::error)
            }
            "message_channel_subscribe" => {
                let args: ChannelSubscriptionArgs = deserialize_message_args(args, message_name)?;
                match state.channel_subscribe(&args.agent_id, &args.channel_name) {
                    Ok(info) => {
                        emit_agent_state(app, state);
                        Ok(Some(serde_json::json!(info)))
                    }
                    Err(error) => Err(DispatchError::error(error)),
                }
            }
            "message_channel_unsubscribe" => {
                let args: ChannelSubscriptionArgs = deserialize_message_args(args, message_name)?;
                match state.channel_unsubscribe(&args.agent_id, &args.channel_name) {
                    Ok(info) => {
                        emit_agent_state(app, state);
                        Ok(Some(serde_json::json!(info)))
                    }
                    Err(error) => Err(DispatchError::error(error)),
                }
            }
            _ => Err(message_not_supported(self.target_kind(), self.target_id(), message_name)),
        }
    }
}

struct HerdMessageReceiver {
    session_id: String,
    herd_id: String,
}

impl HerdMessageReceiver {
    fn new(session_id: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            herd_id: runtime::runtime_id().unwrap_or("herd").to_string(),
        }
    }

    fn session_id(&self) -> &str {
        &self.session_id
    }

    fn target_id(&self) -> &str {
        &self.herd_id
    }

    fn target_kind(&self) -> &'static str {
        "herd"
    }

    fn responds_to(&self) -> &'static [&'static str] {
        &[
            "ping",
            "wait_for_ready",
            "wait_for_bootstrap",
            "wait_for_idle",
            "get_state_tree",
            "get_projection",
            "get_status",
            "press_keys",
            "command_bar_open",
            "command_bar_set_text",
            "command_bar_submit",
            "command_bar_cancel",
            "toolbar_select_tab",
            "toolbar_add_tab",
            "toolbar_spawn_shell",
            "toolbar_spawn_work",
            "sidebar_open",
            "sidebar_close",
            "sidebar_select_item",
            "sidebar_move_selection",
            "sidebar_begin_rename",
            "tile_select",
            "tile_close",
            "tile_drag",
            "tile_resize",
            "tile_title_double_click",
            "canvas_pan",
            "canvas_context_menu",
            "canvas_zoom_at",
            "canvas_wheel",
            "canvas_fit_all",
            "canvas_reset",
            "tile_context_menu",
            "context_menu_select",
            "context_menu_dismiss",
            "confirm_close_tab",
            "cancel_close_tab",
            "test_dom_query",
            "test_dom_keys",
        ]
    }

    fn responds_to_message(&self, message_name: &str) -> bool {
        self.responds_to()
            .iter()
            .any(|candidate| *candidate == message_name)
    }

    fn send(
        &self,
        app: &AppHandle,
        state: &AppState,
        message_name: &str,
        args: Option<&serde_json::Value>,
    ) -> DispatchResult {
        if !self.responds_to_message(message_name) {
            return Err(message_not_supported(self.target_kind(), self.target_id(), message_name));
        }

        match message_name {
            "test_dom_query" => {
                let args: TestDomQueryMessageArgs = deserialize_message_args(args, message_name)?;
                if !test_driver_enabled() {
                    return Err(DispatchError::error("test driver is not enabled".to_string()));
                }
                handle_test_dom_query(args.js, app)
                    .map(Some)
                    .map_err(DispatchError::error)
            }
            "test_dom_keys" => {
                let args: TestDomKeysMessageArgs = deserialize_message_args(args, message_name)?;
                if !test_driver_enabled() {
                    return Err(DispatchError::error("test driver is not enabled".to_string()));
                }
                handle_test_dom_keys(args.keys, app)
                    .map(Some)
                    .map_err(DispatchError::error)
            }
            _ => {
                let args: TestDriverMessageArgs = deserialize_message_args(args, message_name)?;
                handle_test_driver_request(state, app, args.request)
            }
        }
    }
}

fn dispatch_session_message(
    state: &AppState,
    app: &AppHandle,
    channel: TileMessageChannel,
    receiver: &SessionMessageReceiver,
    wrapper_command: &str,
    message_name: &str,
    sender: Option<&SenderContext>,
    args: serde_json::Value,
) -> SocketResponse {
    dispatch_with_log(
        state,
        app,
        channel,
        receiver.session_id().to_string(),
        receiver.target_id().to_string(),
        receiver.target_kind().to_string(),
        wrapper_command,
        message_name,
        sender,
        args.clone(),
        || {
            dispatch_result_with_log(
                state,
                app,
                TileMessageLogLayer::Message,
                channel,
                receiver.session_id().to_string(),
                receiver.target_id().to_string(),
                receiver.target_kind().to_string(),
                wrapper_command,
                message_name,
                sender,
                args.clone(),
                || receiver.send(app, state, channel, message_name, Some(&args)),
            )
        },
    )
}

fn dispatch_tile_message(
    state: &AppState,
    app: &AppHandle,
    channel: TileMessageChannel,
    receiver: &TileMessageReceiver,
    wrapper_command: &str,
    message_name: &str,
    sender: Option<&SenderContext>,
    args: serde_json::Value,
) -> SocketResponse {
    dispatch_with_log(
        state,
        app,
        channel,
        receiver.session_id().to_string(),
        receiver.target_id().to_string(),
        receiver.target_kind().to_string(),
        wrapper_command,
        message_name,
        sender,
        args.clone(),
        || {
            dispatch_result_with_log(
                state,
                app,
                TileMessageLogLayer::Message,
                channel,
                receiver.session_id().to_string(),
                receiver.target_id().to_string(),
                receiver.target_kind().to_string(),
                wrapper_command,
                message_name,
                sender,
                args.clone(),
                || receiver.send(app, state, message_name, sender, Some(&args)),
            )
        },
    )
}

fn dispatch_herd_message(
    state: &AppState,
    app: &AppHandle,
    channel: TileMessageChannel,
    receiver: &HerdMessageReceiver,
    wrapper_command: &str,
    message_name: &str,
    args: serde_json::Value,
) -> SocketResponse {
    dispatch_with_log(
        state,
        app,
        channel,
        receiver.session_id().to_string(),
        receiver.target_id().to_string(),
        receiver.target_kind().to_string(),
        wrapper_command,
        message_name,
        None,
        args.clone(),
        || {
            dispatch_result_with_log(
                state,
                app,
                TileMessageLogLayer::Message,
                channel,
                receiver.session_id().to_string(),
                receiver.target_id().to_string(),
                receiver.target_kind().to_string(),
                wrapper_command,
                message_name,
                None,
                args.clone(),
                || receiver.send(app, state, message_name, Some(&args)),
            )
        },
    )
}

fn dispatch_network_interface_message<F>(
    state: &AppState,
    app: &AppHandle,
    channel: TileMessageChannel,
    session_id: &str,
    target_tile_id: &str,
    wrapper_command: &str,
    message_name: &str,
    sender: Option<&SenderContext>,
    args: serde_json::Value,
    dispatch: F,
) -> DispatchResult
where
    F: FnOnce() -> DispatchResult,
{
    dispatch_result_with_log(
        state,
        app,
        TileMessageLogLayer::Network,
        channel,
        session_id.to_string(),
        target_tile_id.to_string(),
        "network".to_string(),
        wrapper_command,
        message_name,
        sender,
        args,
        dispatch,
    )
}

fn resolve_network_tile_descriptor(
    state: &AppState,
    session_id: &str,
    tile_id: &str,
) -> Result<network::NetworkTileDescriptor, String> {
    if let Ok(item) = work::get_work_item_by_tile_id_at(Path::new(runtime::database_path()), tile_id) {
        if item.session_id != session_id {
            return Err(format!("tile {tile_id} is not in session {session_id}"));
        }
        return Ok(network::NetworkTileDescriptor {
            tile_id: tile_id.to_string(),
            session_id: session_id.to_string(),
            kind: network::NetworkTileKind::Work,
        });
    }

    let snapshot = crate::tmux_state::snapshot(state)?;
    let record = state
        .tile_record(tile_id)?
        .ok_or_else(|| format!("unknown tile: {tile_id}"))?;
    if record.session_id != session_id {
        return Err(format!("tile {tile_id} is not in session {session_id}"));
    }

    Ok(network::NetworkTileDescriptor {
        tile_id: tile_id.to_string(),
        session_id: session_id.to_string(),
        kind: network_tile_kind_for_pane(state, &snapshot, &record.pane_id)?,
    })
}

fn component_for_sender(
    app: &AppHandle,
    state: &AppState,
    sender: &SenderContext,
) -> Result<network::NetworkComponent, String> {
    let Some(start_tile_id) = sender.sender_tile_id.as_deref() else {
        return Ok(network::NetworkComponent {
            session_id: sender.session_id.clone(),
            sender_tile_id: sender.sender_tile_id.clone(),
            tiles: Vec::new(),
            connections: Vec::new(),
        });
    };
    let session_tiles = session_network_tiles(app, state, &sender.session_id)?;
    let connections = network::list_connections_at(Path::new(runtime::database_path()), &sender.session_id)?;
    Ok(network::component_for_tile(
        &sender.session_id,
        start_tile_id,
        &session_tiles,
        &connections,
    ))
}

fn session_component(
    app: &AppHandle,
    state: &AppState,
    session_id: &str,
) -> Result<network::NetworkComponent, String> {
    Ok(network::NetworkComponent {
        session_id: session_id.to_string(),
        sender_tile_id: None,
        tiles: session_network_tiles(app, state, session_id)?,
        connections: network::list_connections_at(Path::new(runtime::database_path()), session_id)?,
    })
}

fn update_tile_layout(
    app: &AppHandle,
    state: &AppState,
    tile: &network::SessionTileInfo,
    layout: TileState,
    request_resize: bool,
) -> Result<network::SessionTileInfo, String> {
    let entry_id = tile_layout_entry_id(tile)?;
    state.set_tile_state(&entry_id, layout.clone());
    state.save();
    emit_layout_updated(app, tile, &layout, request_resize);
    Ok(tile_with_layout(tile, &layout))
}

fn test_driver_enabled() -> bool {
    runtime::test_driver_enabled()
}

fn handle_test_driver_request(
    state: &AppState,
    app: &AppHandle,
    request: TestDriverRequest,
) -> DispatchResult {
    if !test_driver_enabled() {
        return Err(DispatchError::error("test driver is not enabled".to_string()));
    }

    match request {
        TestDriverRequest::Ping => Ok(Some(serde_json::json!({
            "pong": true,
            "status": test_driver_status(state),
        }))),
        TestDriverRequest::WaitForReady { timeout_ms } => {
            match wait_for(
                timeout_ms.unwrap_or(10_000),
                || state.test_driver_frontend_ready(),
                "frontend test driver readiness",
            ) {
                Ok(()) => Ok(Some(test_driver_status(state))),
                Err(error) => Err(DispatchError::error(error)),
            }
        }
        TestDriverRequest::WaitForBootstrap { timeout_ms } => {
            match wait_for(
                timeout_ms.unwrap_or(10_000),
                || state.test_driver_bootstrap_complete(),
                "frontend bootstrap completion",
            ) {
                Ok(()) => Ok(Some(test_driver_status(state))),
                Err(error) => Err(DispatchError::error(error)),
            }
        }
        TestDriverRequest::GetStatus => Ok(Some(test_driver_status(state))),
        other => forward_test_driver_request(state, app, other)
            .map(Some)
            .map_err(DispatchError::error),
    }
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

fn test_driver_status(state: &AppState) -> serde_json::Value {
    serde_json::json!({
        "enabled": test_driver_enabled(),
        "frontend_ready": state.test_driver_frontend_ready(),
        "bootstrap_complete": state.test_driver_bootstrap_complete(),
        "runtime_id": runtime::runtime_id(),
        "tmux_server_name": runtime::tmux_server_name(),
        "socket_path": runtime::socket_path(),
        "tmux_server_alive": tmux::is_running(),
        "control_client_alive": tmux_control_client_alive(state.current_control_pid()),
    })
}

fn wait_for<F>(timeout_ms: u64, mut predicate: F, description: &str) -> Result<(), String>
where
    F: FnMut() -> bool,
{
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    while Instant::now() <= deadline {
        if predicate() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    Err(format!("timed out waiting for {description}"))
}

fn request_timeout_ms(request: &TestDriverRequest) -> u64 {
    match request {
        TestDriverRequest::WaitForIdle { timeout_ms, .. }
        | TestDriverRequest::WaitForReady { timeout_ms }
        | TestDriverRequest::WaitForBootstrap { timeout_ms } => timeout_ms.unwrap_or(10_000),
        _ => 10_000,
    }
}

fn forward_test_driver_request(
    state: &AppState,
    app: &AppHandle,
    request: TestDriverRequest,
) -> Result<serde_json::Value, String> {
    if !state.test_driver_frontend_ready() {
        return Err("frontend test driver is not ready".into());
    }

    let request_id = state.next_test_driver_request_id();
    let (sender, receiver) = mpsc::channel();
    if let Err(error) = state.register_test_driver_request(&request_id, sender) {
        return Err(error);
    }

    let emit_result = app.emit("test-driver-request", serde_json::json!({
        "request_id": request_id,
        "request": request,
    }));
    if let Err(error) = emit_result {
        state.cancel_test_driver_request(&request_id);
        return Err(format!("emit test-driver-request failed: {error}"));
    }

    match receiver.recv_timeout(Duration::from_millis(request_timeout_ms(&request))) {
        Ok(Ok(data)) => Ok(data),
        Ok(Err(error)) => Err(error),
        Err(_) => {
            state.cancel_test_driver_request(&request_id);
            Err("timed out waiting for test-driver response".into())
        }
    }
}

fn handle_test_dom_query(js: String, app: &AppHandle) -> Result<serde_json::Value, String> {
    if let Some(webview) = app.get_webview("main") {
        let result_file = runtime::dom_result_path().to_string();
        let _ = std::fs::remove_file(&result_file);

        let wrapped = format!(
            r#"(function() {{
                try {{
                    const __r = (function(){{ {js} }})();
                    const __s = JSON.stringify(__r === undefined ? null : __r);
                    window.__TAURI_INTERNALS__.invoke('__write_dom_result', {{ result: __s }});
                }} catch(e) {{
                    window.__TAURI_INTERNALS__.invoke('__write_dom_result', {{ result: JSON.stringify("ERR:" + e.message) }});
                }}
            }})()"#
        );
        if let Err(error) = webview.eval(&wrapped) {
            return Err(format!("eval failed: {error}"));
        }

        for _ in 0..40 {
            std::thread::sleep(Duration::from_millis(50));
            if let Ok(data) = std::fs::read_to_string(&result_file) {
                let _ = std::fs::remove_file(&result_file);
                match serde_json::from_str::<serde_json::Value>(&data) {
                    Ok(value) => return Ok(value),
                    Err(_) => return Ok(serde_json::json!(data)),
                }
            }
        }

        Ok(serde_json::json!(null))
    } else {
        Err("No webview found".into())
    }
}

fn handle_test_dom_keys(keys: String, app: &AppHandle) -> Result<serde_json::Value, String> {
    if let Some(webview) = app.get_webview("main") {
        let js = format!(
            r#"(function() {{
                const keys = {keys_json};
                for (const k of keys.split(' ')) {{
                    let key = k, shiftKey = false, ctrlKey = false;
                    if (k.includes('+')) {{
                        const parts = k.split('+');
                        key = parts[parts.length - 1];
                        shiftKey = parts.includes('Shift');
                        ctrlKey = parts.includes('Ctrl');
                    }}
                    const ev = new KeyboardEvent('keydown', {{
                        key: key, code: 'Key' + key.toUpperCase(),
                        shiftKey, ctrlKey, bubbles: true, cancelable: true
                    }});
                    window.dispatchEvent(ev);
                }}
            }})()"#,
            keys_json = serde_json::to_string(&keys).unwrap_or_default(),
        );
        let _ = webview.eval(&js);
        std::thread::sleep(Duration::from_millis(200));
        Ok(serde_json::Value::Null)
    } else {
        Err("No webview found".into())
    }
}

fn test_driver_message_name(request: &TestDriverRequest) -> &'static str {
    match request {
        TestDriverRequest::Ping => "ping",
        TestDriverRequest::WaitForReady { .. } => "wait_for_ready",
        TestDriverRequest::WaitForBootstrap { .. } => "wait_for_bootstrap",
        TestDriverRequest::WaitForIdle { .. } => "wait_for_idle",
        TestDriverRequest::GetStateTree => "get_state_tree",
        TestDriverRequest::GetProjection => "get_projection",
        TestDriverRequest::GetStatus => "get_status",
        TestDriverRequest::PressKeys { .. } => "press_keys",
        TestDriverRequest::CommandBarOpen => "command_bar_open",
        TestDriverRequest::CommandBarSetText { .. } => "command_bar_set_text",
        TestDriverRequest::CommandBarSubmit => "command_bar_submit",
        TestDriverRequest::CommandBarCancel => "command_bar_cancel",
        TestDriverRequest::ToolbarSelectTab { .. } => "toolbar_select_tab",
        TestDriverRequest::ToolbarAddTab { .. } => "toolbar_add_tab",
        TestDriverRequest::ToolbarSpawnShell => "toolbar_spawn_shell",
        TestDriverRequest::ToolbarSpawnWork { .. } => "toolbar_spawn_work",
        TestDriverRequest::SidebarOpen => "sidebar_open",
        TestDriverRequest::SidebarClose => "sidebar_close",
        TestDriverRequest::SidebarSelectItem { .. } => "sidebar_select_item",
        TestDriverRequest::SidebarMoveSelection { .. } => "sidebar_move_selection",
        TestDriverRequest::SidebarBeginRename => "sidebar_begin_rename",
        TestDriverRequest::TileSelect { .. } => "tile_select",
        TestDriverRequest::TileClose { .. } => "tile_close",
        TestDriverRequest::TileDrag { .. } => "tile_drag",
        TestDriverRequest::TileResize { .. } => "tile_resize",
        TestDriverRequest::TileTitleDoubleClick { .. } => "tile_title_double_click",
        TestDriverRequest::CanvasPan { .. } => "canvas_pan",
        TestDriverRequest::CanvasContextMenu { .. } => "canvas_context_menu",
        TestDriverRequest::CanvasZoomAt { .. } => "canvas_zoom_at",
        TestDriverRequest::CanvasWheel { .. } => "canvas_wheel",
        TestDriverRequest::CanvasFitAll { .. } => "canvas_fit_all",
        TestDriverRequest::CanvasReset => "canvas_reset",
        TestDriverRequest::TileContextMenu { .. } => "tile_context_menu",
        TestDriverRequest::ContextMenuSelect { .. } => "context_menu_select",
        TestDriverRequest::ContextMenuDismiss => "context_menu_dismiss",
        TestDriverRequest::ConfirmCloseTab => "confirm_close_tab",
        TestDriverRequest::CancelCloseTab => "cancel_close_tab",
    }
}

fn resolve_agent_snapshot_metadata(
    state: &AppState,
    tile_id: &str,
    title_override: Option<String>,
) -> Result<(String, String, String, String), String> {
    let record = state
        .tile_record(tile_id)?
        .ok_or_else(|| format!("unknown tile: {tile_id}"))?;
    let snapshot = crate::tmux_state::snapshot(state)?;
    let pane = snapshot
        .panes
        .iter()
        .find(|pane| pane.id == record.pane_id && pane.window_id == record.window_id)
        .cloned()
        .ok_or_else(|| format!("no tmux pane found for tile {tile_id}"))?;
    let window = snapshot
        .windows
        .iter()
        .find(|window| window.id == record.window_id)
        .cloned()
        .ok_or_else(|| format!("no tmux window found for tile {tile_id}"))?;
    let title = title_override
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| {
            if !window.name.trim().is_empty() {
                window.name.clone()
            } else if !pane.title.trim().is_empty() {
                pane.title.clone()
            } else {
                "Agent".to_string()
            }
        });
    Ok((window.id, record.session_id, record.pane_id, title))
}

async fn agent_ping_loop(state: AppState, app: AppHandle) {
    loop {
        tokio::time::sleep(Duration::from_secs(5)).await;
        let cycle = match state.prepare_agent_ping_cycle(AGENT_PING_INTERVAL, AGENT_PING_TIMEOUT) {
            Ok(cycle) => cycle,
            Err(error) => {
                log::warn!("agent ping cycle failed: {error}");
                continue;
            }
        };

        for agent_id in cycle.expired {
            let _ = mark_agent_dead(&state, &app, &agent_id);
        }

        for (agent_id, ping_id) in cycle.to_ping {
            let event = AgentChannelEvent {
                kind: AgentChannelEventKind::Ping,
                from_agent_id: None,
                from_display_name: "HERD".to_string(),
                to_agent_id: Some(agent_id.clone()),
                to_display_name: None,
                message: "PING".to_string(),
                channels: Vec::new(),
                mentions: Vec::new(),
                replay: false,
                ping_id: Some(ping_id),
                timestamp_ms: now_ms(),
            };
            if state.send_event_to_agent(&agent_id, event).is_err() {
                let _ = mark_agent_dead(&state, &app, &agent_id);
            }
        }
    }
}

async fn handle_agent_event_subscription(
    agent_id: String,
    channel: TileMessageChannel,
    mut lines: tokio::io::Lines<BufReader<tokio::net::unix::OwnedReadHalf>>,
    mut writer: tokio::net::unix::OwnedWriteHalf,
    state: AppState,
    app: AppHandle,
    logger: SharedLogger,
) {
    let (sender, mut receiver) = tokio_mpsc::unbounded_channel();
    let started = Instant::now();
    let subscription = match state.subscribe_agent_events(&agent_id, sender) {
        Ok(subscription) => subscription,
        Err(error) => {
            let _ = append_tile_message_log_entry(
                &state,
                &app,
                TileMessageLogEntry {
                    session_id: resolve_ui_session_id(&state).unwrap_or_default(),
                    layer: TileMessageLogLayer::Socket,
                    channel,
                    target_id: agent_id.clone(),
                    target_kind: "agent_registry".to_string(),
                    wrapper_command: "agent_events_subscribe".to_string(),
                    message_name: "agent_events_subscribe".to_string(),
                    caller_agent_id: None,
                    caller_tile_id: None,
                    caller_window_id: None,
                    args: serde_json::json!({}),
                    related_tile_ids: Vec::new(),
                    outcome: TileMessageOutcome::Error,
                    error: Some(error.clone()),
                    duration_ms: started.elapsed().as_millis() as i64,
                    timestamp_ms: now_ms(),
                },
            );
            let mut resp_json = serde_json::to_string(&SocketResponse::error(error)).unwrap_or_default();
            resp_json.push('\n');
            let _ = writer.write_all(resp_json.as_bytes()).await;
            return;
        }
    };
    let _ = append_tile_message_log_entry(
        &state,
        &app,
        TileMessageLogEntry {
            session_id: subscription.info.session_id.clone(),
            layer: TileMessageLogLayer::Socket,
            channel,
            target_id: agent_id.clone(),
            target_kind: "agent_registry".to_string(),
            wrapper_command: "agent_events_subscribe".to_string(),
            message_name: "agent_events_subscribe".to_string(),
            caller_agent_id: None,
            caller_tile_id: None,
            caller_window_id: None,
            args: serde_json::json!({}),
            related_tile_ids: vec![subscription.info.tile_id.clone()],
            outcome: TileMessageOutcome::Ok,
            error: None,
            duration_ms: started.elapsed().as_millis() as i64,
            timestamp_ms: now_ms(),
        },
    );
    let replay_entries = state
        .replayable_chatter_since_for_agent(&agent_id, now_ms() - AGENT_REPLAY_WINDOW_MS)
        .unwrap_or_default();

    let response = SocketResponse::success(Some(serde_json::json!({
        "agent": subscription.info,
    })));
    let mut resp_json = serde_json::to_string(&response).unwrap_or_default();
    if let Ok(mut guard) = logger.lock() {
        if let Some(ref mut l) = *guard {
            l.log("<<<", &resp_json);
        }
    }
    resp_json.push('\n');
    if writer.write_all(resp_json.as_bytes()).await.is_err() {
        if let Ok(Some(info)) = state.unsubscribe_agent_events(&agent_id, subscription.subscriber_id) {
            let _ = process_dead_agent(&state, &app, info);
        }
        return;
    }

    if subscription.signed_on {
        let entry = build_sign_on_entry(&subscription.info.session_id, &subscription.info.display_name);
        let _ = append_chatter_entry(&state, &app, entry.clone());
        broadcast_public_event(&state, &app, &entry);
        emit_agent_state(&app, &state);
    }

    if subscription.bootstrap {
        let welcome = AgentChannelEvent {
            kind: AgentChannelEventKind::Direct,
            from_agent_id: None,
            from_display_name: "HERD".to_string(),
            to_agent_id: Some(agent_id.clone()),
            to_display_name: Some(subscription.info.display_name.clone()),
            message: match subscription.info.agent_role {
                AgentRole::Root => HERD_ROOT_WELCOME_MESSAGE,
                AgentRole::Worker => HERD_WORKER_WELCOME_MESSAGE,
            }
            .to_string(),
            channels: Vec::new(),
            mentions: Vec::new(),
            replay: false,
            ping_id: None,
            timestamp_ms: now_ms(),
        };
        let _ = state.send_event_to_agent(&agent_id, welcome);
        for entry in replay_entries {
            let _ = state.send_event_to_agent(&agent_id, channel_event_from_entry(&entry, true));
        }
    }

    loop {
        tokio::select! {
            maybe_event = receiver.recv() => {
                let Some(event) = maybe_event else {
                    break;
                };
                let mut event_json = serde_json::to_string(&event).unwrap_or_default();
                if let Ok(mut guard) = logger.lock() {
                    if let Some(ref mut l) = *guard {
                        l.log("<<<", &event_json);
                    }
                }
                event_json.push('\n');
                if writer.write_all(event_json.as_bytes()).await.is_err() {
                    break;
                }
            }
            maybe_line = lines.next_line() => {
                match maybe_line {
                    Ok(Some(_)) => {}
                    Ok(None) | Err(_) => break,
                }
            }
        }
    }

    if let Ok(Some(info)) = state.unsubscribe_agent_events(&agent_id, subscription.subscriber_id) {
        let _ = process_dead_agent(&state, &app, info);
    }
}

pub async fn start(state: AppState, app_handle: AppHandle) {
    let path = Path::new(runtime::socket_path());
    remove_stale_socket_path(path);

    let listener = match UnixListener::bind(runtime::socket_path()) {
        Ok(l) => l,
        Err(e) => {
            log::error!("Failed to bind Unix socket at {}: {e}", runtime::socket_path());
            return;
        }
    };
    remember_socket_binding(path);

    let logger: SharedLogger = Arc::new(Mutex::new(SocketLogger::open()));
    log::info!("Socket server listening on {}", runtime::socket_path());
    tokio::spawn(agent_ping_loop(state.clone(), app_handle.clone()));

    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                let state = state.clone();
                let app = app_handle.clone();
                let logger = logger.clone();
                tokio::spawn(async move {
                    handle_connection(stream, state, app, logger).await;
                });
            }
            Err(e) => {
                log::error!("Socket accept error: {e}");
            }
        }
    }
}

async fn handle_connection(
    stream: tokio::net::UnixStream,
    state: AppState,
    app: AppHandle,
    logger: SharedLogger,
) {
    let (reader, mut writer) = stream.into_split();
    let mut lines = BufReader::new(reader).lines();

    while let Ok(Some(line)) = lines.next_line().await {
        if let Ok(mut guard) = logger.lock() {
            if let Some(ref mut l) = *guard {
                l.log(">>>", &line);
            }
        }

        let response = match serde_json::from_str::<serde_json::Value>(&line) {
            Ok(raw) => {
                let channel = match TileMessageChannel::parse(raw.get("channel").and_then(serde_json::Value::as_str)) {
                    Ok(channel) => channel,
                    Err(error) => {
                        let response = SocketResponse::error(error);
                        let mut resp_json = serde_json::to_string(&response).unwrap_or_default();
                        if let Ok(mut guard) = logger.lock() {
                            if let Some(ref mut l) = *guard {
                                l.log("<<<", &resp_json);
                            }
                        }
                        resp_json.push('\n');
                        let _ = writer.write_all(resp_json.as_bytes()).await;
                        continue;
                    }
                };
                match serde_json::from_value::<SocketCommand>(raw) {
                    Ok(SocketCommand::AgentEventsSubscribe { agent_id }) => {
                        handle_agent_event_subscription(agent_id, channel, lines, writer, state, app, logger).await;
                        return;
                    }
                    Ok(cmd) => handle_command(cmd, channel, &state, &app),
                    Err(e) => SocketResponse::error(format!("Parse error: {e}")),
                }
            }
            Err(e) => SocketResponse::error(format!("Parse error: {e}")),
        };

        let mut resp_json = serde_json::to_string(&response).unwrap_or_default();

        if let Ok(mut guard) = logger.lock() {
            if let Some(ref mut l) = *guard {
                l.log("<<<", &resp_json);
            }
        }

        resp_json.push('\n');
        if writer.write_all(resp_json.as_bytes()).await.is_err() {
            break;
        }
    }
}

fn handle_command(
    cmd: SocketCommand,
    channel: TileMessageChannel,
    state: &AppState,
    app: &AppHandle,
) -> SocketResponse {
    match cmd {
        SocketCommand::TileCreate {
            tile_type,
            title,
            x,
            y,
            width,
            height,
            parent_session_id,
            parent_tile_id,
            browser_incognito,
            browser_path,
            sender_agent_id,
            sender_tile_id,
        } => {
            let sender = match sender_agent_id
                .clone()
                .or(sender_tile_id.clone())
                .map(|_| resolve_sender_context(state, sender_agent_id.clone(), sender_tile_id.clone()))
            {
                Some(Ok(sender)) => Some(sender),
                Some(Err(error)) => return SocketResponse::error(error),
                None => None,
            };
            let before = match crate::tmux_state::snapshot(state) {
                Ok(snapshot) => snapshot,
                Err(e) => return SocketResponse::error(e),
            };
            let (target_session_id, parent_window_id) =
                resolve_create_target(
                    state,
                    &before,
                    sender.as_ref().map(|context| context.session_id.clone()),
                    parent_session_id,
                    parent_tile_id,
                );
            let target_session_id =
                target_session_id.unwrap_or_else(|| before.active_session_id.unwrap_or_default());
            let args = serde_json::json!({
                "tile_type": tile_type,
                "title": title,
                "x": x,
                "y": y,
                "width": width,
                "height": height,
                "parent_window_id": parent_window_id,
                "browser_incognito": browser_incognito,
                "browser_path": browser_path,
            });
            let receiver = SessionMessageReceiver::new(target_session_id, sender.clone());
            dispatch_session_message(
                state,
                app,
                channel,
                &receiver,
                "tile_create",
                "tile_create",
                sender.as_ref(),
                args,
            )
        }

        SocketCommand::TileDestroy { tile_id, sender_agent_id, sender_tile_id } => {
            let sender = match ensure_root_for_sender(state, sender_agent_id, sender_tile_id, "tile_destroy") {
                Ok(sender) => sender,
                Err(error) => return SocketResponse::error(error),
            };
            let receiver = SessionMessageReceiver::new(sender.session_id.clone(), Some(sender.clone()));
            dispatch_session_message(
                state,
                app,
                channel,
                &receiver,
                "tile_destroy",
                "tile_destroy",
                Some(&sender),
                serde_json::json!({ "tile_id": tile_id }),
            )
        }

        SocketCommand::ShellInputSend { tile_id, input, sender_agent_id, sender_tile_id } => {
            let sender = match ensure_root_for_sender(state, sender_agent_id, sender_tile_id, "shell_input_send") {
                Ok(sender) => sender,
                Err(error) => return SocketResponse::error(error),
            };
            let args = serde_json::json!({ "input": input });
            let receiver = match session_tile_receiver(app, state, &sender.session_id, &tile_id) {
                Ok(receiver) => receiver,
                Err(error) => {
                    return dispatch_with_log(
                        state,
                        app,
                        channel,
                        sender.session_id.clone(),
                        tile_id,
                        "tile".to_string(),
                        "shell_input_send",
                        "input_send",
                        Some(&sender),
                        args,
                        || Err(error),
                    )
                }
            };
            dispatch_tile_message(state, app, channel, &receiver, "shell_input_send", "input_send", Some(&sender), args)
        }

        SocketCommand::ShellExec { tile_id, shell_command, sender_agent_id, sender_tile_id } => {
            let sender = match ensure_root_for_sender(state, sender_agent_id, sender_tile_id, "shell_exec") {
                Ok(sender) => sender,
                Err(error) => return SocketResponse::error(error),
            };
            let args = serde_json::json!({ "command": shell_command });
            let receiver = match session_tile_receiver(app, state, &sender.session_id, &tile_id) {
                Ok(receiver) => receiver,
                Err(error) => {
                    return dispatch_with_log(
                        state,
                        app,
                        channel,
                        sender.session_id.clone(),
                        tile_id,
                        "tile".to_string(),
                        "shell_exec",
                        "exec",
                        Some(&sender),
                        args,
                        || Err(error),
                    )
                }
            };
            dispatch_tile_message(state, app, channel, &receiver, "shell_exec", "exec", Some(&sender), args)
        }

        SocketCommand::ShellOutputRead { tile_id, sender_agent_id, sender_tile_id } => {
            let sender = match ensure_root_for_sender(state, sender_agent_id, sender_tile_id, "shell_output_read") {
                Ok(sender) => sender,
                Err(error) => return SocketResponse::error(error),
            };
            let args = serde_json::json!({});
            let receiver = match session_tile_receiver(app, state, &sender.session_id, &tile_id) {
                Ok(receiver) => receiver,
                Err(error) => {
                    return dispatch_with_log(
                        state,
                        app,
                        channel,
                        sender.session_id.clone(),
                        tile_id,
                        "tile".to_string(),
                        "shell_output_read",
                        "output_read",
                        Some(&sender),
                        args,
                        || Err(error),
                    )
                }
            };
            dispatch_tile_message(
                state,
                app,
                channel,
                &receiver,
                "shell_output_read",
                "output_read",
                Some(&sender),
                serde_json::json!({}),
            )
        }

        SocketCommand::TileRename { tile_id, title, sender_agent_id, sender_tile_id } => {
            let sender = match ensure_root_for_sender(state, sender_agent_id, sender_tile_id, "tile_rename") {
                Ok(sender) => sender,
                Err(error) => return SocketResponse::error(error),
            };
            let receiver = SessionMessageReceiver::new(sender.session_id.clone(), Some(sender.clone()));
            dispatch_session_message(
                state,
                app,
                channel,
                &receiver,
                "tile_rename",
                "tile_rename",
                Some(&sender),
                serde_json::json!({ "tile_id": tile_id, "title": title }),
            )
        }

        SocketCommand::ShellRoleSet { tile_id, role, sender_agent_id, sender_tile_id } => {
            let sender = match ensure_root_for_sender(state, sender_agent_id, sender_tile_id, "shell_role_set") {
                Ok(sender) => sender,
                Err(error) => return SocketResponse::error(error),
            };
            let args = serde_json::json!({ "role": role });
            let receiver = match session_tile_receiver(app, state, &sender.session_id, &tile_id) {
                Ok(receiver) => receiver,
                Err(error) => {
                    return dispatch_with_log(
                        state,
                        app,
                        channel,
                        sender.session_id.clone(),
                        tile_id,
                        "tile".to_string(),
                        "shell_role_set",
                        "role_set",
                        Some(&sender),
                        args,
                        || Err(error),
                    )
                }
            };
            dispatch_tile_message(state, app, channel, &receiver, "shell_role_set", "role_set", Some(&sender), args)
        }

        SocketCommand::BrowserNavigate { tile_id, url, sender_agent_id, sender_tile_id } => {
            let sender = match ensure_root_for_sender(state, sender_agent_id, sender_tile_id, "browser_navigate") {
                Ok(sender) => sender,
                Err(error) => return SocketResponse::error(error),
            };
            let args = serde_json::json!({ "url": url });
            let receiver = match session_tile_receiver(app, state, &sender.session_id, &tile_id) {
                Ok(receiver) => receiver,
                Err(error) => {
                    return dispatch_with_log(
                        state,
                        app,
                        channel,
                        sender.session_id.clone(),
                        tile_id,
                        "tile".to_string(),
                        "browser_navigate",
                        "navigate",
                        Some(&sender),
                        args,
                        || Err(error),
                    )
                }
            };
            dispatch_tile_message(state, app, channel, &receiver, "browser_navigate", "navigate", Some(&sender), args)
        }

        SocketCommand::BrowserLoad { tile_id, path, sender_agent_id, sender_tile_id } => {
            let sender = match ensure_root_for_sender(state, sender_agent_id, sender_tile_id, "browser_load") {
                Ok(sender) => sender,
                Err(error) => return SocketResponse::error(error),
            };
            let args = serde_json::json!({ "path": path });
            let receiver = match session_tile_receiver(app, state, &sender.session_id, &tile_id) {
                Ok(receiver) => receiver,
                Err(error) => {
                    return dispatch_with_log(
                        state,
                        app,
                        channel,
                        sender.session_id.clone(),
                        tile_id,
                        "tile".to_string(),
                        "browser_load",
                        "load",
                        Some(&sender),
                        args,
                        || Err(error),
                    )
                }
            };
            dispatch_tile_message(state, app, channel, &receiver, "browser_load", "load", Some(&sender), args)
        }

        SocketCommand::BrowserDrive { tile_id, action, args, sender_agent_id, sender_tile_id } => {
            let sender = match resolve_sender_context(state, sender_agent_id, sender_tile_id) {
                Ok(sender) => sender,
                Err(error) => return SocketResponse::error(error),
            };
            let component = if sender.sender_agent_role == Some(AgentRole::Root) {
                None
            } else {
                Some(match component_for_sender(app, state, &sender) {
                    Ok(component) => component,
                    Err(error) => return SocketResponse::error(error),
                })
            };
            let receiver = match if let Some(component) = component.as_ref() {
                component_tile_receiver(component, &tile_id)
            } else {
                session_tile_receiver(app, state, &sender.session_id, &tile_id)
            } {
                Ok(receiver) => receiver,
                Err(error) => {
                    return dispatch_with_log(
                        state,
                        app,
                        channel,
                        sender.session_id.clone(),
                        tile_id,
                        "browser".to_string(),
                        "browser_drive",
                        &action,
                        Some(&sender),
                        args.clone().unwrap_or_else(|| serde_json::json!({})),
                        || Err(error),
                    )
                }
            };
            let drive_args = args.clone().unwrap_or_else(|| serde_json::json!({}));
            dispatch_with_log(
                state,
                app,
                channel,
                receiver.session_id().to_string(),
                receiver.target_id().to_string(),
                receiver.target_kind().to_string(),
                "browser_drive",
                &action,
                Some(&sender),
                drive_args.clone(),
                || {
                    if let Some(component) = component.as_ref() {
                        ensure_network_message_allowed(&sender, component, &receiver, "drive")?;
                    }
                    let result = dispatch_result_with_log(
                        state,
                        app,
                        TileMessageLogLayer::Message,
                        channel,
                        receiver.session_id().to_string(),
                        receiver.target_id().to_string(),
                        receiver.target_kind().to_string(),
                        "browser_drive",
                        "drive",
                        Some(&sender),
                        serde_json::json!({ "action": action.clone(), "args": drive_args.clone() }),
                        || receiver.send(
                            app,
                            state,
                            "drive",
                            Some(&sender),
                            Some(&serde_json::json!({ "action": action.clone(), "args": drive_args.clone() })),
                        ),
                    )?;
                    Ok(Some(serde_json::json!({
                        "tile_id": receiver.target_id(),
                        "action": action,
                        "result": result,
                    })))
                },
            )
        }

        SocketCommand::AgentRegister { agent_id, agent_type, agent_role, tile_id, agent_pid, title } => {
            let session_id = match resolve_session_id_for_tile(state, &tile_id) {
                Ok(session_id) => session_id,
                Err(error) => return SocketResponse::error(error),
            };
            let receiver = SessionMessageReceiver::new(session_id, None);
            let args = serde_json::json!({
                "agent_id": agent_id,
                "tile_id": tile_id,
                "agent_type": agent_type,
                "agent_role": agent_role,
                "agent_pid": agent_pid,
                "title": title,
            });
            dispatch_session_message(state, app, channel, &receiver, "agent_register", "agent_register", None, args)
        }

        SocketCommand::AgentUnregister { agent_id } => {
            let session_id = state
                .agent_info(&agent_id)
                .ok()
                .flatten()
                .map(|info| info.session_id)
                .or_else(|| resolve_ui_session_id(state).ok())
                .unwrap_or_default();
            let receiver = SessionMessageReceiver::new(session_id, None);
            dispatch_session_message(
                state,
                app,
                channel,
                &receiver,
                "agent_unregister",
                "agent_unregister",
                None,
                serde_json::json!({ "agent_id": agent_id }),
            )
        }

        SocketCommand::AgentPingAck { agent_id } => {
            let session_id = state
                .agent_info(&agent_id)
                .ok()
                .flatten()
                .map(|info| info.session_id)
                .or_else(|| resolve_ui_session_id(state).ok())
                .unwrap_or_default();
            let receiver = SessionMessageReceiver::new(session_id, None);
            dispatch_session_message(
                state,
                app,
                channel,
                &receiver,
                "agent_ping_ack",
                "agent_ping_ack",
                None,
                serde_json::json!({ "agent_id": agent_id }),
            )
        }

        SocketCommand::MessageChannelList { sender_agent_id, sender_tile_id } => {
            let sender = match ensure_root_for_sender(state, sender_agent_id, sender_tile_id, "message_channel_list") {
                Ok(sender) => sender,
                Err(error) => return SocketResponse::error(error),
            };
            let receiver = SessionMessageReceiver::new(sender.session_id.clone(), Some(sender.clone()));
            dispatch_session_message(
                state,
                app,
                channel,
                &receiver,
                "message_channel_list",
                "message_channel_list",
                Some(&sender),
                serde_json::json!({}),
            )
        }

        SocketCommand::ListNetwork { sender_agent_id, sender_tile_id, tile_type } => {
            let sender = match resolve_sender_context(state, sender_agent_id, sender_tile_id) {
                Ok(sender) => sender,
                Err(error) => return SocketResponse::error(error),
            };
            let receiver = SessionMessageReceiver::new(sender.session_id.clone(), Some(sender.clone()));
            dispatch_session_message(
                state,
                app,
                channel,
                &receiver,
                "network_list",
                "network_list",
                Some(&sender),
                serde_json::json!({ "tile_type": tile_type }),
            )
        }

        SocketCommand::NetworkGet { tile_id, sender_agent_id, sender_tile_id } => {
            let sender = match resolve_sender_context(state, sender_agent_id, sender_tile_id) {
                Ok(sender) => sender,
                Err(error) => return SocketResponse::error(error),
            };
            let receiver = SessionMessageReceiver::new(sender.session_id.clone(), Some(sender.clone()));
            dispatch_session_message(
                state,
                app,
                channel,
                &receiver,
                "network_get",
                "network_get",
                Some(&sender),
                serde_json::json!({ "tile_id": tile_id }),
            )
        }

        SocketCommand::NetworkCall { tile_id, action, args, sender_agent_id, sender_tile_id } => {
            let sender = match resolve_sender_context(state, sender_agent_id, sender_tile_id) {
                Ok(sender) => sender,
                Err(error) => return SocketResponse::error(error),
            };
            let receiver = SessionMessageReceiver::new(sender.session_id.clone(), Some(sender.clone()));
            dispatch_session_message(
                state,
                app,
                channel,
                &receiver,
                "network_call",
                "network_call",
                Some(&sender),
                serde_json::json!({
                    "tile_id": tile_id,
                    "action": action,
                    "args": args.unwrap_or_else(|| serde_json::json!({})),
                }),
            )
        }

        SocketCommand::TileList { sender_agent_id, sender_tile_id, tile_type } => {
            let sender = match ensure_root_for_sender(state, sender_agent_id, sender_tile_id, "tile_list") {
                Ok(sender) => sender,
                Err(error) => return SocketResponse::error(error),
            };
            let receiver = SessionMessageReceiver::new(sender.session_id.clone(), Some(sender.clone()));
            dispatch_session_message(
                state,
                app,
                channel,
                &receiver,
                "tile_list",
                "tile_list",
                Some(&sender),
                serde_json::json!({ "tile_type": tile_type }),
            )
        }

        SocketCommand::TileGet { tile_id, sender_agent_id, sender_tile_id } => {
            let sender = match ensure_root_for_sender(state, sender_agent_id, sender_tile_id, "tile_get") {
                Ok(sender) => sender,
                Err(error) => return SocketResponse::error(error),
            };
            let receiver = match session_tile_receiver(app, state, &sender.session_id, &tile_id) {
                Ok(receiver) => receiver,
                Err(error) => {
                    return dispatch_with_log(
                        state,
                        app,
                        channel,
                        sender.session_id.clone(),
                        tile_id,
                        "tile".to_string(),
                        "tile_get",
                        "get",
                        Some(&sender),
                        serde_json::json!({}),
                        || Err(error),
                    )
                }
            };
            dispatch_tile_message(state, app, channel, &receiver, "tile_get", "get", Some(&sender), serde_json::json!({}))
        }

        SocketCommand::TileCall { tile_id, action, args, sender_agent_id, sender_tile_id } => {
            let sender = match resolve_sender_context(state, sender_agent_id, sender_tile_id) {
                Ok(sender) => sender,
                Err(error) => return SocketResponse::error(error),
            };
            let component = if sender.sender_agent_role == Some(AgentRole::Root) {
                None
            } else {
                Some(match component_for_sender(app, state, &sender) {
                    Ok(component) => component,
                    Err(error) => return SocketResponse::error(error),
                })
            };
            let receiver = match if let Some(component) = component.as_ref() {
                component_tile_receiver(component, &tile_id)
            } else {
                session_tile_receiver(app, state, &sender.session_id, &tile_id)
            } {
                Ok(receiver) => receiver,
                Err(error) => {
                    return dispatch_with_log(
                        state,
                        app,
                        channel,
                        sender.session_id.clone(),
                        tile_id,
                        "tile".to_string(),
                        "tile_call",
                        &action,
                        Some(&sender),
                        args.clone().unwrap_or_else(|| serde_json::json!({})),
                        || Err(error),
                    )
                }
            };
            let call_args = args.clone().unwrap_or_else(|| serde_json::json!({}));
            dispatch_with_log(
                state,
                app,
                channel,
                receiver.session_id().to_string(),
                receiver.target_id().to_string(),
                receiver.target_kind().to_string(),
                "tile_call",
                &action,
                Some(&sender),
                call_args.clone(),
                || {
                    if let Some(component) = component.as_ref() {
                        ensure_network_message_allowed(&sender, component, &receiver, &action)?;
                    }
                    let result = dispatch_result_with_log(
                        state,
                        app,
                        TileMessageLogLayer::Message,
                        channel,
                        receiver.session_id().to_string(),
                        receiver.target_id().to_string(),
                        receiver.target_kind().to_string(),
                        "tile_call",
                        &action,
                        Some(&sender),
                        call_args.clone(),
                        || receiver.send(app, state, &action, Some(&sender), Some(&call_args)),
                    )?;
                    Ok(Some(serde_json::json!({
                        "tile_id": receiver.target_id(),
                        "action": action,
                        "result": result,
                    })))
                },
            )
        }

        SocketCommand::TileMove {
            tile_id,
            x,
            y,
            sender_agent_id,
            sender_tile_id,
        } => {
            let sender = match ensure_root_for_sender(state, sender_agent_id, sender_tile_id, "tile_move") {
                Ok(sender) => sender,
                Err(error) => return SocketResponse::error(error),
            };
            let receiver = SessionMessageReceiver::new(sender.session_id.clone(), Some(sender.clone()));
            dispatch_session_message(
                state,
                app,
                channel,
                &receiver,
                "tile_move",
                "tile_move",
                Some(&sender),
                serde_json::json!({ "tile_id": tile_id, "x": x, "y": y }),
            )
        }

        SocketCommand::TileResize {
            tile_id,
            width,
            height,
            sender_agent_id,
            sender_tile_id,
        } => {
            let sender = match ensure_root_for_sender(state, sender_agent_id, sender_tile_id, "tile_resize") {
                Ok(sender) => sender,
                Err(error) => return SocketResponse::error(error),
            };
            let receiver = SessionMessageReceiver::new(sender.session_id.clone(), Some(sender.clone()));
            dispatch_session_message(
                state,
                app,
                channel,
                &receiver,
                "tile_resize",
                "tile_resize",
                Some(&sender),
                serde_json::json!({ "tile_id": tile_id, "width": width, "height": height }),
            )
        }

        SocketCommand::TileArrangeElk {
            sender_agent_id,
            sender_tile_id,
        } => {
            let sender = match ensure_root_for_sender(state, sender_agent_id, sender_tile_id, "tile_arrange_elk") {
                Ok(sender) => sender,
                Err(error) => return SocketResponse::error(error),
            };
            let receiver = SessionMessageReceiver::new(sender.session_id.clone(), Some(sender.clone()));
            dispatch_session_message(
                state,
                app,
                channel,
                &receiver,
                "tile_arrange_elk",
                "tile_arrange_elk",
                Some(&sender),
                serde_json::json!({}),
            )
        }

        SocketCommand::NetworkConnect {
            from_tile_id,
            from_port,
            to_tile_id,
            to_port,
            sender_agent_id,
            sender_tile_id,
        } => {
            let sender = match ensure_root_for_sender(state, sender_agent_id, sender_tile_id, "network_connect") {
                Ok(sender) => sender,
                Err(error) => return SocketResponse::error(error),
            };
            let args = serde_json::json!({
                "from_tile_id": from_tile_id,
                "from_port": from_port,
                "to_tile_id": to_tile_id,
                "to_port": to_port,
            });
            let receiver = SessionMessageReceiver::new(sender.session_id.clone(), Some(sender.clone()));
            dispatch_session_message(
                state,
                app,
                channel,
                &receiver,
                "network_connect",
                "network_connect",
                Some(&sender),
                args,
            )
        }

        SocketCommand::NetworkDisconnect { tile_id, port, sender_agent_id, sender_tile_id } => {
            let sender = match ensure_root_for_sender(state, sender_agent_id, sender_tile_id, "network_disconnect") {
                Ok(sender) => sender,
                Err(error) => return SocketResponse::error(error),
            };
            let args = serde_json::json!({ "tile_id": tile_id, "port": port });
            let receiver = SessionMessageReceiver::new(sender.session_id.clone(), Some(sender.clone()));
            dispatch_session_message(
                state,
                app,
                channel,
                &receiver,
                "network_disconnect",
                "network_disconnect",
                Some(&sender),
                args,
            )
        }

        SocketCommand::MessageDirect {
            to_agent_id,
            message,
            sender_agent_id,
            sender_tile_id,
        } => {
            let sender = match resolve_sender_context(state, sender_agent_id, sender_tile_id) {
                Ok(sender) => sender,
                Err(error) => return SocketResponse::error(error),
            };
            let args = serde_json::json!({ "message": message });
            let receiver = SessionMessageReceiver::new(sender.session_id.clone(), Some(sender.clone()));
            dispatch_session_message(
                state,
                app,
                channel,
                &receiver,
                "message_direct",
                "message_direct",
                Some(&sender),
                serde_json::json!({ "to_agent_id": to_agent_id, "message": args["message"].clone() }),
            )
        }

        SocketCommand::MessagePublic {
            message,
            mentions,
            sender_agent_id,
            sender_tile_id,
        } => {
            let sender = match resolve_sender_context(state, sender_agent_id, sender_tile_id) {
                Ok(sender) => sender,
                Err(error) => return SocketResponse::error(error),
            };
            let args = serde_json::json!({ "message": message, "mentions": mentions });
            let receiver = SessionMessageReceiver::new(sender.session_id.clone(), Some(sender.clone()));
            dispatch_session_message(
                state,
                app,
                channel,
                &receiver,
                "message_public",
                "message_public",
                Some(&sender),
                args,
            )
        }

        SocketCommand::MessageChannel {
            channel_name,
            message,
            mentions,
            sender_agent_id,
            sender_tile_id,
        } => {
            let sender = match resolve_sender_context(state, sender_agent_id, sender_tile_id) {
                Ok(sender) => sender,
                Err(error) => return SocketResponse::error(error),
            };
            let args = serde_json::json!({
                "channel_name": channel_name,
                "message": message,
                "mentions": mentions,
            });
            let receiver = SessionMessageReceiver::new(sender.session_id.clone(), Some(sender.clone()));
            dispatch_session_message(
                state,
                app,
                channel,
                &receiver,
                "message_channel",
                "message_channel",
                Some(&sender),
                args,
            )
        }

        SocketCommand::MessageNetwork {
            message,
            sender_agent_id,
            sender_tile_id,
        } => {
            let sender = match resolve_sender_context(state, sender_agent_id, sender_tile_id) {
                Ok(sender) => sender,
                Err(error) => return SocketResponse::error(error),
            };
            let args = serde_json::json!({ "message": message });
            let receiver = SessionMessageReceiver::new(sender.session_id.clone(), Some(sender.clone()));
            dispatch_session_message(
                state,
                app,
                channel,
                &receiver,
                "message_network",
                "message_network",
                Some(&sender),
                args,
            )
        }

        SocketCommand::MessageRoot {
            message,
            sender_agent_id,
            sender_tile_id,
        } => {
            let sender = match resolve_sender_context(state, sender_agent_id, sender_tile_id) {
                Ok(sender) => sender,
                Err(error) => return SocketResponse::error(error),
            };
            let args = serde_json::json!({ "message": message });
            let receiver = SessionMessageReceiver::new(sender.session_id.clone(), Some(sender.clone()));
            dispatch_session_message(
                state,
                app,
                channel,
                &receiver,
                "message_root",
                "message_root",
                Some(&sender),
                args,
            )
        }

        SocketCommand::MessageChannelSubscribe {
            channel_name,
            agent_id,
            sender_agent_id,
            sender_tile_id,
        } => {
            let sender = match ensure_root_for_sender(state, sender_agent_id, sender_tile_id, "message_channel_subscribe") {
                Ok(sender) => sender,
                Err(error) => return SocketResponse::error(error),
            };
            let Some(channel_name) = crate::agent::normalize_channel(&channel_name) else {
                return SocketResponse::error("invalid channel".into());
            };
            let Some(agent_id) = agent_id else {
                return SocketResponse::error("agent_id is required".into());
            };
            let session_id = match live_agent_info(state, &agent_id) {
                Ok(info) => info.session_id,
                Err(error) => return SocketResponse::error(error),
            };
            let receiver = SessionMessageReceiver::new(session_id, Some(sender.clone()));
            dispatch_session_message(
                state,
                app,
                channel,
                &receiver,
                "message_channel_subscribe",
                "message_channel_subscribe",
                Some(&sender),
                serde_json::json!({ "agent_id": agent_id, "channel_name": channel_name }),
            )
        }

        SocketCommand::MessageChannelUnsubscribe {
            channel_name,
            agent_id,
            sender_agent_id,
            sender_tile_id,
        } => {
            let sender = match ensure_root_for_sender(state, sender_agent_id, sender_tile_id, "message_channel_unsubscribe") {
                Ok(sender) => sender,
                Err(error) => return SocketResponse::error(error),
            };
            let Some(channel_name) = crate::agent::normalize_channel(&channel_name) else {
                return SocketResponse::error("invalid channel".into());
            };
            let Some(agent_id) = agent_id else {
                return SocketResponse::error("agent_id is required".into());
            };
            let session_id = match live_agent_info(state, &agent_id) {
                Ok(info) => info.session_id,
                Err(error) => return SocketResponse::error(error),
            };
            let receiver = SessionMessageReceiver::new(session_id, Some(sender.clone()));
            dispatch_session_message(
                state,
                app,
                channel,
                &receiver,
                "message_channel_unsubscribe",
                "message_channel_unsubscribe",
                Some(&sender),
                serde_json::json!({ "agent_id": agent_id, "channel_name": channel_name }),
            )
        }

        SocketCommand::WorkStageStart { work_id, agent_id } => {
            let sender = match resolve_sender_context(state, Some(agent_id.clone()), None) {
                Ok(sender) => sender,
                Err(error) => return SocketResponse::error(error),
            };
            let tile_id = match work::tile_id_for_work_at(Path::new(runtime::database_path()), &work_id) {
                Ok(tile_id) => tile_id,
                Err(error) => return SocketResponse::error(error),
            };
            let receiver = match session_tile_receiver(app, state, &sender.session_id, &tile_id) {
                Ok(receiver) => receiver,
                Err(error) => {
                    return dispatch_with_log(
                        state,
                        app,
                        channel,
                        sender.session_id.clone(),
                        tile_id,
                        "work".to_string(),
                        "work_stage_start",
                        "stage_start",
                        Some(&sender),
                        serde_json::json!({ "agent_id": agent_id }),
                        || Err(error),
                    )
                }
            };
            dispatch_tile_message(
                state,
                app,
                channel,
                &receiver,
                "work_stage_start",
                "stage_start",
                Some(&sender),
                serde_json::json!({ "agent_id": agent_id }),
            )
        }

        SocketCommand::WorkStageComplete { work_id, agent_id } => {
            let sender = match resolve_sender_context(state, Some(agent_id.clone()), None) {
                Ok(sender) => sender,
                Err(error) => return SocketResponse::error(error),
            };
            let tile_id = match work::tile_id_for_work_at(Path::new(runtime::database_path()), &work_id) {
                Ok(tile_id) => tile_id,
                Err(error) => return SocketResponse::error(error),
            };
            let receiver = match session_tile_receiver(app, state, &sender.session_id, &tile_id) {
                Ok(receiver) => receiver,
                Err(error) => {
                    return dispatch_with_log(
                        state,
                        app,
                        channel,
                        sender.session_id.clone(),
                        tile_id,
                        "work".to_string(),
                        "work_stage_complete",
                        "stage_complete",
                        Some(&sender),
                        serde_json::json!({ "agent_id": agent_id }),
                        || Err(error),
                    )
                }
            };
            dispatch_tile_message(
                state,
                app,
                channel,
                &receiver,
                "work_stage_complete",
                "stage_complete",
                Some(&sender),
                serde_json::json!({ "agent_id": agent_id }),
            )
        }

        SocketCommand::WorkReviewApprove { work_id } => {
            let item = match work::get_work_item_at(Path::new(runtime::database_path()), &work_id) {
                Ok(info) => info,
                Err(error) => return SocketResponse::error(error),
            };
            let session_id = item.session_id.clone();
            let tile_id = item.tile_id.clone();
            let receiver = match session_tile_receiver(app, state, &session_id, &tile_id) {
                Ok(receiver) => receiver,
                Err(error) => {
                    return dispatch_with_log(
                        state,
                        app,
                        channel,
                        session_id,
                        tile_id,
                        "work".to_string(),
                        "work_review_approve",
                        "review_approve",
                        None,
                        serde_json::json!({}),
                        || Err(error),
                    )
                }
            };
            dispatch_tile_message(
                state,
                app,
                channel,
                &receiver,
                "work_review_approve",
                "review_approve",
                None,
                serde_json::json!({}),
            )
        }

        SocketCommand::WorkReviewImprove { work_id, comment } => {
            let item = match work::get_work_item_at(Path::new(runtime::database_path()), &work_id) {
                Ok(item) => item,
                Err(error) => return SocketResponse::error(error),
            };
            let session_id = item.session_id.clone();
            let tile_id = item.tile_id.clone();
            let args = serde_json::json!({ "comment": comment });
            let receiver = match session_tile_receiver(app, state, &session_id, &tile_id) {
                Ok(receiver) => receiver,
                Err(error) => {
                    return dispatch_with_log(
                        state,
                        app,
                        channel,
                        session_id,
                        tile_id,
                        "work".to_string(),
                        "work_review_improve",
                        "review_improve",
                        None,
                        args,
                        || Err(error),
                    )
                }
            };
            dispatch_tile_message(
                state,
                app,
                channel,
                &receiver,
                "work_review_improve",
                "review_improve",
                None,
                serde_json::json!({ "comment": comment }),
            )
        }

        SocketCommand::AgentEventsSubscribe { .. } => {
            SocketResponse::error("agent event subscriptions require a dedicated streaming connection".into())
        }

        SocketCommand::TestDriver { request } => {
            let message_name = test_driver_message_name(&request).to_string();
            let receiver = HerdMessageReceiver::new(resolve_ui_session_id(state).unwrap_or_default());
            let args = serde_json::json!({ "request": request.clone() });
            dispatch_herd_message(state, app, channel, &receiver, "test_driver", &message_name, args)
        }

        SocketCommand::TestDomQuery { js } => {
            let receiver = HerdMessageReceiver::new(resolve_ui_session_id(state).unwrap_or_default());
            let args = serde_json::json!({ "js": js });
            dispatch_herd_message(state, app, channel, &receiver, "test_dom_query", "test_dom_query", args)
        }

        SocketCommand::TestDomKeys { keys } => {
            let receiver = HerdMessageReceiver::new(resolve_ui_session_id(state).unwrap_or_default());
            let args = serde_json::json!({ "keys": keys });
            dispatch_herd_message(state, app, channel, &receiver, "test_dom_keys", "test_dom_keys", args)
        }
    }
}

pub fn cleanup() {
    cleanup_owned_socket_path(Path::new(runtime::socket_path()));
}

#[cfg(test)]
mod tests {
    use super::{HERD_ROOT_WELCOME_MESSAGE, HERD_WORKER_WELCOME_MESSAGE, SessionMessageReceiver};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_path(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time before epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("herd-{name}-{unique}"))
    }

    fn write_file(path: &Path, contents: &str) {
        fs::write(path, contents).expect("write test file");
    }

    #[test]
    fn welcome_messages_reference_role_specific_skills() {
        assert!(HERD_ROOT_WELCOME_MESSAGE.contains("/herd-root"));
        assert!(!HERD_ROOT_WELCOME_MESSAGE.contains("/herd-worker"));
        assert!(HERD_ROOT_WELCOME_MESSAGE.contains("full Herd MCP surface"));

        assert!(HERD_WORKER_WELCOME_MESSAGE.contains("/herd-worker"));
        assert!(!HERD_WORKER_WELCOME_MESSAGE.contains("/herd-root"));
        assert!(HERD_WORKER_WELCOME_MESSAGE.contains("Root manages the full session-wide MCP surface"));
    }

    #[test]
    fn cleanup_removes_recorded_socket_path() {
        let path = test_path("socket-owned");
        write_file(&path, "owned");

        super::remember_socket_binding(&path);
        super::cleanup_owned_socket_path(&path);

        assert!(!path.exists());
    }

    #[test]
    fn cleanup_removes_only_owned_socket_path() {
        let path = test_path("socket-replaced");
        let replacement_path = test_path("socket-replacement-source");

        write_file(&path, "original");
        super::remember_socket_binding(&path);

        fs::remove_file(&path).expect("remove original file");
        write_file(&replacement_path, "replacement");
        fs::rename(&replacement_path, &path).expect("replace socket path");

        super::cleanup_owned_socket_path(&path);

        assert!(path.exists(), "cleanup removed the replacement socket path");
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn session_message_surface_includes_tile_arrange_elk() {
        let receiver = SessionMessageReceiver::new("$1", None);
        assert!(receiver.responds_to().contains(&"tile_arrange_elk"));
    }
}
