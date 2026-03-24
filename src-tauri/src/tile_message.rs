use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TileMessageChannel {
    Cli,
    Socket,
    Mcp,
    Internal,
}

impl TileMessageChannel {
    pub fn parse(value: Option<&str>) -> Result<Self, String> {
        match value.unwrap_or("socket").trim() {
            "" | "socket" => Ok(Self::Socket),
            "cli" => Ok(Self::Cli),
            "mcp" => Ok(Self::Mcp),
            "internal" => Ok(Self::Internal),
            other => Err(format!("unsupported socket channel: {other}")),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum TileMessageLogLayer {
    #[default]
    Socket,
    Message,
    Network,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TileMessageOutcome {
    Ok,
    NotFound,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TileMessageLogEntry {
    #[serde(default)]
    pub session_id: String,
    #[serde(default)]
    pub layer: TileMessageLogLayer,
    pub channel: TileMessageChannel,
    pub target_id: String,
    pub target_kind: String,
    pub wrapper_command: String,
    pub message_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub caller_agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub caller_tile_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub caller_window_id: Option<String>,
    #[serde(default)]
    pub args: serde_json::Value,
    #[serde(default)]
    pub related_tile_ids: Vec<String>,
    pub outcome: TileMessageOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub duration_ms: i64,
    pub timestamp_ms: i64,
}
