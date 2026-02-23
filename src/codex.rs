mod app_server;
mod assessment;
mod provider;

pub use self::assessment::{
    CodexThreadState, CodexTurnStatus, assessment_from_codex_state,
    collect_codex_cwds_from_sessions, is_codex_command, now_unix,
};
pub use self::provider::CodexSessionStateProvider;

#[cfg(test)]
mod tests {
    use super::assessment::parse_turn_status;
    use super::{
        CodexThreadState, CodexTurnStatus, assessment_from_codex_state,
        collect_codex_cwds_from_sessions,
    };
    use crate::agent::{PriorProcessState, ProcessState};
    use crate::domain::SessionRef;

    #[test]
    fn codex_in_progress_maps_to_running_assessment() {
        let assessment = assessment_from_codex_state(
            &CodexThreadState {
                thread_id: "t1".to_string(),
                thread_updated_unix: 100,
                turn_status: Some(CodexTurnStatus::InProgress),
            },
            PriorProcessState::default(),
            110,
            120,
        );
        assert_eq!(assessment.state, ProcessState::Running);
        assert!(!assessment.eligible_for_herd);
    }

    #[test]
    fn codex_completed_maps_to_waiting_long_after_grace() {
        let assessment = assessment_from_codex_state(
            &CodexThreadState {
                thread_id: "t2".to_string(),
                thread_updated_unix: 100,
                turn_status: Some(CodexTurnStatus::Completed),
            },
            PriorProcessState {
                state: Some(ProcessState::Waiting),
                state_entered_unix: Some(5),
            },
            130,
            120,
        );
        assert_eq!(assessment.state, ProcessState::WaitingLong);
        assert!(assessment.eligible_for_herd);
    }

    #[test]
    fn codex_failed_maps_to_stalled() {
        let assessment = assessment_from_codex_state(
            &CodexThreadState {
                thread_id: "t3".to_string(),
                thread_updated_unix: 100,
                turn_status: Some(CodexTurnStatus::Failed),
            },
            PriorProcessState::default(),
            150,
            120,
        );
        assert_eq!(assessment.state, ProcessState::Stalled);
        assert!(assessment.eligible_for_herd);
    }

    #[test]
    fn parse_turn_status_handles_known_values() {
        assert_eq!(
            parse_turn_status("inProgress"),
            Some(CodexTurnStatus::InProgress)
        );
        assert_eq!(
            parse_turn_status("completed"),
            Some(CodexTurnStatus::Completed)
        );
        assert_eq!(
            parse_turn_status("interrupted"),
            Some(CodexTurnStatus::Interrupted)
        );
        assert_eq!(parse_turn_status("failed"), Some(CodexTurnStatus::Failed));
        assert_eq!(parse_turn_status("unknown"), None);
    }

    #[test]
    fn collect_codex_cwds_selects_unique_codex_sessions() {
        let sessions = vec![
            SessionRef {
                session_id: "$1".to_string(),
                session_name: "a".to_string(),
                window_id: "@1".to_string(),
                window_index: 0,
                window_name: "main".to_string(),
                pane_id: "%1".to_string(),
                pane_index: 0,
                pane_current_path: "/tmp/work1".to_string(),
                pane_current_command: "codex".to_string(),
                pane_dead: false,
                pane_last_activity_unix: 0,
            },
            SessionRef {
                session_id: "$2".to_string(),
                session_name: "b".to_string(),
                window_id: "@2".to_string(),
                window_index: 0,
                window_name: "main".to_string(),
                pane_id: "%2".to_string(),
                pane_index: 0,
                pane_current_path: "/tmp/work1".to_string(),
                pane_current_command: "codex --profile x".to_string(),
                pane_dead: false,
                pane_last_activity_unix: 0,
            },
            SessionRef {
                session_id: "$3".to_string(),
                session_name: "c".to_string(),
                window_id: "@3".to_string(),
                window_index: 0,
                window_name: "main".to_string(),
                pane_id: "%3".to_string(),
                pane_index: 0,
                pane_current_path: "/tmp/work2".to_string(),
                pane_current_command: "bash".to_string(),
                pane_dead: false,
                pane_last_activity_unix: 0,
            },
        ];

        let mut cwds = collect_codex_cwds_from_sessions(&sessions);
        cwds.sort();
        assert_eq!(cwds, vec!["/tmp/work1".to_string()]);
    }
}
