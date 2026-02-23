use regex::{Captures, Regex};
use serde_json::{Map, Value};

use super::{
    BoundVariables, InputScope, LlmRule, LlmRuleDecision, RegexRule, RuleDefinition,
    RuleExecutionSummary, RuleFile, RuleMatch, RuleRuntimeContext, render_command_template,
};

fn variables_from_regex(regex: &Regex, captures: &Captures<'_>) -> BoundVariables {
    let mut variables = Map::new();
    for name in regex.capture_names().flatten() {
        if let Some(value) = captures.name(name) {
            variables.insert(name.to_string(), Value::String(value.as_str().to_string()));
        }
    }
    variables
}

fn context_variables(context: &RuleRuntimeContext) -> BoundVariables {
    let mut values = Map::new();
    values.insert(
        "pane_id".to_string(),
        Value::String(context.pane_id.clone()),
    );
    values.insert(
        "session_name".to_string(),
        Value::String(context.session_name.clone()),
    );
    values.insert(
        "status_state".to_string(),
        Value::String(context.status.state.clone()),
    );
    values.insert(
        "status_display".to_string(),
        Value::String(context.status.display_status.clone()),
    );
    values.insert(
        "status_inactive_secs".to_string(),
        Value::Number(context.status.inactive_secs.into()),
    );
    values.insert(
        "status_waiting_secs".to_string(),
        Value::Number(context.status.waiting_secs.into()),
    );
    values.insert(
        "status_confidence".to_string(),
        Value::Number(u64::from(context.status.confidence).into()),
    );
    values.insert(
        "status_eligible_for_herd".to_string(),
        Value::Bool(context.status.eligible_for_herd),
    );
    values.insert(
        "status_reasons".to_string(),
        Value::String(context.status.reasons.join("|")),
    );
    values.insert(
        "status_reasons_json".to_string(),
        Value::Array(
            context
                .status
                .reasons
                .iter()
                .map(|reason| Value::String(reason.clone()))
                .collect(),
        ),
    );
    values
}

fn evaluate_regex_rule(
    rule: &RegexRule,
    input: &str,
    runtime_context: &RuleRuntimeContext,
    logs: &mut Vec<String>,
) -> Result<RuleMatch, String> {
    let regex = Regex::new(&rule.pattern)
        .map_err(|err| format!("rule {} regex compile failed: {err}", rule.id))?;
    let Some(captures) = regex.captures(input) else {
        logs.push(format!("rule_result id={} type=regex match=false", rule.id));
        return Ok(None);
    };
    let mut variables = context_variables(runtime_context);
    variables.extend(variables_from_regex(&regex, &captures));
    logs.push(format!(
        "rule_result id={} type=regex match=true vars={}",
        rule.id,
        Value::Object(variables.clone())
    ));
    let command = render_command_template(&rule.command_template, &variables)
        .map_err(|err| format!("rule {} template render failed: {err}", rule.id))?;
    Ok(Some((command, variables)))
}

fn evaluate_llm_rule<F>(
    rule: &LlmRule,
    input: &str,
    runtime_context: &RuleRuntimeContext,
    eval_llm: &mut F,
    logs: &mut Vec<String>,
) -> Result<RuleMatch, String>
where
    F: FnMut(&LlmRule, &str, &RuleRuntimeContext) -> Result<LlmRuleDecision, String>,
{
    let decision = eval_llm(rule, input, runtime_context)
        .map_err(|err| format!("rule {} llm evaluation failed: {err}", rule.id))?;
    logs.push(format!(
        "rule_result id={} type=llm match={} vars={}",
        rule.id,
        decision.matched,
        Value::Object(decision.variables.clone())
    ));
    if !decision.matched {
        return Ok(None);
    }
    let mut variables = context_variables(runtime_context);
    variables.extend(decision.variables);
    if let Some(command) = decision.command {
        variables.insert("command".to_string(), Value::String(command));
    }
    let rendered = render_command_template(&rule.command_template, &variables)
        .map_err(|err| format!("rule {} template render failed: {err}", rule.id))?;
    Ok(Some((rendered, variables)))
}

pub(super) fn evaluate_rules_in_order<F>(
    rule_file: &RuleFile,
    full_buffer: &str,
    visible_window: &str,
    runtime_context: &RuleRuntimeContext,
    eval_llm: &mut F,
) -> RuleExecutionSummary
where
    F: FnMut(&LlmRule, &str, &RuleRuntimeContext) -> Result<LlmRuleDecision, String>,
{
    let mut summary = RuleExecutionSummary::default();
    summary.logs.push(format!(
        "mode_loaded version={} rule_count={}",
        rule_file.version,
        rule_file.rules.len()
    ));

    for rule in &rule_file.rules {
        match rule {
            RuleDefinition::Regex(regex_rule) => {
                if !regex_rule.enabled {
                    summary
                        .logs
                        .push(format!("rule_skipped id={} reason=disabled", regex_rule.id));
                    continue;
                }
                let input = match regex_rule.input_scope {
                    InputScope::FullBuffer => full_buffer,
                    InputScope::VisibleWindow => visible_window,
                };
                summary.logs.push(format!(
                    "rule_start id={} type=regex scope={:?} input_len={}",
                    regex_rule.id,
                    regex_rule.input_scope,
                    input.len()
                ));
                match evaluate_regex_rule(regex_rule, input, runtime_context, &mut summary.logs) {
                    Ok(Some((command, variables))) => {
                        summary.logs.push(format!(
                            "rule_match id={} command={}",
                            regex_rule.id, command
                        ));
                        summary.matched_rule_id = Some(regex_rule.id.clone());
                        summary.variables = variables;
                        summary.command_to_send = Some(command);
                        break;
                    }
                    Ok(None) => {}
                    Err(err) => {
                        summary
                            .logs
                            .push(format!("rule_error id={} error={err}", regex_rule.id));
                    }
                }
            }
            RuleDefinition::Llm(llm_rule) => {
                if !llm_rule.enabled {
                    summary
                        .logs
                        .push(format!("rule_skipped id={} reason=disabled", llm_rule.id));
                    continue;
                }
                let input = match llm_rule.input_scope {
                    InputScope::FullBuffer => full_buffer,
                    InputScope::VisibleWindow => visible_window,
                };
                summary.logs.push(format!(
                    "rule_start id={} type=llm scope={:?} input_len={}",
                    llm_rule.id,
                    llm_rule.input_scope,
                    input.len()
                ));
                match evaluate_llm_rule(
                    llm_rule,
                    input,
                    runtime_context,
                    eval_llm,
                    &mut summary.logs,
                ) {
                    Ok(Some((command, variables))) => {
                        summary
                            .logs
                            .push(format!("rule_match id={} command={}", llm_rule.id, command));
                        summary.matched_rule_id = Some(llm_rule.id.clone());
                        summary.variables = variables;
                        summary.command_to_send = Some(command);
                        break;
                    }
                    Ok(None) => {}
                    Err(err) => {
                        summary
                            .logs
                            .push(format!("rule_error id={} error={err}", llm_rule.id));
                    }
                }
            }
        }
    }

    if summary.command_to_send.is_none() {
        summary.logs.push("cycle_end matched=false".to_string());
    } else {
        summary.logs.push("cycle_end matched=true".to_string());
    }
    summary
}
