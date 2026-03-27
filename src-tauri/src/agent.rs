use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::network::{NetworkConnection, TilePortSetting};
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
pub struct AgentDisplayFrame {
    pub agent_id: String,
    pub tile_id: String,
    pub session_id: String,
    pub text: String,
    pub columns: usize,
    pub rows: usize,
    pub updated_at: i64,
}

pub const TILE_SIGNAL_LED_COUNT: usize = 8;
const DEFAULT_LED_PATTERN_DELAY_MS: u64 = 120;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TileSignalLed {
    pub index: usize,
    pub on: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TileSignalState {
    pub tile_id: String,
    pub session_id: String,
    pub leds: Vec<TileSignalLed>,
    pub status_text: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct LedPatternArgs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub primary_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secondary_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delay_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum LedControlCommand {
    On { led: usize, color: String },
    Off { led: usize },
    Sleep { ms: u64 },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChannelInfo {
    pub session_id: String,
    pub name: String,
    pub subscriber_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_activity_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum TileSubscriptionScope {
    Tile,
    Network,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum TileSubscriptionDirection {
    In,
    Out,
    Both,
}

impl TileSubscriptionDirection {
    pub fn matches_incoming(self) -> bool {
        matches!(self, Self::In | Self::Both)
    }

    pub fn matches_outgoing(self) -> bool {
        matches!(self, Self::Out | Self::Both)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TileSubscriptionRecord {
    pub session_id: String,
    pub scope: TileSubscriptionScope,
    pub subscriber_tile_id: String,
    pub subject_tile_id: String,
    pub direction: TileSubscriptionDirection,
    pub action: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TileEventDeliveryReason {
    Subscription,
    ImplicitSelfTarget,
}

pub fn parse_tile_subscription_selector(
    selector: &str,
) -> Result<(TileSubscriptionDirection, String), String> {
    let trimmed = selector.trim();
    let Some((raw_direction, raw_action)) = trimmed.split_once(':') else {
        return Err("tile subscription event selectors must use direction:action syntax".to_string());
    };
    let direction = match raw_direction.trim() {
        "in" => TileSubscriptionDirection::In,
        "out" => TileSubscriptionDirection::Out,
        "both" | "*" => TileSubscriptionDirection::Both,
        other => {
            return Err(format!(
                "unsupported tile subscription direction {other}; use in, out, both, or *"
            ))
        }
    };
    let action = raw_action.trim();
    if action.is_empty() {
        return Err("tile subscription event selectors require a non-empty action name".to_string());
    }
    Ok((direction, action.to_string()))
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
    TileEvent,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery_reason: Option<TileEventDeliveryReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subscription_scope: Option<TileSubscriptionScope>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subscription_direction: Option<TileSubscriptionDirection>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject_tile_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peer_tile_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub caller_tile_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub caller_agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_tile_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rpc_channel: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args_json: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_json: Option<serde_json::Value>,
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
    #[serde(default)]
    pub agent_displays: Vec<AgentDisplayFrame>,
    #[serde(default)]
    pub tile_signals: Vec<TileSignalState>,
    #[serde(default)]
    pub port_settings: Vec<TilePortSetting>,
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn default_tile_signal_leds() -> Vec<TileSignalLed> {
    (1..=TILE_SIGNAL_LED_COUNT)
        .map(|index| TileSignalLed {
            index,
            on: false,
            color: None,
        })
        .collect()
}

pub fn normalize_status_text(text: &str) -> String {
    text.chars()
        .map(|ch| match ch {
            '\n' | '\r' | '\t' => ' ',
            _ => ch,
        })
        .collect()
}

fn normalized_delay_ms(value: Option<u64>) -> Result<u64, String> {
    let delay = value.unwrap_or(DEFAULT_LED_PATTERN_DELAY_MS);
    if delay == 0 {
        return Err("self_led_control delay must be greater than zero".to_string());
    }
    if delay > 60_000 {
        return Err("self_led_control delay must be 60 seconds or less".to_string());
    }
    Ok(delay)
}

fn normalize_color(color: &str) -> Result<String, String> {
    let normalized = color.trim();
    if normalized.is_empty() {
        return Err("self_led_control color values must be non-empty".to_string());
    }
    Ok(normalized.to_string())
}

pub fn normalize_led_control_commands(commands: Vec<LedControlCommand>) -> Result<Vec<LedControlCommand>, String> {
    if commands.is_empty() {
        return Err("self_led_control requires at least one command".to_string());
    }
    let mut saw_sleep = false;
    let mut normalized = Vec::with_capacity(commands.len());
    for command in commands {
        match command {
            LedControlCommand::On { led, color } => {
                if !(1..=TILE_SIGNAL_LED_COUNT).contains(&led) {
                    return Err(format!("self_led_control led index must be between 1 and {TILE_SIGNAL_LED_COUNT}"));
                }
                normalized.push(LedControlCommand::On {
                    led,
                    color: normalize_color(&color)?,
                });
            }
            LedControlCommand::Off { led } => {
                if !(1..=TILE_SIGNAL_LED_COUNT).contains(&led) {
                    return Err(format!("self_led_control led index must be between 1 and {TILE_SIGNAL_LED_COUNT}"));
                }
                normalized.push(LedControlCommand::Off { led });
            }
            LedControlCommand::Sleep { ms } => {
                if ms == 0 {
                    return Err("self_led_control sleep must be greater than zero".to_string());
                }
                if ms > 60_000 {
                    return Err("self_led_control sleep must be 60 seconds or less".to_string());
                }
                saw_sleep = true;
                normalized.push(LedControlCommand::Sleep { ms });
            }
        }
    }
    if !saw_sleep {
        return Err("self_led_control requires at least one sleep command".to_string());
    }
    Ok(normalized)
}

pub fn expand_led_pattern(pattern_name: &str, pattern_args: Option<&LedPatternArgs>) -> Result<Vec<LedControlCommand>, String> {
    let normalized_name = pattern_name.trim().to_ascii_lowercase();
    if normalized_name.is_empty() {
        return Err("self_led_control pattern_name must be non-empty".to_string());
    }

    let args = pattern_args.cloned().unwrap_or_default();
    let delay = normalized_delay_ms(args.delay_ms)?;
    let primary = normalize_color(args.primary_color.as_deref().unwrap_or("#33ff33"))?;
    let secondary = normalize_color(args.secondary_color.as_deref().unwrap_or("#ffaa00"))?;
    let rainbow = [
        "#ff595e",
        "#ff924c",
        "#ffca3a",
        "#8ac926",
        "#52a675",
        "#1982c4",
        "#4267ac",
        "#6a4c93",
    ];

    let off_all = || {
        (1..=TILE_SIGNAL_LED_COUNT)
            .map(|led| LedControlCommand::Off { led })
            .collect::<Vec<_>>()
    };
    let on_all = |color: &str| {
        (1..=TILE_SIGNAL_LED_COUNT)
            .map(|led| LedControlCommand::On {
                led,
                color: color.to_string(),
            })
            .collect::<Vec<_>>()
    };
    let frame_for_leds = |assignments: &[(usize, String)]| {
        let mut frame = off_all();
        for (led, color) in assignments {
            frame.push(LedControlCommand::On {
                led: *led,
                color: color.clone(),
            });
        }
        frame.push(LedControlCommand::Sleep { ms: delay });
        frame
    };

    let commands = match normalized_name.as_str() {
        "off" => {
            let mut commands = off_all();
            commands.push(LedControlCommand::Sleep { ms: delay });
            commands
        }
        "solid" => {
            let mut commands = on_all(&primary);
            commands.push(LedControlCommand::Sleep { ms: delay });
            commands
        }
        "blink" => {
            let mut commands = on_all(&primary);
            commands.push(LedControlCommand::Sleep { ms: delay });
            commands.extend(off_all());
            commands.push(LedControlCommand::Sleep { ms: delay });
            commands
        }
        "scan" => {
            let mut commands = Vec::new();
            for led in 1..=TILE_SIGNAL_LED_COUNT {
                commands.extend(frame_for_leds(&[(led, primary.clone())]));
            }
            commands
        }
        "alternate" => {
            let odd_frame = (1..=TILE_SIGNAL_LED_COUNT)
                .filter(|led| led % 2 == 1)
                .map(|led| (led, primary.clone()))
                .chain(
                    (1..=TILE_SIGNAL_LED_COUNT)
                        .filter(|led| led % 2 == 0)
                        .map(|led| (led, secondary.clone())),
                )
                .collect::<Vec<_>>();
            let even_frame = (1..=TILE_SIGNAL_LED_COUNT)
                .filter(|led| led % 2 == 1)
                .map(|led| (led, secondary.clone()))
                .chain(
                    (1..=TILE_SIGNAL_LED_COUNT)
                        .filter(|led| led % 2 == 0)
                        .map(|led| (led, primary.clone())),
                )
                .collect::<Vec<_>>();
            let mut commands = frame_for_leds(&odd_frame);
            commands.extend(frame_for_leds(&even_frame));
            commands
        }
        "rainbow" => {
            let mut commands = Vec::new();
            for offset in 0..TILE_SIGNAL_LED_COUNT {
                let frame = (0..TILE_SIGNAL_LED_COUNT)
                    .map(|slot| (slot + 1, rainbow[(slot + offset) % TILE_SIGNAL_LED_COUNT].to_string()))
                    .collect::<Vec<_>>();
                commands.extend(frame_for_leds(&frame));
            }
            commands
        }
        "success" => {
            let mut commands = Vec::new();
            let mut frame = Vec::new();
            for led in 1..=TILE_SIGNAL_LED_COUNT {
                frame.push((led, primary.clone()));
                commands.extend(frame_for_leds(&frame));
            }
            commands.extend(off_all());
            commands.push(LedControlCommand::Sleep { ms: delay });
            commands
        }
        "warning" => {
            let mut commands = on_all(&secondary);
            commands.push(LedControlCommand::Sleep { ms: delay });
            commands.extend(off_all());
            commands.push(LedControlCommand::Sleep { ms: delay });
            commands
        }
        "error" => {
            let mut commands = on_all("#ff5555");
            commands.push(LedControlCommand::Sleep { ms: delay });
            commands.extend(off_all());
            commands.push(LedControlCommand::Sleep { ms: delay });
            commands
        }
        "alert" => {
            let frame_a = vec![
                (1, "#ff5555".to_string()),
                (3, "#ff5555".to_string()),
                (5, "#ff5555".to_string()),
                (7, "#ff5555".to_string()),
                (2, secondary.clone()),
                (4, secondary.clone()),
                (6, secondary.clone()),
                (8, secondary.clone()),
            ];
            let frame_b = vec![
                (1, secondary.clone()),
                (3, secondary.clone()),
                (5, secondary.clone()),
                (7, secondary.clone()),
                (2, "#ff5555".to_string()),
                (4, "#ff5555".to_string()),
                (6, "#ff5555".to_string()),
                (8, "#ff5555".to_string()),
            ];
            let mut commands = frame_for_leds(&frame_a);
            commands.extend(frame_for_leds(&frame_b));
            commands
        }
        _ => return Err(format!("unknown self_led_control pattern: {pattern_name}")),
    };

    normalize_led_control_commands(commands)
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
        parse_tile_subscription_selector, TileSubscriptionDirection,
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

    #[test]
    fn parses_tile_subscription_selectors() {
        assert_eq!(
            parse_tile_subscription_selector("in:exec").unwrap(),
            (TileSubscriptionDirection::In, "exec".to_string())
        );
        assert_eq!(
            parse_tile_subscription_selector("*:extension_call").unwrap(),
            (TileSubscriptionDirection::Both, "extension_call".to_string())
        );
        assert!(parse_tile_subscription_selector("nope").is_err());
        assert!(parse_tile_subscription_selector("in:").is_err());
    }
}
