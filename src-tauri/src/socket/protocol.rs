use serde::{Deserialize, Serialize};

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
    #[serde(rename = "read_output")]
    ReadOutput { session_id: String },
    #[serde(rename = "set_title")]
    SetTitle { session_id: String, title: String },
    #[serde(rename = "set_read_only")]
    SetReadOnly { session_id: String, read_only: bool },
    #[serde(rename = "dom_query")]
    DomQuery { js: String },
    #[serde(rename = "dom_keys")]
    DomKeys { keys: String },
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
