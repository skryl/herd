use crate::config::{ANTHROPIC_PROVIDER, normalize_provider};
use crate::rules::{LlmRuleDecision, parse_llm_decision_json};
use serde_json::{Value, json};

pub fn fetch_models(provider: &str, api_key: &str) -> Result<Vec<String>, String> {
    if let Some(models) = mocked_model_list_from_env() {
        return Ok(models);
    }

    let key = api_key.trim();
    if key.is_empty() {
        return Err("missing API key for selected provider".to_string());
    }

    match normalize_provider(provider) {
        ANTHROPIC_PROVIDER => fetch_anthropic_models(key),
        _ => fetch_openai_models(key),
    }
}

pub fn evaluate_rule(
    provider: &str,
    api_key: &str,
    model: &str,
    rule_prompt: &str,
    input_text: &str,
) -> Result<LlmRuleDecision, String> {
    let key = api_key.trim();
    if key.is_empty() {
        return Err("missing API key for selected provider".to_string());
    }
    let model = model.trim();
    if model.is_empty() {
        return Err("missing model for selected provider".to_string());
    }

    match normalize_provider(provider) {
        ANTHROPIC_PROVIDER => evaluate_rule_anthropic(key, model, rule_prompt, input_text),
        _ => evaluate_rule_openai(key, model, rule_prompt, input_text),
    }
}

fn fetch_openai_models(api_key: &str) -> Result<Vec<String>, String> {
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

fn fetch_anthropic_models(api_key: &str) -> Result<Vec<String>, String> {
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

fn evaluate_rule_openai(
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

fn evaluate_rule_anthropic(
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

fn parse_openai_model_ids(payload: &Value) -> Vec<String> {
    parse_model_array(payload.get("data"))
}

fn parse_anthropic_model_ids(payload: &Value) -> Vec<String> {
    parse_model_array(payload.get("data"))
}

fn parse_model_array(value: Option<&Value>) -> Vec<String> {
    let mut models = value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("id"))
        .filter_map(Value::as_str)
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    models.sort();
    models.dedup();
    models
}

fn mocked_model_list_from_env() -> Option<Vec<String>> {
    let raw = std::env::var("HERD_MODEL_FETCH_FIXTURE").ok()?;
    let mut models = raw
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    if models.is_empty() {
        return None;
    }
    models.sort();
    models.dedup();
    Some(models)
}

fn parse_openai_chat_content(payload: &Value) -> Result<String, String> {
    let content = payload
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .ok_or_else(|| "openai response missing choices[0].message.content".to_string())?;
    if content.trim().is_empty() {
        return Err("openai response content was empty".to_string());
    }
    Ok(content)
}

fn parse_anthropic_message_text(payload: &Value) -> Result<String, String> {
    let content = payload
        .get("content")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(|item| item.get("text"))
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .ok_or_else(|| "anthropic response missing content[0].text".to_string())?;
    if content.trim().is_empty() {
        return Err("anthropic response content was empty".to_string());
    }
    Ok(content)
}

#[cfg(test)]
mod tests {
    use super::{
        mocked_model_list_from_env, parse_anthropic_message_text, parse_anthropic_model_ids,
        parse_openai_chat_content, parse_openai_model_ids,
    };
    use serde_json::json;

    #[test]
    fn parse_openai_models_extracts_ids() {
        let payload = json!({
            "object": "list",
            "data": [
                {"id": "gpt-4.1"},
                {"id": "gpt-4.1-mini"},
                {"id": "gpt-4.1-mini"}
            ]
        });
        assert_eq!(
            parse_openai_model_ids(&payload),
            vec!["gpt-4.1".to_string(), "gpt-4.1-mini".to_string()]
        );
    }

    #[test]
    fn parse_anthropic_models_extracts_ids() {
        let payload = json!({
            "data": [
                {"id": "claude-3-5-sonnet-latest"},
                {"id": "claude-3-7-sonnet-latest"}
            ]
        });
        assert_eq!(
            parse_anthropic_model_ids(&payload),
            vec![
                "claude-3-5-sonnet-latest".to_string(),
                "claude-3-7-sonnet-latest".to_string()
            ]
        );
    }

    #[test]
    fn parse_openai_chat_extracts_content() {
        let payload = json!({
            "choices":[
                {"message":{"content":"{\"match\":true}"}}
            ]
        });
        let content = parse_openai_chat_content(&payload).expect("should parse");
        assert_eq!(content, "{\"match\":true}");
    }

    #[test]
    fn parse_anthropic_message_extracts_text() {
        let payload = json!({
            "content":[
                {"type":"text", "text":"{\"match\":false}"}
            ]
        });
        let content = parse_anthropic_message_text(&payload).expect("should parse");
        assert_eq!(content, "{\"match\":false}");
    }

    #[test]
    fn mocked_model_list_from_env_parses_and_deduplicates() {
        // SAFETY: tests in this module are single-threaded enough for env mutation.
        unsafe {
            std::env::set_var("HERD_MODEL_FETCH_FIXTURE", "gpt-4.1, gpt-4.1-mini, gpt-4.1");
        }
        let models = mocked_model_list_from_env().expect("fixture models should parse");
        assert_eq!(
            models,
            vec!["gpt-4.1".to_string(), "gpt-4.1-mini".to_string()]
        );
        // SAFETY: paired cleanup for test env override.
        unsafe {
            std::env::remove_var("HERD_MODEL_FETCH_FIXTURE");
        }
    }
}
