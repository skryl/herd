use crate::config::AppConfig;
use crate::domain::PaneSnapshot;
use serde::{Deserialize, Serialize};

mod classifier;
mod command_helpers;

pub use self::command_helpers::{
    agent_name_for_command, display_command, should_highlight_command,
    should_track_status_for_command,
};

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum AgentStatus {
    Running,
    Waiting,
    Finished,
    Stalled,
    Unknown,
}

impl AgentStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            AgentStatus::Running => "running",
            AgentStatus::Waiting => "waiting",
            AgentStatus::Finished => "finished",
            AgentStatus::Stalled => "stalled",
            AgentStatus::Unknown => "unknown",
        }
    }
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProcessState {
    Unknown,
    Running,
    Waiting,
    WaitingLong,
    Stalled,
    Finished,
}

impl ProcessState {
    pub fn as_str(self) -> &'static str {
        match self {
            ProcessState::Unknown => "unknown",
            ProcessState::Running => "running",
            ProcessState::Waiting => "waiting",
            ProcessState::WaitingLong => "waiting_long",
            ProcessState::Stalled => "stalled",
            ProcessState::Finished => "finished",
        }
    }

    pub fn display_status(self) -> AgentStatus {
        match self {
            ProcessState::Unknown => AgentStatus::Unknown,
            ProcessState::Running => AgentStatus::Running,
            ProcessState::Waiting | ProcessState::WaitingLong => AgentStatus::Waiting,
            ProcessState::Stalled => AgentStatus::Stalled,
            ProcessState::Finished => AgentStatus::Finished,
        }
    }
}

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum StatusReasonCode {
    NoContent,
    FinishedMarker,
    WaitingMarker,
    QuestionTail,
    InactivityExceeded,
    ActivityRecent,
    WaitingGraceExceeded,
    TransitionStabilityHold,
    CodexTurnInProgress,
    CodexTurnCompleted,
    CodexTurnInterrupted,
    CodexTurnFailed,
    CodexNoTurnData,
}

impl StatusReasonCode {
    pub fn as_str(self) -> &'static str {
        match self {
            StatusReasonCode::NoContent => "no_content",
            StatusReasonCode::FinishedMarker => "finished_marker",
            StatusReasonCode::WaitingMarker => "waiting_marker",
            StatusReasonCode::QuestionTail => "question_tail",
            StatusReasonCode::InactivityExceeded => "inactivity_exceeded",
            StatusReasonCode::ActivityRecent => "activity_recent",
            StatusReasonCode::WaitingGraceExceeded => "waiting_grace_exceeded",
            StatusReasonCode::TransitionStabilityHold => "transition_stability_hold",
            StatusReasonCode::CodexTurnInProgress => "codex_turn_in_progress",
            StatusReasonCode::CodexTurnCompleted => "codex_turn_completed",
            StatusReasonCode::CodexTurnInterrupted => "codex_turn_interrupted",
            StatusReasonCode::CodexTurnFailed => "codex_turn_failed",
            StatusReasonCode::CodexNoTurnData => "codex_no_turn_data",
        }
    }
}

#[derive(Copy, Clone, Debug, Default, Eq, PartialEq)]
pub struct PriorProcessState {
    pub state: Option<ProcessState>,
    pub state_entered_unix: Option<i64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProcessAssessment {
    pub display_status: AgentStatus,
    pub state: ProcessState,
    pub reasons: Vec<StatusReasonCode>,
    pub confidence: u8,
    pub captured_at_unix: i64,
    pub last_activity_unix: i64,
    pub inactive_secs: i64,
    pub waiting_secs: i64,
    pub state_entered_unix: i64,
    pub eligible_for_herd: bool,
}

impl Default for ProcessAssessment {
    fn default() -> Self {
        Self::from_display_status(AgentStatus::Unknown)
    }
}

impl ProcessAssessment {
    pub fn from_display_status(status: AgentStatus) -> Self {
        let state = match status {
            AgentStatus::Running => ProcessState::Running,
            AgentStatus::Waiting => ProcessState::Waiting,
            AgentStatus::Finished => ProcessState::Finished,
            AgentStatus::Stalled => ProcessState::Stalled,
            AgentStatus::Unknown => ProcessState::Unknown,
        };
        Self {
            display_status: status,
            state,
            reasons: Vec::new(),
            confidence: 0,
            captured_at_unix: 0,
            last_activity_unix: 0,
            inactive_secs: 0,
            waiting_secs: 0,
            state_entered_unix: 0,
            eligible_for_herd: matches!(state, ProcessState::Stalled),
        }
    }

    pub fn reason_labels(&self) -> Vec<String> {
        self.reasons
            .iter()
            .map(|reason| reason.as_str().to_string())
            .collect()
    }
}

pub trait SessionClassifier {
    fn assess(&self, snapshot: &PaneSnapshot, prior: PriorProcessState) -> ProcessAssessment;
}

#[derive(Clone, Debug)]
pub struct ClassifierConfig {
    pub stall_threshold_secs: i64,
    pub finished_markers: Vec<String>,
    pub waiting_markers: Vec<String>,
    pub marker_lookback_lines: usize,
    pub waiting_grace_secs: i64,
    pub transition_stability_secs: i64,
}

impl From<&AppConfig> for ClassifierConfig {
    fn from(config: &AppConfig) -> Self {
        Self {
            stall_threshold_secs: config.stall_threshold_secs,
            finished_markers: config.finished_markers.clone(),
            waiting_markers: config.waiting_markers.clone(),
            marker_lookback_lines: config.marker_lookback_lines(),
            waiting_grace_secs: config.status_waiting_grace_secs(),
            transition_stability_secs: config.status_transition_stability_secs(),
        }
    }
}

impl Default for ClassifierConfig {
    fn default() -> Self {
        Self::from(&AppConfig::default())
    }
}

pub struct HeuristicSessionClassifier {
    config: ClassifierConfig,
}

impl HeuristicSessionClassifier {
    pub fn new(config: ClassifierConfig) -> Self {
        Self { config }
    }
}
