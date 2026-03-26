use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::network::NetworkConnection;
use crate::tile_message::TileMessageLogEntry;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum AgentType {
    #[default]
    Claude,
    Fixture,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum AgentRole {
    Root,
    #[default]
    Worker,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentInfo {
    pub agent_id: String,
    #[serde(default)]
    pub agent_type: AgentType,
    #[serde(default)]
    pub agent_role: AgentRole,
    pub tile_id: String,
    #[serde(default, skip_serializing)]
    pub pane_id: String,
    pub window_id: String,
    pub session_id: String,
    pub title: String,
    pub display_name: String,
    pub alive: bool,
    pub chatter_subscribed: bool,
    pub channels: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_pid: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChannelInfo {
    pub session_id: String,
    pub name: String,
    pub subscriber_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_activity_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ChatterKind {
    Direct,
    Public,
    Channel,
    Network,
    Root,
    SignOn,
    SignOff,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentLogKind {
    IncomingHook,
    OutgoingCall,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentLogEntry {
    #[serde(default)]
    pub session_id: String,
    pub agent_id: String,
    pub tile_id: String,
    pub kind: AgentLogKind,
    pub text: String,
    pub timestamp_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChatterEntry {
    #[serde(default)]
    pub session_id: String,
    pub kind: ChatterKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_agent_id: Option<String>,
    pub from_display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_display_name: Option<String>,
    pub message: String,
    #[serde(default)]
    pub channels: Vec<String>,
    #[serde(default)]
    pub mentions: Vec<String>,
    pub timestamp_ms: i64,
    pub public: bool,
    pub display_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentChannelEventKind {
    Direct,
    Public,
    Channel,
    Network,
    Root,
    System,
    Ping,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentChannelEvent {
    pub kind: AgentChannelEventKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_agent_id: Option<String>,
    pub from_display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_display_name: Option<String>,
    pub message: String,
    #[serde(default)]
    pub channels: Vec<String>,
    #[serde(default)]
    pub mentions: Vec<String>,
    #[serde(default)]
    pub replay: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ping_id: Option<String>,
    pub timestamp_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentStreamEnvelope {
    Event { event: AgentChannelEvent },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentDebugState {
    pub agents: Vec<AgentInfo>,
    pub channels: Vec<ChannelInfo>,
    pub chatter: Vec<ChatterEntry>,
    #[serde(default)]
    pub agent_logs: Vec<AgentLogEntry>,
    #[serde(default)]
    pub tile_message_logs: Vec<TileMessageLogEntry>,
    #[serde(default)]
    pub connections: Vec<NetworkConnection>,
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn normalize_channel(channel_name: &str) -> Option<String> {
    let trimmed = channel_name.trim();
    if trimmed.is_empty() {
        return None;
    }
    let raw = trimmed.strip_prefix('#').unwrap_or(trimmed).to_ascii_lowercase();
    if raw.is_empty() {
        return None;
    }
    let normalized: String = raw
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
        .collect();
    if normalized.is_empty() {
        None
    } else {
        Some(format!("#{normalized}"))
    }
}

pub fn normalize_mention(agent_id: &str) -> Option<String> {
    let trimmed = agent_id.trim();
    if trimmed.is_empty() {
        return None;
    }
    let raw = trimmed.strip_prefix('@').unwrap_or(trimmed);
    let normalized: String = raw
        .to_ascii_lowercase()
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
        .collect();
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

pub fn collect_channels(message: &str, explicit_channels: &[String]) -> Vec<String> {
    let mut channels = BTreeSet::new();
    for channel_name in explicit_channels {
        if let Some(normalized) = normalize_channel(channel_name) {
            channels.insert(normalized);
        }
    }
    for token in message.split_whitespace() {
        let trimmed = token.trim_matches(|ch: char| matches!(ch, ',' | '.' | ':' | ';' | '!' | '?' | ')' | '(' | '[' | ']' | '{' | '}' | '"' | '\''));
        if let Some(rest) = trimmed.strip_prefix('#') {
            if let Some(normalized) = normalize_channel(rest) {
                channels.insert(normalized);
            }
        }
    }
    channels.into_iter().collect()
}

pub fn collect_mentions(message: &str, explicit_mentions: &[String]) -> Vec<String> {
    let mut mentions = BTreeSet::new();
    for mention in explicit_mentions {
        if let Some(normalized) = normalize_mention(mention) {
            mentions.insert(normalized);
        }
    }
    for token in message.split_whitespace() {
        let trimmed = token.trim_matches(|ch: char| matches!(ch, ',' | '.' | ':' | ';' | '!' | '?' | ')' | '(' | '[' | ']' | '{' | '}' | '"' | '\''));
        if let Some(rest) = trimmed.strip_prefix('@') {
            if let Some(normalized) = normalize_mention(rest) {
                mentions.insert(normalized);
            }
        }
    }
    mentions.into_iter().collect()
}

pub fn format_direct_display(from: &str, to: &str, message: &str) -> String {
    format!("{from} -> {to}: {message}")
}

pub fn format_public_display(from: &str, message: &str) -> String {
    format!("{from} -> Chatter: {message}")
}

pub fn format_channel_display(from: &str, channel_name: &str, message: &str) -> String {
    format!("{from} -> {channel_name}: {message}")
}

pub fn format_network_display(from: &str, message: &str) -> String {
    format!("{from} -> Network: {message}")
}

pub fn format_root_display(from: &str, message: &str) -> String {
    format!("{from} -> Root: {message}")
}

pub fn format_sign_on_display(display_name: &str) -> String {
    format!("{display_name}: Signed On")
}

pub fn format_sign_off_display(display_name: &str) -> String {
    format!("{display_name}: Signed Off")
}

#[cfg(test)]
mod tests {
    use super::{
        collect_channels, collect_mentions, format_channel_display, format_direct_display,
        format_network_display, format_public_display, format_root_display,
        format_sign_off_display, format_sign_on_display, normalize_channel,
    };

    #[test]
    fn normalizes_channels_and_mentions() {
        assert_eq!(normalize_channel("#PrD-1"), Some("#prd-1".to_string()));
        assert_eq!(
            collect_channels("working on #PRD-7 and #Agents", &["#Other".into()]),
            vec!["#agents".to_string(), "#other".to_string(), "#prd-7".to_string()]
        );
        assert_eq!(
            collect_mentions("ping @agent-1 and @Agent_2", &["agent-3".into()]),
            vec![
                "agent-1".to_string(),
                "agent-3".to_string(),
                "agent_2".to_string()
            ]
        );
    }

    #[test]
    fn formats_debug_display_lines() {
        assert_eq!(format_direct_display("Agent 1", "Agent 2", "hello"), "Agent 1 -> Agent 2: hello");
        assert_eq!(format_public_display("Agent 1", "sync on #prd-1"), "Agent 1 -> Chatter: sync on #prd-1");
        assert_eq!(format_channel_display("Agent 1", "#prd-1", "sync"), "Agent 1 -> #prd-1: sync");
        assert_eq!(format_network_display("Agent 1", "sync on #prd-1"), "Agent 1 -> Network: sync on #prd-1");
        assert_eq!(format_root_display("Agent 1", "please inspect"), "Agent 1 -> Root: please inspect");
        assert_eq!(format_sign_on_display("Agent 1"), "Agent 1: Signed On");
        assert_eq!(format_sign_off_display("Agent 1"), "Agent 1: Signed Off");
    }
}
