use serde::{Deserialize, Serialize};

use crate::agent::{LedControlCommand, LedPatternArgs};
use crate::network::TileTypeFilter;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestDriverKey {
    pub key: String,
    #[serde(default)]
    pub shift_key: bool,
    #[serde(default)]
    pub ctrl_key: bool,
    #[serde(default)]
    pub alt_key: bool,
    #[serde(default)]
    pub meta_key: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TestDriverRequest {
    Ping,
    WaitForReady {
        #[serde(default)]
        timeout_ms: Option<u64>,
    },
    WaitForBootstrap {
        #[serde(default)]
        timeout_ms: Option<u64>,
    },
    WaitForIdle {
        #[serde(default)]
        timeout_ms: Option<u64>,
        #[serde(default)]
        settle_ms: Option<u64>,
    },
    GetStateTree,
    GetProjection,
    GetStatus,
    PressKeys {
        keys: Vec<TestDriverKey>,
        #[serde(default)]
        viewport_width: Option<f64>,
        #[serde(default)]
        viewport_height: Option<f64>,
    },
    CommandBarOpen,
    CommandBarSetText {
        text: String,
    },
    CommandBarSubmit,
    CommandBarCancel,
    ToolbarSelectTab {
        session_id: String,
    },
    ToolbarAddTab {
        #[serde(default)]
        name: Option<String>,
    },
    ToolbarSpawnShell,
    ToolbarSpawnWork {
        title: String,
    },
    SidebarOpen,
    SidebarClose,
    SidebarSelectItem {
        index: usize,
    },
    SidebarMoveSelection {
        delta: i32,
    },
    SidebarBeginRename,
    TileSelect {
        tile_id: String,
    },
    TileClose {
        tile_id: String,
    },
    TileDrag {
        tile_id: String,
        dx: f64,
        dy: f64,
    },
    TileResize {
        tile_id: String,
        width: f64,
        height: f64,
    },
    TileTitleDoubleClick {
        tile_id: String,
        #[serde(default)]
        viewport_width: Option<f64>,
        #[serde(default)]
        viewport_height: Option<f64>,
    },
    CanvasPan {
        dx: f64,
        dy: f64,
    },
    CanvasContextMenu {
        client_x: f64,
        client_y: f64,
    },
    CanvasZoomAt {
        x: f64,
        y: f64,
        zoom_factor: f64,
    },
    CanvasWheel {
        delta_y: f64,
        client_x: f64,
        client_y: f64,
    },
    CanvasFitAll {
        #[serde(default)]
        viewport_width: Option<f64>,
        #[serde(default)]
        viewport_height: Option<f64>,
    },
    CanvasReset,
    TileContextMenu {
        tile_id: String,
        client_x: f64,
        client_y: f64,
    },
    PortContextMenu {
        tile_id: String,
        port: crate::network::TilePort,
        client_x: f64,
        client_y: f64,
    },
    ContextMenuSelect {
        item_id: String,
    },
    ContextMenuDismiss,
    ConfirmCloseTab,
    CancelCloseTab,
}

#[derive(Deserialize)]
#[serde(tag = "command")]
pub enum SocketCommand {
    #[serde(rename = "shell_input_send")]
    ShellInputSend {
        tile_id: String,
        input: String,
        #[serde(default)]
        sender_agent_id: Option<String>,
        #[serde(default)]
        sender_tile_id: Option<String>,
    },
    #[serde(rename = "shell_exec")]
    ShellExec {
        tile_id: String,
        shell_command: String,
        #[serde(default)]
        sender_agent_id: Option<String>,
        #[serde(default)]
        sender_tile_id: Option<String>,
    },
    #[serde(rename = "shell_output_read")]
    ShellOutputRead {
        tile_id: String,
        #[serde(default)]
        sender_agent_id: Option<String>,
        #[serde(default)]
        sender_tile_id: Option<String>,
    },
    #[serde(rename = "shell_role_set")]
    ShellRoleSet {
        tile_id: String,
        role: String,
        #[serde(default)]
        sender_agent_id: Option<String>,
        #[serde(default)]
        sender_tile_id: Option<String>,
    },
    #[serde(rename = "browser_navigate")]
    BrowserNavigate {
        tile_id: String,
        url: String,
        #[serde(default)]
        sender_agent_id: Option<String>,
        #[serde(default)]
        sender_tile_id: Option<String>,
    },
    #[serde(rename = "browser_load")]
    BrowserLoad {
        tile_id: String,
        path: String,
        #[serde(default)]
        sender_agent_id: Option<String>,
        #[serde(default)]
        sender_tile_id: Option<String>,
    },
    #[serde(rename = "browser_drive")]
    BrowserDrive {
        tile_id: String,
        action: String,
        #[serde(default)]
        args: Option<serde_json::Value>,
        #[serde(default)]
        sender_agent_id: Option<String>,
        #[serde(default)]
        sender_tile_id: Option<String>,
    },
    #[serde(rename = "self_display_draw")]
    SelfDisplayDraw {
        text: String,
        columns: usize,
        rows: usize,
        #[serde(default)]
        sender_agent_id: Option<String>,
        #[serde(default)]
        sender_tile_id: Option<String>,
    },
    #[serde(rename = "self_led_control")]
    SelfLedControl {
        #[serde(default)]
        commands: Option<Vec<LedControlCommand>>,
        #[serde(default)]
        pattern_name: Option<String>,
        #[serde(default)]
        pattern_args: Option<LedPatternArgs>,
        #[serde(default)]
        sender_agent_id: Option<String>,
        #[serde(default)]
        sender_tile_id: Option<String>,
    },
    #[serde(rename = "self_display_status")]
    SelfDisplayStatus {
        text: String,
        #[serde(default)]
        sender_agent_id: Option<String>,
        #[serde(default)]
        sender_tile_id: Option<String>,
    },
    #[serde(rename = "self_info")]
    SelfInfo {
        #[serde(default)]
        sender_agent_id: Option<String>,
        #[serde(default)]
        sender_tile_id: Option<String>,
    },
    #[serde(rename = "agent_register")]
    AgentRegister {
        agent_id: String,
        #[serde(default)]
        agent_type: Option<String>,
        #[serde(default)]
        agent_role: Option<String>,
        tile_id: String,
        #[serde(default)]
        agent_pid: Option<u32>,
        #[serde(default)]
        title: Option<String>,
    },
    #[serde(rename = "agent_unregister")]
    AgentUnregister { agent_id: String },
    #[serde(rename = "agent_events_subscribe")]
    AgentEventsSubscribe { agent_id: String },
    #[serde(rename = "agent_ping_ack")]
    AgentPingAck { agent_id: String },
    #[serde(rename = "message_channel_list")]
    MessageChannelList {
        #[serde(default)]
        sender_agent_id: Option<String>,
        #[serde(default)]
        sender_tile_id: Option<String>,
    },
    #[serde(rename = "network_list")]
    ListNetwork {
        #[serde(default)]
        sender_agent_id: Option<String>,
        #[serde(default)]
        sender_tile_id: Option<String>,
        #[serde(default)]
        tile_type: Option<TileTypeFilter>,
    },
    #[serde(rename = "network_get")]
    NetworkGet {
        tile_id: String,
        #[serde(default)]
        sender_agent_id: Option<String>,
        #[serde(default)]
        sender_tile_id: Option<String>,
    },
    #[serde(rename = "network_call")]
    NetworkCall {
        tile_id: String,
        action: String,
        #[serde(default)]
        args: Option<serde_json::Value>,
        #[serde(default)]
        sender_agent_id: Option<String>,
        #[serde(default)]
        sender_tile_id: Option<String>,
    },
    #[serde(rename = "tile_create")]
    TileCreate {
        tile_type: TileTypeFilter,
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
        parent_session_id: Option<String>,
        #[serde(default)]
        parent_tile_id: Option<String>,
        #[serde(default)]
        browser_incognito: Option<bool>,
        #[serde(default)]
        browser_path: Option<String>,
        #[serde(default)]
        sender_agent_id: Option<String>,
        #[serde(default)]
        sender_tile_id: Option<String>,
    },
    #[serde(rename = "tile_list")]
    TileList {
        #[serde(default)]
        sender_agent_id: Option<String>,
        #[serde(default)]
        sender_tile_id: Option<String>,
        #[serde(default)]
        tile_type: Option<TileTypeFilter>,
    },
    #[serde(rename = "tile_destroy")]
    TileDestroy {
        tile_id: String,
        #[serde(default)]
        sender_agent_id: Option<String>,
        #[serde(default)]
        sender_tile_id: Option<String>,
    },
    #[serde(rename = "tile_get")]
    TileGet {
        tile_id: String,
        #[serde(default)]
        sender_agent_id: Option<String>,
        #[serde(default)]
        sender_tile_id: Option<String>,
    },
    #[serde(rename = "tile_rename")]
    TileRename {
        tile_id: String,
        title: String,
        #[serde(default)]
        sender_agent_id: Option<String>,
        #[serde(default)]
        sender_tile_id: Option<String>,
    },
    #[serde(rename = "tile_call")]
    TileCall {
        tile_id: String,
        action: String,
        #[serde(default)]
        args: Option<serde_json::Value>,
        #[serde(default)]
        sender_agent_id: Option<String>,
        #[serde(default)]
        sender_tile_id: Option<String>,
    },
    #[serde(rename = "tile_move")]
    TileMove {
        tile_id: String,
        x: f64,
        y: f64,
        #[serde(default)]
        sender_agent_id: Option<String>,
        #[serde(default)]
        sender_tile_id: Option<String>,
    },
    #[serde(rename = "tile_resize")]
    TileResize {
        tile_id: String,
        width: f64,
        height: f64,
        #[serde(default)]
        sender_agent_id: Option<String>,
        #[serde(default)]
        sender_tile_id: Option<String>,
    },
    #[serde(rename = "tile_arrange_elk")]
    TileArrangeElk {
        #[serde(default)]
        sender_agent_id: Option<String>,
        #[serde(default)]
        sender_tile_id: Option<String>,
    },
    #[serde(rename = "network_connect")]
    NetworkConnect {
        from_tile_id: String,
        from_port: String,
        to_tile_id: String,
        to_port: String,
        #[serde(default)]
        sender_agent_id: Option<String>,
        #[serde(default)]
        sender_tile_id: Option<String>,
    },
    #[serde(rename = "network_disconnect")]
    NetworkDisconnect {
        tile_id: String,
        port: String,
        #[serde(default)]
        sender_agent_id: Option<String>,
        #[serde(default)]
        sender_tile_id: Option<String>,
    },
    #[serde(rename = "message_direct")]
    MessageDirect {
        to_agent_id: String,
        message: String,
        #[serde(default)]
        sender_agent_id: Option<String>,
        #[serde(default)]
        sender_tile_id: Option<String>,
    },
    #[serde(rename = "message_public")]
    MessagePublic {
        message: String,
        #[serde(default)]
        mentions: Vec<String>,
        #[serde(default)]
        sender_agent_id: Option<String>,
        #[serde(default)]
        sender_tile_id: Option<String>,
    },
    #[serde(rename = "message_channel")]
    MessageChannel {
        channel_name: String,
        message: String,
        #[serde(default)]
        mentions: Vec<String>,
        #[serde(default)]
        sender_agent_id: Option<String>,
        #[serde(default)]
        sender_tile_id: Option<String>,
    },
    #[serde(rename = "message_network")]
    MessageNetwork {
        message: String,
        #[serde(default)]
        sender_agent_id: Option<String>,
        #[serde(default)]
        sender_tile_id: Option<String>,
    },
    #[serde(rename = "message_root")]
    MessageRoot {
        message: String,
        #[serde(default)]
        sender_agent_id: Option<String>,
        #[serde(default)]
        sender_tile_id: Option<String>,
    },
    #[serde(rename = "message_channel_subscribe")]
    MessageChannelSubscribe {
        channel_name: String,
        #[serde(default)]
        agent_id: Option<String>,
        #[serde(default)]
        sender_agent_id: Option<String>,
        #[serde(default)]
        sender_tile_id: Option<String>,
    },
    #[serde(rename = "message_channel_unsubscribe")]
    MessageChannelUnsubscribe {
        channel_name: String,
        #[serde(default)]
        agent_id: Option<String>,
        #[serde(default)]
        sender_agent_id: Option<String>,
        #[serde(default)]
        sender_tile_id: Option<String>,
    },
    #[serde(rename = "work_stage_start")]
    WorkStageStart { work_id: String, agent_id: String },
    #[serde(rename = "work_stage_complete")]
    WorkStageComplete { work_id: String, agent_id: String },
    #[serde(rename = "work_review_approve")]
    WorkReviewApprove { work_id: String },
    #[serde(rename = "work_review_improve")]
    WorkReviewImprove { work_id: String, comment: String },
    #[serde(rename = "test_driver")]
    TestDriver { request: TestDriverRequest },
    #[serde(rename = "test_dom_query")]
    TestDomQuery { js: String },
    #[serde(rename = "test_dom_keys")]
    TestDomKeys { keys: String },
}

#[derive(Serialize)]
pub struct SocketResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl SocketResponse {
    pub fn success(data: Option<serde_json::Value>) -> Self {
        Self {
            ok: true,
            data,
            error: None,
        }
    }

    pub fn error(msg: String) -> Self {
        Self {
            ok: false,
            data: None,
            error: Some(msg),
        }
    }
}
