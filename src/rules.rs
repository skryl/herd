use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::fs;
use std::path::Path;

mod evaluator;
mod template;

pub use self::template::render_command_template;

pub const RULE_FILE_VERSION: u32 = 1;

#[derive(Clone, Debug, Default, Serialize, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum InputScope {
    #[default]
    FullBuffer,
    VisibleWindow,
}

#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
pub struct RegexRule {
    pub id: String,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub input_scope: InputScope,
    pub pattern: String,
    pub command_template: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
pub struct LlmRule {
    pub id: String,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub input_scope: InputScope,
    pub prompt: String,
    pub command_template: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RuleDefinition {
    Regex(RegexRule),
    Llm(LlmRule),
}

#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
pub struct RuleFile {
    #[serde(default = "default_rule_version")]
    pub version: u32,
    #[serde(default)]
    pub rules: Vec<RuleDefinition>,
}

impl Default for RuleFile {
    fn default() -> Self {
        Self {
            version: RULE_FILE_VERSION,
            rules: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct LlmRuleDecision {
    pub matched: bool,
    pub command: Option<String>,
    pub variables: BoundVariables,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct RuleExecutionSummary {
    pub matched_rule_id: Option<String>,
    pub command_to_send: Option<String>,
    pub variables: BoundVariables,
    pub logs: Vec<String>,
}

pub type BoundVariables = Map<String, Value>;
pub type RuleMatch = Option<(String, BoundVariables)>;

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct RuleStatusContext {
    pub state: String,
    pub display_status: String,
    pub inactive_secs: i64,
    pub waiting_secs: i64,
    pub confidence: u8,
    pub eligible_for_herd: bool,
    pub reasons: Vec<String>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct RuleRuntimeContext {
    pub pane_id: String,
    pub session_name: String,
    pub status: RuleStatusContext,
}

fn default_rule_version() -> u32 {
    RULE_FILE_VERSION
}

fn default_enabled() -> bool {
    true
}

pub fn load_rule_file(path: &Path) -> Result<RuleFile, String> {
    let raw = fs::read_to_string(path)
        .map_err(|err| format!("failed reading rule file {:?}: {err}", path))?;
    serde_json::from_str::<RuleFile>(&raw)
        .map_err(|err| format!("failed parsing rule file {:?}: {err}", path))
}

pub fn parse_llm_decision_json(raw: &str) -> Result<LlmRuleDecision, String> {
    let parsed: Value = serde_json::from_str(raw)
        .map_err(|err| format!("llm rule response was not valid JSON: {err}"))?;
    let object = parsed
        .as_object()
        .ok_or_else(|| "llm rule response must be a JSON object".to_string())?;
    let matched = object
        .get("match")
        .and_then(Value::as_bool)
        .ok_or_else(|| "llm rule response must contain boolean field `match`".to_string())?;
    let command = object
        .get("command")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let variables = object
        .get("variables")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    Ok(LlmRuleDecision {
        matched,
        command,
        variables,
    })
}

pub fn tail_lines(content: &str, lines: usize) -> String {
    if lines == 0 {
        return String::new();
    }
    content
        .lines()
        .rev()
        .take(lines)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn default_rule_file(mode_name: &str) -> RuleFile {
    RuleFile {
        version: RULE_FILE_VERSION,
        rules: vec![
            RuleDefinition::Regex(RegexRule {
                id: "default_nudge".to_string(),
                enabled: true,
                input_scope: InputScope::FullBuffer,
                pattern: "(?s).*".to_string(),
                command_template: "Please continue until the task is fully complete.".to_string(),
            }),
            RuleDefinition::Llm(LlmRule {
                id: "llm_suggested_command".to_string(),
                enabled: false,
                input_scope: InputScope::VisibleWindow,
                prompt: format!(
                    "Mode: {mode_name}. Return strict JSON: {{\"match\":bool,\"command\":string?,\"variables\":object?}}."
                ),
                command_template: "{command}".to_string(),
            }),
        ],
    }
}

pub fn default_rule_file_content(mode_name: &str) -> Result<String, String> {
    serde_json::to_string_pretty(&default_rule_file(mode_name))
        .map_err(|err| format!("failed serializing default rule file: {err}"))
}

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
