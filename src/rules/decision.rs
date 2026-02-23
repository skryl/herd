use serde_json::Value;

use super::LlmRuleDecision;

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
