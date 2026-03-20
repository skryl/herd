use serde::{Deserialize, Serialize};

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
        pane_id: String,
    },
    TileClose {
        pane_id: String,
    },
    TileDrag {
        pane_id: String,
        dx: f64,
        dy: f64,
    },
    TileResize {
        pane_id: String,
        width: f64,
        height: f64,
    },
    TileTitleDoubleClick {
        pane_id: String,
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
        pane_id: String,
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
    #[serde(rename = "spawn_shell")]
    SpawnShell {
        #[serde(default = "default_coord")]
        x: f64,
        #[serde(default = "default_coord")]
        y: f64,
        #[serde(default)]
        width: Option<f64>,
        #[serde(default)]
        height: Option<f64>,
        #[serde(default)]
        parent_session_id: Option<String>,
        #[serde(default)]
        parent_pane_id: Option<String>,
    },
    #[serde(rename = "destroy_shell")]
    DestroyShell { session_id: String },
    #[serde(rename = "list_shells")]
    ListShells,
    #[serde(rename = "send_input")]
    SendInput { session_id: String, input: String },
    #[serde(rename = "exec_in_shell")]
    ExecInShell { session_id: String, shell_command: String },
    #[serde(rename = "read_output")]
    ReadOutput { session_id: String },
    #[serde(rename = "set_title")]
    SetTitle { session_id: String, title: String },
    #[serde(rename = "set_read_only")]
    SetReadOnly { session_id: String, read_only: bool },
    #[serde(rename = "set_tile_role")]
    SetTileRole { session_id: String, role: String },
    #[serde(rename = "test_driver")]
    TestDriver { request: TestDriverRequest },
    #[serde(rename = "test_dom_query")]
    TestDomQuery { js: String },
    #[serde(rename = "test_dom_keys")]
    TestDomKeys { keys: String },
    #[serde(rename = "tmux_pane_created")]
    TmuxPaneCreated {
        tmux_session: String,
        parent_session_id: String,
        #[serde(default)]
        title: Option<String>,
    },
}

fn default_coord() -> f64 {
    100.0
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
