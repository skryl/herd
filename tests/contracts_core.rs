use herd::agent::{AgentStatus, PriorProcessState, ProcessAssessment, SessionClassifier};
use herd::domain::{PaneSnapshot, SessionRef};
use herd::herd::{HerdEngine, HerdSessionState};
use herd::tmux::TmuxAdapter;

struct NoopAdapter;

impl TmuxAdapter for NoopAdapter {
    fn list_sessions(&self) -> Result<Vec<SessionRef>, String> {
        Ok(vec![])
    }

    fn capture_pane(&self, _pane_id: &str, _lines: usize) -> Result<PaneSnapshot, String> {
        Ok(PaneSnapshot {
            pane_id: String::new(),
            content: String::new(),
            captured_at_unix: 0,
            last_activity_unix: 0,
        })
    }

    fn pane_height(&self, _pane_id: &str) -> Result<usize, String> {
        Ok(40)
    }

    fn send_keys(&mut self, _pane_id: &str, _message: &str) -> Result<(), String> {
        Ok(())
    }
}

struct NoopClassifier;

impl SessionClassifier for NoopClassifier {
    fn assess(&self, _snapshot: &PaneSnapshot, _prior: PriorProcessState) -> ProcessAssessment {
        ProcessAssessment::from_display_status(AgentStatus::Unknown)
    }
}

struct NoopHerd;

impl HerdEngine for NoopHerd {
    fn should_nudge(
        &self,
        _session: &SessionRef,
        _assessment: &ProcessAssessment,
        _session_state: Option<&HerdSessionState>,
        _now_unix: i64,
    ) -> bool {
        false
    }

    fn nudge_message(&self) -> &str {
        "noop"
    }
}

#[test]
fn core_contracts_are_implementable() {
    let adapter: Box<dyn TmuxAdapter> = Box::new(NoopAdapter);
    let classifier: Box<dyn SessionClassifier> = Box::new(NoopClassifier);
    let herd: Box<dyn HerdEngine> = Box::new(NoopHerd);

    let _ = adapter.list_sessions().expect("list_sessions should work");
    let _ = classifier.assess(
        &PaneSnapshot {
            pane_id: "0".to_string(),
            content: "sample".to_string(),
            captured_at_unix: 1,
            last_activity_unix: 1,
        },
        PriorProcessState::default(),
    );
    assert!(!herd.should_nudge(
        &SessionRef {
            session_id: "s".to_string(),
            session_name: "session".to_string(),
            window_id: "@1".to_string(),
            window_index: 0,
            window_name: "editor".to_string(),
            pane_id: "0".to_string(),
            pane_index: 0,
            pane_current_path: "/tmp".to_string(),
            pane_current_command: "bash".to_string(),
            pane_dead: false,
            pane_last_activity_unix: 0,
        },
        &ProcessAssessment::from_display_status(AgentStatus::Unknown),
        None,
        0,
    ));
}
