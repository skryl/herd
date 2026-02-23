use crate::rules::load_rule_file;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

mod herd_modes;
mod paths;

pub use self::herd_modes::{default_herd_mode_rule_file, default_primary_herd_mode};
pub use self::paths::{default_config_path, default_state_path};

use self::herd_modes::{
    default_herd_modes, sanitize_herd_modes, sanitize_text_list, uses_legacy_markdown_rule_file,
};

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

impl AppConfig {
    pub fn load_from_path(path: &Path) -> Result<Self, String> {
        if !path.exists() {
            let defaults = Self::default();
            defaults.save_to_path(path)?;
            return Ok(defaults);
        }
        let raw = fs::read_to_string(path)
            .map_err(|err| format!("failed reading config {:?}: {err}", path))?;
        let partial: PartialAppConfig = serde_json::from_str(&raw)
            .map_err(|err| format!("failed parsing config {:?}: {err}", path))?;
        let mut config = Self::default().merged(partial);
        let migrated_from_markdown = config
            .herd_modes
            .iter()
            .any(|mode| uses_legacy_markdown_rule_file(&mode.rule_file));
        if migrated_from_markdown {
            config.herd_modes = default_herd_modes();
        }
        config.save_to_path(path)?;
        Ok(config)
    }

    pub fn save_to_path(&self, path: &Path) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|err| format!("failed creating config directory {:?}: {err}", parent))?;
        }
        let raw = serde_json::to_string_pretty(self)
            .map_err(|err| format!("failed serializing config: {err}"))?;
        fs::write(path, raw).map_err(|err| format!("failed writing config {:?}: {err}", path))?;
        self.ensure_herd_mode_files(path)?;
        self.normalize_herd_mode_rule_files(path)?;
        Ok(())
    }

    fn merged(mut self, partial: PartialAppConfig) -> Self {
        if let Some(value) = partial.refresh_interval_ms {
            self.refresh_interval_ms = value;
        }
        if let Some(value) = partial.capture_lines {
            self.capture_lines = value;
        }
        if let Some(value) = partial.stall_threshold_secs {
            self.stall_threshold_secs = value;
        }
        if let Some(value) = partial.cooldown_secs {
            self.cooldown_secs = value;
        }
        if let Some(value) = partial.max_nudges {
            self.max_nudges = value;
        }
        if let Some(value) = partial.nudge_message {
            self.nudge_message = value;
        }
        if let Some(value) = partial.finished_markers {
            self.finished_markers = value;
        }
        if let Some(value) = partial.waiting_markers {
            self.waiting_markers = value;
        }
        if let Some(value) = partial.marker_lookback_lines {
            self.marker_lookback_lines = value.max(1);
        }
        if let Some(value) = partial.status_track_exact_commands {
            self.status_track_exact_commands = sanitize_text_list(value);
        }
        if let Some(value) = partial.agent_process_markers {
            self.agent_process_markers = sanitize_text_list(value);
        }
        if let Some(value) = partial.status_waiting_grace_secs {
            self.status_waiting_grace_secs = value.max(0);
        }
        if let Some(value) = partial.status_transition_stability_secs {
            self.status_transition_stability_secs = value.max(0);
        }
        if let Some(value) = partial.status_confidence_min_for_trigger {
            self.status_confidence_min_for_trigger = value.min(100);
        }
        if let Some(value) = partial.live_capture_line_multiplier {
            self.live_capture_line_multiplier = value.max(1);
        }
        if let Some(value) = partial.live_capture_min_lines {
            self.live_capture_min_lines = value.max(1);
        }
        if let Some(value) = partial.herd_count {
            self.herd_count = value.clamp(1, MAX_HERDS);
        }
        if let Some(value) = partial.openai_api_key {
            self.openai_api_key = value;
        }
        if let Some(value) = partial.anthropic_api_key {
            self.anthropic_api_key = value;
        }
        if let Some(value) = partial.llm_provider {
            self.llm_provider = normalize_provider(&value).to_string();
        }
        if let Some(value) = partial.llm_model {
            self.llm_model = value;
        }
        if let Some(value) = partial.herd_modes {
            self.herd_modes = sanitize_herd_modes(value);
        }
        self.marker_lookback_lines = self.marker_lookback_lines.max(1);
        self.status_waiting_grace_secs = self.status_waiting_grace_secs.max(0);
        self.status_transition_stability_secs = self.status_transition_stability_secs.max(0);
        self.status_confidence_min_for_trigger = self.status_confidence_min_for_trigger.min(100);
        self.live_capture_line_multiplier = self.live_capture_line_multiplier.max(1);
        self.live_capture_min_lines = self.live_capture_min_lines.max(1);
        self.herd_count = self.herd_count.clamp(1, MAX_HERDS);
        self.llm_provider = normalize_provider(&self.llm_provider).to_string();
        self
    }

    pub fn normalized_herd_count(&self) -> u8 {
        self.herd_count.clamp(1, MAX_HERDS)
    }

    pub fn normalized_provider(&self) -> &str {
        normalize_provider(&self.llm_provider)
    }

    pub fn provider_api_key(&self, provider: &str) -> Option<&str> {
        let key = match normalize_provider(provider) {
            ANTHROPIC_PROVIDER => self.anthropic_api_key.trim(),
            _ => self.openai_api_key.trim(),
        };
        (!key.is_empty()).then_some(key)
    }

    pub fn marker_lookback_lines(&self) -> usize {
        self.marker_lookback_lines.max(1)
    }

    pub fn status_waiting_grace_secs(&self) -> i64 {
        self.status_waiting_grace_secs.max(0)
    }

    pub fn status_transition_stability_secs(&self) -> i64 {
        self.status_transition_stability_secs.max(0)
    }

    pub fn status_confidence_min_for_trigger(&self) -> u8 {
        self.status_confidence_min_for_trigger.min(100)
    }

    pub fn live_capture_line_limit(&self) -> usize {
        let multiplier = self.live_capture_line_multiplier.max(1);
        let min_lines = self.live_capture_min_lines.max(1);
        self.capture_lines.saturating_mul(multiplier).max(min_lines)
    }

    fn ensure_herd_mode_files(&self, settings_path: &Path) -> Result<(), String> {
        let root = settings_path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        for mode in &self.herd_modes {
            let prompt_path = root.join(&mode.rule_file);
            if let Some(parent) = prompt_path.parent() {
                fs::create_dir_all(parent).map_err(|err| {
                    format!("failed creating herd mode directory {:?}: {err}", parent)
                })?;
            }
            if !prompt_path.exists() {
                fs::write(&prompt_path, default_herd_mode_rule_file(&mode.name)).map_err(
                    |err| format!("failed writing herd mode prompt {:?}: {err}", prompt_path),
                )?;
            }
        }
        Ok(())
    }

    fn normalize_herd_mode_rule_files(&self, settings_path: &Path) -> Result<(), String> {
        let root = settings_path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        for mode in &self.herd_modes {
            let rule_path = root.join(&mode.rule_file);
            if !rule_path.exists() {
                continue;
            }
            let parsed = load_rule_file(&rule_path)?;
            let normalized = serde_json::to_string_pretty(&parsed)
                .map_err(|err| format!("failed serializing rule file {:?}: {err}", rule_path))?;
            fs::write(&rule_path, normalized)
                .map_err(|err| format!("failed normalizing rule file {:?}: {err}", rule_path))?;
        }
        Ok(())
    }
}

pub fn normalize_provider(provider: &str) -> &'static str {
    if provider.eq_ignore_ascii_case(ANTHROPIC_PROVIDER) {
        ANTHROPIC_PROVIDER
    } else {
        DEFAULT_PROVIDER
    }
}
