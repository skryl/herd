use std::fs;
use std::path::{Path, PathBuf};

use crate::config::default_herd_mode_rule_file;

use super::{EditableHerdMode, EditableSettings};

pub(super) fn hydrate_herd_mode_rules(settings: &mut EditableSettings, settings_path: &Path) {
    if settings.herd_modes.is_empty() {
        settings.herd_modes.push(EditableHerdMode {
            name: "Balanced".to_string(),
            rule_file: "herd_modes/balanced.json".to_string(),
            rule_json: default_herd_mode_rule_text("Balanced"),
        });
    }

    let root = settings_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    for mode in &mut settings.herd_modes {
        let prompt_path = root.join(&mode.rule_file);
        mode.rule_json = fs::read_to_string(&prompt_path)
            .unwrap_or_else(|_| default_herd_mode_rule_text(&mode.name));
    }
}

pub(super) fn write_herd_mode_rule_files(
    settings: &EditableSettings,
    settings_path: &Path,
) -> Result<(), String> {
    let root = settings_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    for mode in &settings.herd_modes {
        let prompt_path = root.join(&mode.rule_file);
        if let Some(parent) = prompt_path.parent() {
            fs::create_dir_all(parent).map_err(|err| {
                format!(
                    "failed creating herd mode rule directory {:?}: {err}",
                    parent
                )
            })?;
        }
        let content = if mode.rule_json.trim().is_empty() {
            default_herd_mode_rule_text(&mode.name)
        } else {
            mode.rule_json.clone()
        };
        fs::write(&prompt_path, content)
            .map_err(|err| format!("failed writing herd mode rule {:?}: {err}", prompt_path))?;
    }
    Ok(())
}

pub(super) fn suggest_herd_mode_file(
    name: &str,
    existing: &[EditableHerdMode],
    ignore_index: Option<usize>,
) -> String {
    let base = mode_slug(name);
    let mut index = 1usize;
    loop {
        let suffix = if index == 1 {
            String::new()
        } else {
            format!("-{index}")
        };
        let candidate = format!("herd_modes/{}{}.json", base, suffix);
        if !existing
            .iter()
            .enumerate()
            .any(|(pos, mode)| Some(pos) != ignore_index && mode.rule_file == candidate)
        {
            return candidate;
        }
        index += 1;
    }
}

pub(super) fn default_herd_mode_rule_text(name: &str) -> String {
    default_herd_mode_rule_file(name)
}

fn mode_slug(value: &str) -> String {
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
