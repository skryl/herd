use super::herd_modes::{sanitize_herd_modes, sanitize_text_list};
use super::{ANTHROPIC_PROVIDER, AppConfig, MAX_HERDS, PartialAppConfig, normalize_provider};

impl AppConfig {
    pub(super) fn merged(mut self, partial: PartialAppConfig) -> Self {
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
}
