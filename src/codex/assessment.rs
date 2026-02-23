use crate::agent::{PriorProcessState, ProcessAssessment, ProcessState, StatusReasonCode};
use crate::domain::SessionRef;
use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum CodexTurnStatus {
    InProgress,
    Completed,
    Interrupted,
    Failed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexThreadState {
    pub thread_id: String,
    pub thread_updated_unix: i64,
    pub turn_status: Option<CodexTurnStatus>,
}

pub fn collect_codex_cwds_from_sessions(sessions: &[SessionRef]) -> Vec<String> {
    let mut unique = HashSet::new();
    let mut out = Vec::new();
    for session in sessions {
        if !is_codex_command(&session.pane_current_command) {
            continue;
        }
        let cwd = session.pane_current_path.trim();
        if cwd.is_empty() {
            continue;
        }
        if unique.insert(cwd.to_string()) {
            out.push(cwd.to_string());
        }
    }
    out
}

pub fn is_codex_command(command: &str) -> bool {
    command.trim().to_ascii_lowercase().contains("codex")
}

pub fn assessment_from_codex_state(
    state: &CodexThreadState,
    prior: PriorProcessState,
    captured_at_unix: i64,
    waiting_grace_secs: i64,
) -> ProcessAssessment {
    let last_activity_unix = state.thread_updated_unix.max(0);
    let inactive_secs = if last_activity_unix > 0 {
        (captured_at_unix - last_activity_unix).max(0)
    } else {
        0
    };

    match state.turn_status {
        Some(CodexTurnStatus::InProgress) => ProcessAssessment {
            display_status: ProcessState::Running.display_status(),
            state: ProcessState::Running,
            reasons: vec![StatusReasonCode::CodexTurnInProgress],
            confidence: 96,
            captured_at_unix,
            last_activity_unix,
            inactive_secs,
            waiting_secs: 0,
            state_entered_unix: if prior.state == Some(ProcessState::Running) {
                prior.state_entered_unix.unwrap_or(captured_at_unix)
            } else {
                captured_at_unix
            },
            eligible_for_herd: false,
        },
        Some(CodexTurnStatus::Failed) => ProcessAssessment {
            display_status: ProcessState::Stalled.display_status(),
            state: ProcessState::Stalled,
            reasons: vec![StatusReasonCode::CodexTurnFailed],
            confidence: 83,
            captured_at_unix,
            last_activity_unix,
            inactive_secs,
            waiting_secs: 0,
            state_entered_unix: if prior.state == Some(ProcessState::Stalled) {
                prior.state_entered_unix.unwrap_or(captured_at_unix)
            } else {
                captured_at_unix
            },
            eligible_for_herd: true,
        },
        Some(CodexTurnStatus::Completed) => waiting_assessment(
            StatusReasonCode::CodexTurnCompleted,
            92,
            prior,
            captured_at_unix,
            last_activity_unix,
            inactive_secs,
            waiting_grace_secs,
        ),
        Some(CodexTurnStatus::Interrupted) => waiting_assessment(
            StatusReasonCode::CodexTurnInterrupted,
            85,
            prior,
            captured_at_unix,
            last_activity_unix,
            inactive_secs,
            waiting_grace_secs,
        ),
        None => waiting_assessment(
            StatusReasonCode::CodexNoTurnData,
            70,
            prior,
            captured_at_unix,
            last_activity_unix,
            inactive_secs,
            waiting_grace_secs,
        ),
    }
}

fn waiting_assessment(
    reason: StatusReasonCode,
    confidence: u8,
    prior: PriorProcessState,
    captured_at_unix: i64,
    last_activity_unix: i64,
    inactive_secs: i64,
    waiting_grace_secs: i64,
) -> ProcessAssessment {
    let mut reasons = vec![reason];
    let mut state_entered_unix = if matches!(
        prior.state,
        Some(ProcessState::Waiting | ProcessState::WaitingLong)
    ) {
        prior.state_entered_unix.unwrap_or(captured_at_unix)
    } else {
        captured_at_unix
    };
    if state_entered_unix <= 0 {
        state_entered_unix = captured_at_unix;
    }

    let waiting_secs = (captured_at_unix - state_entered_unix).max(0);
    let mut state = if matches!(prior.state, Some(ProcessState::WaitingLong)) {
        ProcessState::WaitingLong
    } else {
        ProcessState::Waiting
    };

    if state == ProcessState::Waiting && waiting_secs >= waiting_grace_secs.max(0) {
        state = ProcessState::WaitingLong;
        reasons.push(StatusReasonCode::WaitingGraceExceeded);
    }

    ProcessAssessment {
        display_status: state.display_status(),
        state,
        reasons,
        confidence,
        captured_at_unix,
        last_activity_unix,
        inactive_secs,
        waiting_secs,
        state_entered_unix,
        eligible_for_herd: state == ProcessState::WaitingLong,
    }
}

pub(super) fn parse_turn_status(raw: &str) -> Option<CodexTurnStatus> {
    match raw {
        "inProgress" => Some(CodexTurnStatus::InProgress),
        "completed" => Some(CodexTurnStatus::Completed),
        "interrupted" => Some(CodexTurnStatus::Interrupted),
        "failed" => Some(CodexTurnStatus::Failed),
        _ => None,
    }
}

pub fn now_unix() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_secs() as i64,
        Err(_) => 0,
    }
}
