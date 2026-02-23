mod helpers;

use helpers::fixtures::{
    agent_status_from_str, load_config_fixture_text, load_herder_output_text, load_llm_output,
    load_monitor_expectation, load_registry_fixture, load_rule_expectation, load_rule_file_path,
    load_worker_fixture, process_state_from_str, temp_settings_path,
};
use herd::agent::{ClassifierConfig, HeuristicSessionClassifier, ProcessState, SessionClassifier};
use herd::config::AppConfig;
use herd::domain::{PaneSnapshot, SessionRef};
use herd::herd::{HerdConfig, HerdRegistry, HerdRuleEngine, monitor_cycle_for_session};
use herd::rules::{
    InputScope, LlmRule, LlmRuleDecision, RegexRule, RuleDefinition, RuleFile, RuleRuntimeContext,
    RuleStatusContext, evaluate_rules_in_order, load_rule_file, parse_llm_decision_json,
    tail_lines,
};
use herd::tmux::TmuxAdapter;
use serde_json::Value;
use std::fs;

#[derive(Default)]
struct FixtureTmux {
    sent: Vec<(String, String)>,
}

impl TmuxAdapter for FixtureTmux {
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

#[test]
fn worker_output_fixtures_cover_core_status_transitions() {
    let classifier = HeuristicSessionClassifier::new(ClassifierConfig::default());
    let scenarios = [
        "running_recent",
        "stalled_inactive",
        "finished_marker",
        "waiting_long",
    ];

    for scenario in scenarios {
        let fixture = load_worker_fixture(scenario);
        let snapshot = fixture.pane_snapshot();
        let assessment = classifier.assess(&snapshot, fixture.prior_process_state());

        assert_eq!(
            assessment.state,
            process_state_from_str(&fixture.expected.state),
            "scenario {scenario}"
        );
        assert_eq!(
            assessment.display_status,
            agent_status_from_str(&fixture.expected.display_status),
            "scenario {scenario}"
        );
        assert_eq!(
            assessment.eligible_for_herd, fixture.expected.eligible_for_herd,
            "scenario {scenario}"
        );
        if !fixture.expected.reasons.is_empty() {
            let labels = assessment.reason_labels();
            for expected_reason in fixture.expected.reasons {
                assert!(
                    labels.iter().any(|reason| reason == &expected_reason),
                    "scenario {scenario} missing reason {expected_reason}; labels={labels:?}"
                );
            }
        }
    }
}

#[test]
fn regex_rule_integration_uses_worker_and_herder_fixtures() {
    let worker = load_worker_fixture("rule_payload");
    let snapshot = worker.pane_snapshot();
    let classifier = HeuristicSessionClassifier::new(ClassifierConfig::default());
    let assessment = classifier.assess(&snapshot, worker.prior_process_state());

    let rule_file = load_rule_file(&load_rule_file_path("regex_dispatch")).expect("rules load");
    let runtime_context = worker.runtime_context(&assessment);

    let summary = evaluate_rules_in_order(
        &rule_file,
        &snapshot.content,
        &tail_lines(&snapshot.content, 3),
        &runtime_context,
        |_rule, _input, _context| Ok(LlmRuleDecision::default()),
    );

    let expected = load_rule_expectation("regex_dispatch");
    assert_eq!(summary.matched_rule_id, expected.matched_rule_id);
    assert_eq!(summary.command_to_send, expected.command_to_send);
    for entry in expected.logs_contains {
        assert!(
            summary.logs.iter().any(|line| line.contains(&entry)),
            "missing log entry fragment: {entry}"
        );
    }
}

#[test]
fn llm_rule_integration_uses_fixture_output_payload() {
    let worker = load_worker_fixture("rule_payload");
    let snapshot = worker.pane_snapshot();
    let classifier = HeuristicSessionClassifier::new(ClassifierConfig::default());
    let assessment = classifier.assess(&snapshot, worker.prior_process_state());

    let rule_file = load_rule_file(&load_rule_file_path("llm_dispatch")).expect("rules load");
    let runtime_context = worker.runtime_context(&assessment);
    let llm_decision_payload = load_llm_output("llm_decision_match");

    let summary = evaluate_rules_in_order(
        &rule_file,
        &snapshot.content,
        &tail_lines(&snapshot.content, 3),
        &runtime_context,
        |_rule, input, _context| {
            assert!(
                input.contains("VISIBLE: escalate now"),
                "expected visible-window input to be passed to llm evaluator"
            );
            parse_llm_decision_json(&llm_decision_payload)
        },
    );

    let expected = load_rule_expectation("llm_dispatch");
    assert_eq!(summary.matched_rule_id, expected.matched_rule_id);
    assert_eq!(summary.command_to_send, expected.command_to_send);
    for entry in expected.logs_contains {
        assert!(
            summary.logs.iter().any(|line| line.contains(&entry)),
            "missing log entry fragment: {entry}"
        );
    }
}

#[test]
fn herd_monitor_cycle_uses_fixture_registry_and_output_command() {
    let worker = load_worker_fixture("dispatch_waiting_long");
    let snapshot = worker.pane_snapshot();
    let classifier = HeuristicSessionClassifier::new(ClassifierConfig::default());
    let assessment = classifier.assess(&snapshot, worker.prior_process_state());
    assert!(
        assessment.eligible_for_herd,
        "fixture should be herd-eligible"
    );

    let mut registry: HerdRegistry = load_registry_fixture("herded_ready");
    let expectation = load_monitor_expectation("monitor_dispatch");
    let nudge_message = load_herder_output_text("nudge_command").trim().to_string();

    let engine = HerdRuleEngine::new(HerdConfig {
        cooldown_secs: 0,
        max_nudges: 3,
        nudge_message,
        status_confidence_min_for_trigger: 60,
    });
    let mut tmux = FixtureTmux::default();
    let session = worker.session_ref();

    let injected = monitor_cycle_for_session(
        &mut tmux,
        &engine,
        &mut registry,
        &session,
        &assessment,
        snapshot.captured_at_unix,
    )
    .expect("monitor cycle should run");

    assert!(injected, "expected fixture scenario to dispatch nudge");
    assert_eq!(tmux.sent.len(), 1);
    assert_eq!(tmux.sent[0].0, expectation.expected_pane_id);
    assert_eq!(tmux.sent[0].1, expectation.expected_command);

    let state = registry
        .session_state(&worker.pane_id)
        .expect("fixture pane should have state");
    assert_eq!(state.nudge_count, 1);
    assert_eq!(state.last_nudge_unix, Some(snapshot.captured_at_unix));
    assert_eq!(state.last_assessment_state, Some(ProcessState::WaitingLong));
    assert!(
        state
            .last_reasons
            .iter()
            .any(|reason| reason == "waiting_grace_exceeded"),
        "assessment reasons should persist into registry"
    );
}

#[test]
fn config_integration_uses_fixture_and_materializes_rule_files() {
    let settings_path = temp_settings_path("herd_fixture_settings");
    let settings_dir = settings_path
        .parent()
        .expect("settings path should have a parent")
        .to_path_buf();
    fs::create_dir_all(&settings_dir).expect("settings dir should be creatable");
    fs::write(&settings_path, load_config_fixture_text("partial_settings"))
        .expect("fixture config should write");

    let config =
        AppConfig::load_from_path(&settings_path).expect("config should load from fixture");
    assert_eq!(config.herd_count, 5, "default herd count should apply");
    assert_eq!(config.llm_provider, "anthropic");
    assert_eq!(config.llm_model, "claude-3-5-sonnet-latest");
    assert_eq!(
        config.provider_api_key("openai"),
        Some("sk-test-openai"),
        "openai key should round-trip"
    );
    assert_eq!(
        config.provider_api_key("anthropic"),
        Some("sk-test-anthropic"),
        "anthropic key should round-trip"
    );

    for mode in &config.herd_modes {
        let mode_path = settings_dir.join(&mode.rule_file);
        assert!(mode_path.exists(), "mode file {:?} should exist", mode_path);
        let parsed = load_rule_file(&mode_path).expect("materialized mode file should parse");
        assert_eq!(parsed.version, 1);
    }

    let persisted: Value = serde_json::from_str(
        &fs::read_to_string(&settings_path).expect("persisted settings should be readable"),
    )
    .expect("persisted settings should parse");
    assert_eq!(persisted.get("herd_count").and_then(Value::as_u64), Some(5));

    let _ = fs::remove_dir_all(settings_dir);
}

#[test]
fn regex_visible_window_rule_renders_context_and_capture_variables() {
    let rules = RuleFile {
        version: 1,
        rules: vec![RuleDefinition::Regex(RegexRule {
            id: "visible_ticket".to_string(),
            enabled: true,
            input_scope: InputScope::VisibleWindow,
            pattern: r"TICKET=(?P<ticket>H-\d+)".to_string(),
            command_template: "notify {ticket} state={status_state}".to_string(),
        })],
    };
    let context = RuleRuntimeContext {
        pane_id: "%42".to_string(),
        session_name: "worker-visible".to_string(),
        status: RuleStatusContext {
            state: "stalled".to_string(),
            display_status: "stalled".to_string(),
            inactive_secs: 480,
            waiting_secs: 0,
            confidence: 92,
            eligible_for_herd: true,
            reasons: vec!["inactivity_exceeded".to_string()],
        },
    };

    let summary = evaluate_rules_in_order(
        &rules,
        "FULL BUFFER WITHOUT TICKET",
        "VISIBLE WINDOW\nTICKET=H-204\nextra context",
        &context,
        |_rule, _input, _context| Ok(LlmRuleDecision::default()),
    );

    assert_eq!(summary.matched_rule_id.as_deref(), Some("visible_ticket"));
    assert_eq!(
        summary.command_to_send.as_deref(),
        Some("notify H-204 state=stalled")
    );
    assert_eq!(
        summary.variables.get("ticket").and_then(Value::as_str),
        Some("H-204")
    );
}

#[test]
fn llm_non_match_falls_through_to_later_regex_rule() {
    let rules = RuleFile {
        version: 1,
        rules: vec![
            RuleDefinition::Llm(LlmRule {
                id: "llm_first".to_string(),
                enabled: true,
                input_scope: InputScope::VisibleWindow,
                prompt: "decide".to_string(),
                command_template: "{command}".to_string(),
            }),
            RuleDefinition::Regex(RegexRule {
                id: "regex_fallback".to_string(),
                enabled: true,
                input_scope: InputScope::FullBuffer,
                pattern: r"(?P<action>fallback-now)".to_string(),
                command_template: "echo {action}".to_string(),
            }),
        ],
    };
    let context = RuleRuntimeContext {
        pane_id: "%43".to_string(),
        session_name: "worker-fallback".to_string(),
        status: RuleStatusContext {
            state: "waiting_long".to_string(),
            display_status: "waiting".to_string(),
            inactive_secs: 240,
            waiting_secs: 200,
            confidence: 88,
            eligible_for_herd: true,
            reasons: vec!["waiting_grace_exceeded".to_string()],
        },
    };
    let mut llm_call_count = 0usize;

    let summary = evaluate_rules_in_order(
        &rules,
        "agent says fallback-now",
        "visible tail",
        &context,
        |_rule, _input, _context| {
            llm_call_count += 1;
            Ok(LlmRuleDecision {
                matched: false,
                command: None,
                variables: Default::default(),
            })
        },
    );

    assert_eq!(llm_call_count, 1, "llm should be consulted once");
    assert_eq!(summary.matched_rule_id.as_deref(), Some("regex_fallback"));
    assert_eq!(
        summary.command_to_send.as_deref(),
        Some("echo fallback-now")
    );
}
