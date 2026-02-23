use crate::config::{ANTHROPIC_PROVIDER, normalize_provider};
use crate::rules::LlmRuleDecision;

mod parsing;
mod provider_http;

use self::parsing::{
    mocked_model_list_from_env, parse_anthropic_message_text, parse_anthropic_model_ids,
    parse_openai_chat_content, parse_openai_model_ids,
};
use self::provider_http::{
    evaluate_rule_anthropic, evaluate_rule_openai, fetch_anthropic_models, fetch_openai_models,
};

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
