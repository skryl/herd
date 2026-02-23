use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use herd::agent::{AgentStatus, ProcessAssessment, ProcessState};
use herd::domain::{PaneSnapshot, SessionRef};
use herd::herd::{HerdConfig, HerdEngine, HerdRegistry, HerdRuleEngine, monitor_cycle_for_session};
use herd::tmux::TmuxAdapter;

#[derive(Default)]
struct FakeTmux {
    sent: Vec<(String, String)>,
}

impl TmuxAdapter for FakeTmux {
    fn list_sessions(&self) -> Result<Vec<SessionRef>, String> {
        Ok(vec![])
    }

    fn capture_pane(&self, pane_id: &str, _lines: usize) -> Result<PaneSnapshot, String> {
        Ok(PaneSnapshot {
            pane_id: pane_id.to_string(),
            content: String::new(),
            captured_at_unix: 0,
            last_activity_unix: 0,
        })
    }

    fn pane_height(&self, _pane_id: &str) -> Result<usize, String> {
        Ok(40)
    }

    fn send_keys(&mut self, pane_id: &str, message: &str) -> Result<(), String> {
        self.sent.push((pane_id.to_string(), message.to_string()));
        Ok(())
    }
}

fn assessment_for_status(status: AgentStatus) -> ProcessAssessment {
    let mut assessment = ProcessAssessment::from_display_status(status);
    assessment.confidence = 95;
    assessment.eligible_for_herd = matches!(assessment.state, ProcessState::Stalled);
    assessment
}

fn waiting_long_assessment() -> ProcessAssessment {
    let mut assessment = ProcessAssessment::from_display_status(AgentStatus::Waiting);
    assessment.state = ProcessState::WaitingLong;
    assessment.waiting_secs = 180;
    assessment.confidence = 95;
    assessment.eligible_for_herd = true;
    assessment
}

#[test]
fn herd_registry_toggles_and_persists() {
    let path = temp_file("herd_state");
    let mut registry = HerdRegistry::default();

    registry.set_herd_group("%1", Some(4));
    registry.set_herd_mode(4, "Aggressive");
    assert!(registry.is_herded("%1"));
    assert_eq!(registry.herd_group("%1"), Some(4));
    assert_eq!(registry.herd_mode(4), "Aggressive".to_string());

    registry
        .save_to_path(&path)
        .expect("state file should save successfully");
    let reloaded = HerdRegistry::load_from_path(&path).expect("state file should reload");
    assert!(reloaded.is_herded("%1"));
    assert_eq!(reloaded.herd_group("%1"), Some(4));
    assert_eq!(reloaded.herd_mode(4), "Aggressive".to_string());

    let _ = fs::remove_file(&path);
}

#[test]
fn rule_engine_only_nudges_stalled_sessions_and_honors_cooldown_and_max() {
    let mut tmux = FakeTmux::default();
    let mut registry = HerdRegistry::default();
    let engine = HerdRuleEngine::new(HerdConfig {
        cooldown_secs: 30,
        max_nudges: 2,
        nudge_message: "Please continue until the task is fully complete.".to_string(),
        status_confidence_min_for_trigger: 60,
    });

    let session = SessionRef {
        session_id: "$1".to_string(),
        session_name: "agent-a".to_string(),
        window_id: "@1".to_string(),
        window_index: 0,
        window_name: "editor".to_string(),
        pane_id: "%1".to_string(),
        pane_index: 0,
        pane_current_path: "/tmp".to_string(),
        pane_current_command: "bash".to_string(),
        pane_dead: false,
        pane_last_activity_unix: 100,
    };

    registry.set_herded("%1", true);
    assert!(engine.should_nudge(
        &session,
        &waiting_long_assessment(),
        registry.session_state("%1"),
        190
    ));
    assert!(engine.should_nudge(
        &session,
        &assessment_for_status(AgentStatus::Stalled),
        registry.session_state("%1"),
        200
    ));
    let first = monitor_cycle_for_session(
        &mut tmux,
        &engine,
        &mut registry,
        &session,
        &assessment_for_status(AgentStatus::Stalled),
        200,
    )
    .expect("first cycle should run");
    assert!(first, "first stalled cycle should nudge");
    assert_eq!(tmux.sent.len(), 1);

    let second = monitor_cycle_for_session(
        &mut tmux,
        &engine,
        &mut registry,
        &session,
        &assessment_for_status(AgentStatus::Stalled),
        210,
    )
    .expect("second cycle should run");
    assert!(!second, "cooldown should prevent second nudge");
    assert_eq!(tmux.sent.len(), 1);

    let third = monitor_cycle_for_session(
        &mut tmux,
        &engine,
        &mut registry,
        &session,
        &assessment_for_status(AgentStatus::Stalled),
        240,
    )
    .expect("third cycle should run");
    assert!(third, "after cooldown, second allowed nudge should fire");
    assert_eq!(tmux.sent.len(), 2);

    let fourth = monitor_cycle_for_session(
        &mut tmux,
        &engine,
        &mut registry,
        &session,
        &assessment_for_status(AgentStatus::Stalled),
        280,
    )
    .expect("fourth cycle should run");
    assert!(!fourth, "max nudges should cap injections");
    assert_eq!(tmux.sent.len(), 2);

    let finished = monitor_cycle_for_session(
        &mut tmux,
        &engine,
        &mut registry,
        &session,
        &assessment_for_status(AgentStatus::Finished),
        320,
    )
    .expect("finished cycle should run");
    assert!(!finished, "finished sessions must not be nudged");
}

#[test]
fn monitor_cycle_injects_real_tmux_message_for_stalled_herded_session() {
    let socket = format!("herd-monitor-e2e-{}", unique_suffix());
    let target = "herd_monitor_inject";
    let setup_status = Command::new("tmux")
        .args([
            "-L",
            &socket,
            "-f",
            "/dev/null",
            "new-session",
            "-d",
            "-s",
            target,
        ])
        .status()
        .expect("tmux should launch");
    assert!(setup_status.success(), "tmux setup should succeed");

    let mut adapter = herd::tmux::SystemTmuxAdapter::new(Some(socket.clone()));
    let mut sessions = adapter.list_sessions().expect("list should succeed");
    let session = sessions
        .iter_mut()
        .find(|session| session.session_name == target)
        .expect("target session should exist")
        .clone();

    let mut registry = HerdRegistry::default();
    registry.set_herded(&session.pane_id, true);
    let engine = HerdRuleEngine::new(HerdConfig {
        cooldown_secs: 0,
        max_nudges: 1,
        nudge_message: "echo herd_nudge_marker".to_string(),
        status_confidence_min_for_trigger: 60,
    });

    let injected = monitor_cycle_for_session(
        &mut adapter,
        &engine,
        &mut registry,
        &session,
        &assessment_for_status(AgentStatus::Stalled),
        1_700_000_000,
    )
    .expect("monitor cycle should run");
    assert!(injected, "first cycle should inject nudge");

    thread::sleep(std::time::Duration::from_millis(150));
    let captured = adapter
        .capture_pane(&session.pane_id, 60)
        .expect("capture should succeed");
    assert!(
        captured.content.contains("herd_nudge_marker"),
        "captured pane should contain injected marker"
    );

    let _ = Command::new("tmux")
        .args(["-L", &socket, "kill-server"])
        .status();
}

fn temp_file(prefix: &str) -> PathBuf {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be monotonic enough")
        .as_millis();
    std::env::temp_dir().join(format!("{prefix}_{suffix}.json"))
}

fn unique_suffix() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be monotonic enough")
        .as_millis()
}
