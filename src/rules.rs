mod decision;
mod evaluator;
mod file_io;
mod template;
mod types;

pub use self::decision::{parse_llm_decision_json, tail_lines};
pub use self::file_io::{default_rule_file, default_rule_file_content, load_rule_file};
pub use self::template::render_command_template;
pub use self::types::{
    BoundVariables, InputScope, LlmRule, LlmRuleDecision, RULE_FILE_VERSION, RegexRule,
    RuleDefinition, RuleExecutionSummary, RuleFile, RuleMatch, RuleRuntimeContext,
    RuleStatusContext,
};

pub fn evaluate_rules_in_order<F>(
    rule_file: &RuleFile,
    full_buffer: &str,
    visible_window: &str,
    runtime_context: &RuleRuntimeContext,
    mut eval_llm: F,
) -> RuleExecutionSummary
where
    F: FnMut(&LlmRule, &str, &RuleRuntimeContext) -> Result<LlmRuleDecision, String>,
{
    evaluator::evaluate_rules_in_order(
        rule_file,
        full_buffer,
        visible_window,
        runtime_context,
        &mut eval_llm,
    )
}

#[cfg(test)]
mod tests {
    use super::{
        InputScope, LlmRule, LlmRuleDecision, RegexRule, RuleDefinition, RuleFile,
        RuleRuntimeContext, RuleStatusContext, evaluate_rules_in_order, parse_llm_decision_json,
        render_command_template, tail_lines,
    };
    use serde_json::{Map, Value, json};

    fn test_runtime_context() -> RuleRuntimeContext {
        RuleRuntimeContext {
            pane_id: "%1".to_string(),
            session_name: "agent-a".to_string(),
            status: RuleStatusContext {
                state: "stalled".to_string(),
                display_status: "stalled".to_string(),
                inactive_secs: 240,
                waiting_secs: 0,
                confidence: 90,
                eligible_for_herd: true,
                reasons: vec!["inactivity_exceeded".to_string()],
            },
        }
    }

    #[test]
    fn render_command_template_fails_when_missing_variable() {
        let rendered = render_command_template("echo {missing}", &Map::new());
        assert!(rendered.is_err());
    }

    #[test]
    fn parse_llm_json_requires_match_boolean() {
        let parsed = parse_llm_decision_json("{\"command\":\"echo hi\"}");
        assert!(parsed.is_err());
    }

    #[test]
    fn evaluate_rules_stops_on_first_match() {
        let rules = RuleFile {
            version: 1,
            rules: vec![
                RuleDefinition::Regex(RegexRule {
                    id: "first".to_string(),
                    enabled: true,
                    input_scope: InputScope::FullBuffer,
                    pattern: "(?P<task>hello)".to_string(),
                    command_template: "echo {task}".to_string(),
                }),
                RuleDefinition::Regex(RegexRule {
                    id: "second".to_string(),
                    enabled: true,
                    input_scope: InputScope::FullBuffer,
                    pattern: "(?P<task>hello)".to_string(),
                    command_template: "echo second".to_string(),
                }),
            ],
        };
        let summary = evaluate_rules_in_order(
            &rules,
            "hello world",
            "hello",
            &test_runtime_context(),
            |_rule, _input, _context| Ok(LlmRuleDecision::default()),
        );
        assert_eq!(summary.matched_rule_id.as_deref(), Some("first"));
        assert_eq!(summary.command_to_send.as_deref(), Some("echo hello"));
        assert_eq!(
            summary
                .variables
                .get("status_state")
                .and_then(Value::as_str),
            Some("stalled")
        );
    }

    #[test]
    fn evaluate_llm_rule_supports_command_variable() {
        let rules = RuleFile {
            version: 1,
            rules: vec![RuleDefinition::Llm(LlmRule {
                id: "llm".to_string(),
                enabled: true,
                input_scope: InputScope::VisibleWindow,
                prompt: "p".to_string(),
                command_template: "{command}".to_string(),
            })],
        };
        let summary = evaluate_rules_in_order(
            &rules,
            "x",
            "y",
            &test_runtime_context(),
            |_rule, _input, _context| {
                Ok(LlmRuleDecision {
                    matched: true,
                    command: Some("echo llm".to_string()),
                    variables: Map::new(),
                })
            },
        );
        assert_eq!(summary.command_to_send.as_deref(), Some("echo llm"));
    }

    #[test]
    fn tail_lines_returns_visible_window_slice() {
        let value = tail_lines("a\nb\nc\nd", 2);
        assert_eq!(value, "c\nd");
    }

    #[test]
    fn parse_llm_decision_json_extracts_fields() {
        let decision = parse_llm_decision_json(
            &json!({
                "match": true,
                "command": "echo hi",
                "variables": {"ticket":"ABC-1"}
            })
            .to_string(),
        )
        .expect("decision should parse");
        assert!(decision.matched);
        assert_eq!(decision.command.as_deref(), Some("echo hi"));
        assert_eq!(
            decision
                .variables
                .get("ticket")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            "ABC-1"
        );
    }
}
