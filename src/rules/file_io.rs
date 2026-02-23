use std::fs;
use std::path::Path;

use super::{InputScope, LlmRule, RULE_FILE_VERSION, RegexRule, RuleDefinition, RuleFile};

pub fn load_rule_file(path: &Path) -> Result<RuleFile, String> {
    let raw = fs::read_to_string(path)
        .map_err(|err| format!("failed reading rule file {:?}: {err}", path))?;
    serde_json::from_str::<RuleFile>(&raw)
        .map_err(|err| format!("failed parsing rule file {:?}: {err}", path))
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
