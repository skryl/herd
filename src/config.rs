use serde::{Deserialize, Serialize};

mod herd_modes;
mod io;
mod merge;
mod paths;

pub use self::herd_modes::{default_herd_mode_rule_file, default_primary_herd_mode};
pub use self::paths::{default_config_path, default_state_path};

use self::herd_modes::{default_herd_modes, uses_legacy_markdown_rule_file};

pub const MAX_HERDS: u8 = 10;
pub const DEFAULT_HERD_COUNT: u8 = 5;
pub const DEFAULT_STATUS_WAITING_GRACE_SECS: i64 = 120;
pub const DEFAULT_STATUS_TRANSITION_STABILITY_SECS: i64 = 5;
pub const DEFAULT_STATUS_CONFIDENCE_MIN_FOR_TRIGGER: u8 = 60;
pub const DEFAULT_PROVIDER: &str = "openai";
pub const ANTHROPIC_PROVIDER: &str = "anthropic";

#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
pub struct HerdModeDefinition {
    pub name: String,
    #[serde(alias = "file")]
    pub rule_file: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AppConfig {
    pub refresh_interval_ms: u64,
    pub capture_lines: usize,
    pub stall_threshold_secs: i64,
    pub cooldown_secs: i64,
    pub max_nudges: u32,
    pub nudge_message: String,
    pub finished_markers: Vec<String>,
    pub waiting_markers: Vec<String>,
    pub marker_lookback_lines: usize,
    pub status_track_exact_commands: Vec<String>,
    pub agent_process_markers: Vec<String>,
    pub status_waiting_grace_secs: i64,
    pub status_transition_stability_secs: i64,
    pub status_confidence_min_for_trigger: u8,
    pub live_capture_line_multiplier: usize,
    pub live_capture_min_lines: usize,
    pub herd_count: u8,
    pub openai_api_key: String,
    pub anthropic_api_key: String,
    pub llm_provider: String,
    pub llm_model: String,
    pub herd_modes: Vec<HerdModeDefinition>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            refresh_interval_ms: 500,
            capture_lines: 300,
            stall_threshold_secs: 120,
            cooldown_secs: 120,
            max_nudges: 3,
            nudge_message: "Please continue until the task is fully complete.".to_string(),
            finished_markers: vec![
                "finished".to_string(),
                "complete".to_string(),
                "done".to_string(),
            ],
            waiting_markers: vec![
                "waiting for input".to_string(),
                "need your input".to_string(),
            ],
            marker_lookback_lines: 8,
            status_track_exact_commands: vec!["tmux".to_string()],
            agent_process_markers: vec!["claude".to_string(), "codex".to_string()],
            status_waiting_grace_secs: DEFAULT_STATUS_WAITING_GRACE_SECS,
            status_transition_stability_secs: DEFAULT_STATUS_TRANSITION_STABILITY_SECS,
            status_confidence_min_for_trigger: DEFAULT_STATUS_CONFIDENCE_MIN_FOR_TRIGGER,
            live_capture_line_multiplier: 8,
            live_capture_min_lines: 400,
            herd_count: DEFAULT_HERD_COUNT,
            openai_api_key: String::new(),
            anthropic_api_key: String::new(),
            llm_provider: DEFAULT_PROVIDER.to_string(),
            llm_model: String::new(),
            herd_modes: default_herd_modes(),
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
struct PartialAppConfig {
    refresh_interval_ms: Option<u64>,
    capture_lines: Option<usize>,
    stall_threshold_secs: Option<i64>,
    cooldown_secs: Option<i64>,
    max_nudges: Option<u32>,
    nudge_message: Option<String>,
    finished_markers: Option<Vec<String>>,
    waiting_markers: Option<Vec<String>>,
    marker_lookback_lines: Option<usize>,
    status_track_exact_commands: Option<Vec<String>>,
    agent_process_markers: Option<Vec<String>>,
    status_waiting_grace_secs: Option<i64>,
    status_transition_stability_secs: Option<i64>,
    status_confidence_min_for_trigger: Option<u8>,
    live_capture_line_multiplier: Option<usize>,
    live_capture_min_lines: Option<usize>,
    herd_count: Option<u8>,
    openai_api_key: Option<String>,
    anthropic_api_key: Option<String>,
    llm_provider: Option<String>,
    llm_model: Option<String>,
    herd_modes: Option<Vec<HerdModeDefinition>>,
}

pub fn normalize_provider(provider: &str) -> &'static str {
    if provider.eq_ignore_ascii_case(ANTHROPIC_PROVIDER) {
        ANTHROPIC_PROVIDER
    } else {
        DEFAULT_PROVIDER
    }
}
