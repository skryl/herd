use regex::{Captures, Regex};
use serde_json::Value;

use super::BoundVariables;

fn string_from_value(value: &Value) -> String {
    if let Some(as_str) = value.as_str() {
        as_str.to_string()
    } else {
        value.to_string()
    }
}

pub fn render_command_template(
    template: &str,
    variables: &BoundVariables,
) -> Result<String, String> {
    let placeholder_re = Regex::new(r"\{([a-zA-Z0-9_]+)\}")
        .map_err(|err| format!("invalid placeholder regex: {err}"))?;
    let mut missing = Vec::new();
    for captures in placeholder_re.captures_iter(template) {
        let key = captures
            .get(1)
            .map(|capture| capture.as_str())
            .unwrap_or_default();
        if key.is_empty() {
            continue;
        }
        if !variables.contains_key(key) && !missing.iter().any(|existing| existing == key) {
            missing.push(key.to_string());
        }
    }
    if !missing.is_empty() {
        return Err(format!(
            "missing template variables: {}",
            missing.join(", ")
        ));
    }

    let rendered = placeholder_re.replace_all(template, |captures: &Captures<'_>| {
        let key = captures
            .get(1)
            .map(|capture| capture.as_str())
            .unwrap_or_default();
        variables
            .get(key)
            .map(string_from_value)
            .unwrap_or_default()
    });
    Ok(rendered.into_owned())
}
