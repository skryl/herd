use serde_json::Value;

pub(super) fn parse_openai_model_ids(payload: &Value) -> Vec<String> {
    parse_model_array(payload.get("data"))
}

pub(super) fn parse_anthropic_model_ids(payload: &Value) -> Vec<String> {
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

pub(super) fn mocked_model_list_from_env() -> Option<Vec<String>> {
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

pub(super) fn parse_openai_chat_content(payload: &Value) -> Result<String, String> {
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

pub(super) fn parse_anthropic_message_text(payload: &Value) -> Result<String, String> {
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
