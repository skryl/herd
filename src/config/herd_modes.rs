use crate::rules::default_rule_file_content;

use std::collections::HashSet;

use super::HerdModeDefinition;

pub(super) fn default_herd_modes() -> Vec<HerdModeDefinition> {
    vec![
        HerdModeDefinition {
            name: "Balanced".to_string(),
            rule_file: "herd_modes/balanced.json".to_string(),
        },
        HerdModeDefinition {
            name: "Conservative".to_string(),
            rule_file: "herd_modes/conservative.json".to_string(),
        },
        HerdModeDefinition {
            name: "Aggressive".to_string(),
            rule_file: "herd_modes/aggressive.json".to_string(),
        },
    ]
}

pub fn default_primary_herd_mode() -> HerdModeDefinition {
    default_herd_modes()
        .into_iter()
        .next()
        .unwrap_or(HerdModeDefinition {
            name: "Balanced".to_string(),
            rule_file: "herd_modes/balanced.json".to_string(),
        })
}

pub(super) fn sanitize_herd_modes(modes: Vec<HerdModeDefinition>) -> Vec<HerdModeDefinition> {
    let mut sanitized = modes
        .into_iter()
        .map(|mode| {
            let name = sanitize_mode_name(&mode.name);
            let rule_file = sanitize_rule_file(&mode.rule_file, &name);
            HerdModeDefinition { name, rule_file }
        })
        .collect::<Vec<_>>();
    sanitized.retain(|mode| !mode.name.trim().is_empty());
    if sanitized.is_empty() {
        return default_herd_modes();
    }
    sanitized
}

fn sanitize_mode_name(name: &str) -> String {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        "New Mode".to_string()
    } else {
        trimmed.to_string()
    }
}

fn sanitize_rule_file(rule_file: &str, name: &str) -> String {
    let candidate = rule_file.trim().replace('\\', "/");
    let file_name = if candidate.is_empty() {
        format!("{}.json", slugify(name))
    } else {
        let last = candidate.rsplit('/').next().unwrap_or_default().trim();
        if last.is_empty() {
            format!("{}.json", slugify(name))
        } else if last.ends_with(".json") {
            last.to_ascii_lowercase()
        } else if uses_legacy_markdown_rule_file(last) {
            format!("{}.json", slugify(name))
        } else {
            format!("{last}.json")
        }
    };
    format!("herd_modes/{file_name}")
}

pub(super) fn sanitize_text_list(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for value in values {
        let normalized = value.trim().to_ascii_lowercase();
        if normalized.is_empty() {
            continue;
        }
        if seen.insert(normalized.clone()) {
            out.push(normalized);
        }
    }
    out
}

fn slugify(value: &str) -> String {
    let mut slug = String::new();
    let mut prev_dash = false;
    for ch in value.chars() {
        let out = if ch.is_ascii_alphanumeric() {
            prev_dash = false;
            ch.to_ascii_lowercase()
        } else {
            if prev_dash {
                continue;
            }
            prev_dash = true;
            '-'
        };
        slug.push(out);
    }
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        "mode".to_string()
    } else {
        slug
    }
}

pub(super) fn uses_legacy_markdown_rule_file(path: &str) -> bool {
    let normalized = path.trim().to_ascii_lowercase();
    normalized.ends_with(".md") || normalized.ends_with(".markdown")
}

pub fn default_herd_mode_rule_file(name: &str) -> String {
    default_rule_file_content(name).unwrap_or_else(|_| {
        "{\"version\":1,\"rules\":[{\"id\":\"default_nudge\",\"type\":\"regex\",\"enabled\":true,\"input_scope\":\"full_buffer\",\"pattern\":\"(?s).*\",\"command_template\":\"Please continue until the task is fully complete.\"}]}"
            .to_string()
    })
}
