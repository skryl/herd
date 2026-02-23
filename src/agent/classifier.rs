use crate::domain::PaneSnapshot;

use super::{
    AgentStatus, HeuristicSessionClassifier, PriorProcessState, ProcessAssessment, ProcessState,
    SessionClassifier, StatusReasonCode,
};

fn strip_ansi_csi(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0usize;

    while i < bytes.len() {
        if bytes[i] == 0x1b {
            if i + 1 < bytes.len() && bytes[i + 1] == b'[' {
                i += 2;
                while i < bytes.len() {
                    let b = bytes[i];
                    i += 1;
                    if (0x40..=0x7e).contains(&b) {
                        break;
                    }
                }
            } else {
                i += 1;
            }
            continue;
        }

        let ch = input[i..].chars().next().unwrap_or_default();
        out.push(ch);
        i += ch.len_utf8();
    }

    out
}

fn recent_marker_window(content: &str, lookback_lines: usize) -> String {
    if lookback_lines == 0 {
        return content.to_string();
    }

    let lines: Vec<&str> = content
        .lines()
        .rev()
        .filter(|line| !line.trim().is_empty())
        .take(lookback_lines)
        .collect();
    if lines.is_empty() {
        content.to_string()
    } else {
        lines.into_iter().rev().collect::<Vec<_>>().join("\n")
    }
}

fn contains_marker(content: &str, marker: &str) -> bool {
    let marker = marker.trim().to_lowercase();
    if marker.is_empty() {
        return false;
    }

    if marker.chars().all(|ch| ch.is_ascii_alphanumeric()) {
        content
            .split(|ch: char| !ch.is_ascii_alphanumeric())
            .any(|token| token == marker)
    } else {
        content.contains(&marker)
    }
}

fn confidence_for_state(state: ProcessState) -> u8 {
    match state {
        ProcessState::Finished => 95,
        ProcessState::Stalled => 90,
        ProcessState::WaitingLong => 88,
        ProcessState::Waiting => 78,
        ProcessState::Running => 72,
        ProcessState::Unknown => 20,
    }
}

impl SessionClassifier for HeuristicSessionClassifier {
    fn assess(&self, snapshot: &PaneSnapshot, prior: PriorProcessState) -> ProcessAssessment {
        let captured_at_unix = snapshot.captured_at_unix;
        let last_activity_unix = snapshot.last_activity_unix;
        let inactive_secs = if last_activity_unix > 0 {
            (captured_at_unix - last_activity_unix).max(0)
        } else {
            0
        };

        let normalized = strip_ansi_csi(&snapshot.content).to_lowercase();
        if normalized.trim().is_empty() {
            return ProcessAssessment {
                display_status: AgentStatus::Unknown,
                state: ProcessState::Unknown,
                reasons: vec![StatusReasonCode::NoContent],
                confidence: confidence_for_state(ProcessState::Unknown),
                captured_at_unix,
                last_activity_unix,
                inactive_secs,
                waiting_secs: 0,
                state_entered_unix: prior.state_entered_unix.unwrap_or(captured_at_unix),
                eligible_for_herd: false,
            };
        }

        let marker_scope = recent_marker_window(&normalized, self.config.marker_lookback_lines);
        let finished_detected = self
            .config
            .finished_markers
            .iter()
            .any(|marker| contains_marker(&marker_scope, marker));
        let waiting_marker_detected = self
            .config
            .waiting_markers
            .iter()
            .any(|marker| contains_marker(&marker_scope, marker));
        let question_detected = marker_scope.trim_end().ends_with('?');

        let mut reasons = Vec::new();
        let mut candidate_state = if finished_detected {
            reasons.push(StatusReasonCode::FinishedMarker);
            ProcessState::Finished
        } else if waiting_marker_detected || question_detected {
            if waiting_marker_detected {
                reasons.push(StatusReasonCode::WaitingMarker);
            }
            if question_detected {
                reasons.push(StatusReasonCode::QuestionTail);
            }
            if matches!(prior.state, Some(ProcessState::WaitingLong)) {
                ProcessState::WaitingLong
            } else {
                ProcessState::Waiting
            }
        } else if inactive_secs >= self.config.stall_threshold_secs.max(0) {
            reasons.push(StatusReasonCode::InactivityExceeded);
            ProcessState::Stalled
        } else {
            reasons.push(StatusReasonCode::ActivityRecent);
            ProcessState::Running
        };

        if let Some(previous_state) = prior.state
            && previous_state != candidate_state
            && self.config.transition_stability_secs > 0
        {
            let previous_entered = prior.state_entered_unix.unwrap_or(captured_at_unix);
            if (captured_at_unix - previous_entered).max(0) < self.config.transition_stability_secs
            {
                candidate_state = previous_state;
                reasons.push(StatusReasonCode::TransitionStabilityHold);
            }
        }

        let mut state_entered_unix = if prior.state == Some(candidate_state) {
            prior.state_entered_unix.unwrap_or(captured_at_unix)
        } else {
            captured_at_unix
        };

        let mut waiting_secs = 0;
        if matches!(
            candidate_state,
            ProcessState::Waiting | ProcessState::WaitingLong
        ) {
            if matches!(
                prior.state,
                Some(ProcessState::Waiting | ProcessState::WaitingLong)
            ) {
                state_entered_unix = prior.state_entered_unix.unwrap_or(captured_at_unix);
            }
            waiting_secs = (captured_at_unix - state_entered_unix).max(0);
            if candidate_state == ProcessState::Waiting
                && waiting_secs >= self.config.waiting_grace_secs.max(0)
            {
                candidate_state = ProcessState::WaitingLong;
                reasons.push(StatusReasonCode::WaitingGraceExceeded);
            }
        }

        let mut confidence = confidence_for_state(candidate_state);
        if reasons.contains(&StatusReasonCode::TransitionStabilityHold) {
            confidence = confidence.saturating_sub(15);
        }

        ProcessAssessment {
            display_status: candidate_state.display_status(),
            state: candidate_state,
            reasons,
            confidence,
            captured_at_unix,
            last_activity_unix,
            inactive_secs,
            waiting_secs,
            state_entered_unix,
            eligible_for_herd: matches!(
                candidate_state,
                ProcessState::Stalled | ProcessState::WaitingLong
            ),
        }
    }
}
