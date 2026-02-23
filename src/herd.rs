use crate::agent::{PriorProcessState, ProcessAssessment, ProcessState};
use crate::config::AppConfig;
use crate::domain::SessionRef;
use crate::tmux::TmuxAdapter;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;

pub trait HerdEngine {
    fn should_nudge(
        &self,
        session: &SessionRef,
        assessment: &ProcessAssessment,
        session_state: Option<&HerdSessionState>,
        now_unix: i64,
    ) -> bool;
    fn nudge_message(&self) -> &str;
}

pub const DEFAULT_HERD_MODE_NAME: &str = "Balanced";

#[derive(Clone, Debug)]
pub struct HerdConfig {
    pub cooldown_secs: i64,
    pub max_nudges: u32,
    pub nudge_message: String,
    pub status_confidence_min_for_trigger: u8,
}

impl Default for HerdConfig {
    fn default() -> Self {
        let defaults = AppConfig::default();
        Self {
            cooldown_secs: defaults.cooldown_secs,
            max_nudges: defaults.max_nudges,
            nudge_message: defaults.nudge_message.clone(),
            status_confidence_min_for_trigger: defaults.status_confidence_min_for_trigger(),
        }
    }
}

impl From<&AppConfig> for HerdConfig {
    fn from(config: &AppConfig) -> Self {
        Self {
            cooldown_secs: config.cooldown_secs,
            max_nudges: config.max_nudges,
            nudge_message: config.nudge_message.clone(),
            status_confidence_min_for_trigger: config.status_confidence_min_for_trigger(),
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct HerdSessionState {
    pub herded: bool,
    #[serde(default)]
    pub herd_id: Option<u8>,
    pub nudge_count: u32,
    pub last_nudge_unix: Option<i64>,
    #[serde(default)]
    pub last_assessment_state: Option<ProcessState>,
    #[serde(default)]
    pub state_entered_unix: Option<i64>,
    #[serde(default)]
    pub last_assessment_unix: Option<i64>,
    #[serde(default)]
    pub last_reasons: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct HerdRegistry {
    #[serde(default)]
    herds: HashMap<u8, String>,
    sessions: HashMap<String, HerdSessionState>,
}

impl HerdRegistry {
    pub fn toggle_herded(&mut self, pane_id: &str) -> bool {
        let state = self.sessions.entry(pane_id.to_string()).or_default();
        state.herded = !state.herded;
        if !state.herded {
            state.herd_id = None;
        }
        state.herded
    }

    pub fn set_herded(&mut self, pane_id: &str, herded: bool) {
        let state = self.sessions.entry(pane_id.to_string()).or_default();
        state.herded = herded;
        if !herded {
            state.herd_id = None;
        }
    }

    pub fn set_herd_group(&mut self, pane_id: &str, herd_id: Option<u8>) {
        let state = self.sessions.entry(pane_id.to_string()).or_default();
        state.herd_id = herd_id;
        state.herded = herd_id.is_some();
    }

    pub fn is_herded(&self, pane_id: &str) -> bool {
        self.sessions
            .get(pane_id)
            .map(|state| state.herded)
            .unwrap_or(false)
    }

    pub fn herd_group(&self, pane_id: &str) -> Option<u8> {
        self.sessions.get(pane_id).and_then(|state| state.herd_id)
    }

    pub fn record_nudge(&mut self, pane_id: &str, now_unix: i64) {
        let state = self.sessions.entry(pane_id.to_string()).or_default();
        state.nudge_count += 1;
        state.last_nudge_unix = Some(now_unix);
    }

    pub fn record_assessment(&mut self, pane_id: &str, assessment: &ProcessAssessment) {
        let state = self.sessions.entry(pane_id.to_string()).or_default();
        state.last_assessment_state = Some(assessment.state);
        state.state_entered_unix = Some(assessment.state_entered_unix);
        state.last_assessment_unix = Some(assessment.captured_at_unix);
        state.last_reasons = assessment.reason_labels();
    }

    pub fn prior_process_state(&self, pane_id: &str) -> PriorProcessState {
        match self.sessions.get(pane_id) {
            Some(state) => PriorProcessState {
                state: state.last_assessment_state,
                state_entered_unix: state.state_entered_unix,
            },
            None => PriorProcessState::default(),
        }
    }

    pub fn session_state(&self, pane_id: &str) -> Option<&HerdSessionState> {
        self.sessions.get(pane_id)
    }

    pub fn session_state_mut(&mut self, pane_id: &str) -> Option<&mut HerdSessionState> {
        self.sessions.get_mut(pane_id)
    }

    pub fn sessions(&self) -> impl Iterator<Item = (&String, &HerdSessionState)> {
        self.sessions.iter()
    }

    pub fn herd_mode(&self, herd_id: u8) -> String {
        self.herds
            .get(&herd_id)
            .map(|mode| normalize_mode_name(mode))
            .filter(|mode| !mode.is_empty())
            .unwrap_or_else(|| DEFAULT_HERD_MODE_NAME.to_string())
    }

    pub fn set_herd_mode(&mut self, herd_id: u8, mode: impl Into<String>) {
        self.herds
            .insert(herd_id, normalize_mode_name(&mode.into()));
    }

    pub fn save_to_path(&self, path: &Path) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|err| format!("failed to create state directory {:?}: {err}", parent))?;
        }
        let serialized = serde_json::to_string_pretty(self)
            .map_err(|err| format!("failed to serialize herd registry: {err}"))?;
        fs::write(path, serialized)
            .map_err(|err| format!("failed to write state file {:?}: {err}", path))?;
        Ok(())
    }

    pub fn load_from_path(path: &Path) -> Result<Self, String> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let raw = fs::read_to_string(path)
            .map_err(|err| format!("failed to read state file {:?}: {err}", path))?;
        serde_json::from_str(&raw)
            .map_err(|err| format!("failed to parse state file {:?}: {err}", path))
    }
}

fn normalize_mode_name(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        DEFAULT_HERD_MODE_NAME.to_string()
    } else {
        trimmed.to_string()
    }
}

#[derive(Clone, Debug)]
pub struct HerdRuleEngine {
    config: HerdConfig,
}

impl HerdRuleEngine {
    pub fn new(config: HerdConfig) -> Self {
        Self { config }
    }
}

impl HerdEngine for HerdRuleEngine {
    fn should_nudge(
        &self,
        _session: &SessionRef,
        assessment: &ProcessAssessment,
        session_state: Option<&HerdSessionState>,
        now_unix: i64,
    ) -> bool {
        if !assessment.eligible_for_herd {
            return false;
        }
        if assessment.confidence < self.config.status_confidence_min_for_trigger {
            return false;
        }

        let Some(state) = session_state else {
            return false;
        };
        if !state.herded {
            return false;
        }
        if state.nudge_count >= self.config.max_nudges {
            return false;
        }
        if let Some(last_nudge) = state.last_nudge_unix
            && now_unix - last_nudge < self.config.cooldown_secs
        {
            return false;
        }
        true
    }

    fn nudge_message(&self) -> &str {
        &self.config.nudge_message
    }
}

pub fn monitor_cycle_for_session<A: TmuxAdapter, E: HerdEngine>(
    adapter: &mut A,
    engine: &E,
    registry: &mut HerdRegistry,
    session: &SessionRef,
    assessment: &ProcessAssessment,
    now_unix: i64,
) -> Result<bool, String> {
    registry.record_assessment(&session.pane_id, assessment);
    if !engine.should_nudge(
        session,
        assessment,
        registry.session_state(&session.pane_id),
        now_unix,
    ) {
        return Ok(false);
    }
    adapter.send_keys(&session.pane_id, engine.nudge_message())?;
    registry.record_nudge(&session.pane_id, now_unix);
    Ok(true)
}
