use crate::rules::{LlmRuleDecision, parse_llm_decision_json};
use serde_json::{Value, json};

use super::{
    parse_anthropic_message_text, parse_anthropic_model_ids, parse_openai_chat_content,
    parse_openai_model_ids,
};

pub(super) fn fetch_openai_models(api_key: &str) -> Result<Vec<String>, String> {
    let response = ureq::get("https://api.openai.com/v1/models")
        .set("Authorization", &format!("Bearer {api_key}"))
        .set("Accept", "application/json")
        .call()
        .map_err(|err| format!("openai model fetch failed: {err}"))?;
    let payload: Value = response
        .into_json()
        .map_err(|err| format!("openai model response parse failed: {err}"))?;
    let models = parse_openai_model_ids(&payload);
    if models.is_empty() {
        return Err("openai returned no models".to_string());
    }
    Ok(models)
}

pub(super) fn fetch_anthropic_models(api_key: &str) -> Result<Vec<String>, String> {
    let response = ureq::get("https://api.anthropic.com/v1/models")
        .set("x-api-key", api_key)
        .set("anthropic-version", "2023-06-01")
        .set("Accept", "application/json")
        .call()
        .map_err(|err| format!("anthropic model fetch failed: {err}"))?;
    let payload: Value = response
        .into_json()
        .map_err(|err| format!("anthropic model response parse failed: {err}"))?;
    let models = parse_anthropic_model_ids(&payload);
    if models.is_empty() {
        return Err("anthropic returned no models".to_string());
    }
    Ok(models)
}

pub(super) fn evaluate_rule_openai(
    api_key: &str,
    model: &str,
    rule_prompt: &str,
    input_text: &str,
) -> Result<LlmRuleDecision, String> {
    let response = ureq::post("https://api.openai.com/v1/chat/completions")
        .set("Authorization", &format!("Bearer {api_key}"))
        .set("Accept", "application/json")
        .set("Content-Type", "application/json")
        .send_json(json!({
            "model": model,
            "temperature": 0,
            "response_format": {"type": "json_object"},
            "messages": [
                {
                    "role": "system",
                    "content": "You are a rule evaluator. Respond with strict JSON object only: {\"match\":boolean,\"command\":string?,\"variables\":object?}."
                },
                {
                    "role": "user",
                    "content": format!("Rule:\n{rule_prompt}\n\nInput:\n{input_text}")
                }
            ]
        }))
        .map_err(|err| format!("openai llm rule evaluation failed: {err}"))?;
    let payload: Value = response
        .into_json()
        .map_err(|err| format!("openai llm response parse failed: {err}"))?;
    let content = parse_openai_chat_content(&payload)?;
    parse_llm_decision_json(&content)
}

pub(super) fn evaluate_rule_anthropic(
    api_key: &str,
    model: &str,
    rule_prompt: &str,
    input_text: &str,
) -> Result<LlmRuleDecision, String> {
    let response = ureq::post("https://api.anthropic.com/v1/messages")
        .set("x-api-key", api_key)
        .set("anthropic-version", "2023-06-01")
        .set("Accept", "application/json")
        .set("Content-Type", "application/json")
        .send_json(json!({
            "model": model,
            "max_tokens": 512,
            "temperature": 0,
            "system": "You are a rule evaluator. Respond with strict JSON object only: {\"match\":boolean,\"command\":string?,\"variables\":object?}.",
            "messages": [
                {
                    "role": "user",
                    "content": format!("Rule:\n{rule_prompt}\n\nInput:\n{input_text}")
                }
            ]
        }))
        .map_err(|err| format!("anthropic llm rule evaluation failed: {err}"))?;
    let payload: Value = response
        .into_json()
        .map_err(|err| format!("anthropic llm response parse failed: {err}"))?;
    let content = parse_anthropic_message_text(&payload)?;
    parse_llm_decision_json(&content)
}
