use herd::agent::{
    AgentStatus, ClassifierConfig, HeuristicSessionClassifier, PriorProcessState, ProcessState,
    SessionClassifier,
};
use herd::domain::PaneSnapshot;

#[test]
fn classifier_marks_finished_when_finished_marker_present() {
    let classifier = HeuristicSessionClassifier::new(ClassifierConfig::default());
    let snapshot = PaneSnapshot {
        pane_id: "%1".to_string(),
        content: "Work complete. Finished successfully.".to_string(),
        captured_at_unix: 1_700_000_100,
        last_activity_unix: 1_700_000_000,
    };

    let assessment = classifier.assess(&snapshot, PriorProcessState::default());
    assert_eq!(assessment.display_status, AgentStatus::Finished);
    assert_eq!(assessment.state, ProcessState::Finished);
}

#[test]
fn classifier_marks_stalled_when_inactive_past_threshold_without_finished_marker() {
    let classifier = HeuristicSessionClassifier::new(ClassifierConfig {
        stall_threshold_secs: 60,
        finished_markers: vec!["finished".to_string()],
        waiting_markers: vec![],
        marker_lookback_lines: 8,
        waiting_grace_secs: 120,
        transition_stability_secs: 5,
    });
    let snapshot = PaneSnapshot {
        pane_id: "%1".to_string(),
        content: "Thinking through options...".to_string(),
        captured_at_unix: 1_700_000_500,
        last_activity_unix: 1_700_000_000,
    };

    let assessment = classifier.assess(&snapshot, PriorProcessState::default());
    assert_eq!(assessment.display_status, AgentStatus::Stalled);
    assert_eq!(assessment.state, ProcessState::Stalled);
}

#[test]
fn classifier_marks_waiting_when_wait_marker_present() {
    let classifier = HeuristicSessionClassifier::new(ClassifierConfig {
        stall_threshold_secs: 60,
        finished_markers: vec!["finished".to_string()],
        waiting_markers: vec!["waiting for input".to_string()],
        marker_lookback_lines: 8,
        waiting_grace_secs: 120,
        transition_stability_secs: 5,
    });
    let snapshot = PaneSnapshot {
        pane_id: "%1".to_string(),
        content: "Waiting for input from user".to_string(),
        captured_at_unix: 1_700_000_020,
        last_activity_unix: 1_700_000_000,
    };

    let assessment = classifier.assess(&snapshot, PriorProcessState::default());
    assert_eq!(assessment.display_status, AgentStatus::Waiting);
    assert_eq!(assessment.state, ProcessState::Waiting);
}

#[test]
fn classifier_marks_running_when_recent_and_not_waiting_or_finished() {
    let classifier = HeuristicSessionClassifier::new(ClassifierConfig::default());
    let snapshot = PaneSnapshot {
        pane_id: "%1".to_string(),
        content: "Implementing the next chunk now".to_string(),
        captured_at_unix: 1_700_000_010,
        last_activity_unix: 1_700_000_000,
    };

    let assessment = classifier.assess(&snapshot, PriorProcessState::default());
    assert_eq!(assessment.display_status, AgentStatus::Running);
    assert_eq!(assessment.state, ProcessState::Running);
}

#[test]
fn classifier_ignores_old_finished_markers_when_recent_output_is_active() {
    let classifier = HeuristicSessionClassifier::new(ClassifierConfig::default());
    let mut lines = vec![
        "Earlier run finished successfully.".to_string(),
        "continuing work now...".to_string(),
    ];
    for i in 0..12 {
        lines.push(format!("stream update line {i}"));
    }
    let snapshot = PaneSnapshot {
        pane_id: "%1".to_string(),
        content: lines.join("\n"),
        captured_at_unix: 1_700_000_010,
        last_activity_unix: 1_700_000_008,
    };

    let assessment = classifier.assess(&snapshot, PriorProcessState::default());
    assert_eq!(assessment.display_status, AgentStatus::Running);
    assert_eq!(assessment.state, ProcessState::Running);
}

#[test]
fn classifier_matches_markers_in_ansi_styled_output() {
    let classifier = HeuristicSessionClassifier::new(ClassifierConfig::default());
    let snapshot = PaneSnapshot {
        pane_id: "%1".to_string(),
        content: "\u{1b}[32mWaiting for input\u{1b}[0m".to_string(),
        captured_at_unix: 1_700_000_050,
        last_activity_unix: 1_700_000_049,
    };

    let assessment = classifier.assess(&snapshot, PriorProcessState::default());
    assert_eq!(assessment.display_status, AgentStatus::Waiting);
    assert_eq!(assessment.state, ProcessState::Waiting);
}

#[test]
fn classifier_promotes_waiting_to_waiting_long_after_grace() {
    let classifier = HeuristicSessionClassifier::new(ClassifierConfig {
        stall_threshold_secs: 60,
        finished_markers: vec!["finished".to_string()],
        waiting_markers: vec!["waiting for input".to_string()],
        marker_lookback_lines: 8,
        waiting_grace_secs: 120,
        transition_stability_secs: 0,
    });
    let snapshot = PaneSnapshot {
        pane_id: "%1".to_string(),
        content: "Waiting for input from user".to_string(),
        captured_at_unix: 1_700_000_200,
        last_activity_unix: 1_700_000_000,
    };

    let assessment = classifier.assess(
        &snapshot,
        PriorProcessState {
            state: Some(ProcessState::Waiting),
            state_entered_unix: Some(1_700_000_000),
        },
    );
    assert_eq!(assessment.display_status, AgentStatus::Waiting);
    assert_eq!(assessment.state, ProcessState::WaitingLong);
    assert!(assessment.eligible_for_herd);
}
