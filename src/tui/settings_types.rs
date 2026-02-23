use crate::config::{
    AppConfig, HerdModeDefinition, MAX_HERDS, default_primary_herd_mode, normalize_provider,
};

use super::settings_io::default_herd_mode_rule_text;

#[derive(Clone, Debug, Default)]
pub(super) struct EditableHerdMode {
    pub(super) name: String,
    pub(super) rule_file: String,
    pub(super) rule_json: String,
}

#[derive(Clone, Debug, Default)]
pub(super) struct EditableSettings {
    pub(super) herd_count: u8,
    pub(super) openai_api_key: String,
    pub(super) anthropic_api_key: String,
    pub(super) llm_provider: String,
    pub(super) llm_model: String,
    pub(super) herd_modes: Vec<EditableHerdMode>,
}

impl EditableSettings {
    pub(super) fn from_config(config: &AppConfig) -> Self {
        Self {
            herd_count: config.normalized_herd_count(),
            openai_api_key: config.openai_api_key.clone(),
            anthropic_api_key: config.anthropic_api_key.clone(),
            llm_provider: config.normalized_provider().to_string(),
            llm_model: config.llm_model.clone(),
            herd_modes: config
                .herd_modes
                .iter()
                .map(|mode| EditableHerdMode {
                    name: mode.name.clone(),
                    rule_file: mode.rule_file.clone(),
                    rule_json: String::new(),
                })
                .collect(),
        }
    }

    pub(super) fn apply_to_config(&self, config: &mut AppConfig) {
        config.herd_count = self.herd_count.clamp(1, MAX_HERDS);
        config.openai_api_key = self.openai_api_key.clone();
        config.anthropic_api_key = self.anthropic_api_key.clone();
        config.llm_provider = normalize_provider(&self.llm_provider).to_string();
        config.llm_model = self.llm_model.clone();
        config.herd_modes = self
            .herd_modes
            .iter()
            .map(|mode| HerdModeDefinition {
                name: mode.name.trim().to_string(),
                rule_file: mode.rule_file.trim().to_string(),
            })
            .filter(|mode| !mode.name.is_empty() && !mode.rule_file.is_empty())
            .collect();
        if config.herd_modes.is_empty() {
            config.herd_modes.push(default_primary_herd_mode());
        }
    }
}

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub(super) enum SettingsField {
    HerdCount,
    OpenAiKey,
    AnthropicKey,
    Provider,
    Model,
    RefreshModels,
    HerdModeSelection,
    HerdModeName,
    HerdModeFile,
    HerdModePrompt,
    HerdModeAdd,
    HerdModeRemove,
    Save,
}

impl SettingsField {
    pub(super) fn from_index(index: usize) -> Self {
        match index {
            0 => Self::HerdCount,
            1 => Self::OpenAiKey,
            2 => Self::AnthropicKey,
            3 => Self::Provider,
            4 => Self::Model,
            5 => Self::RefreshModels,
            6 => Self::HerdModeSelection,
            7 => Self::HerdModeName,
            8 => Self::HerdModeFile,
            9 => Self::HerdModePrompt,
            10 => Self::HerdModeAdd,
            11 => Self::HerdModeRemove,
            _ => Self::Save,
        }
    }

    pub(super) fn max_index() -> usize {
        12
    }

    pub(super) fn is_text(self) -> bool {
        matches!(
            self,
            Self::HerdCount | Self::OpenAiKey | Self::AnthropicKey | Self::HerdModeName
        )
    }
}

#[derive(Clone, Debug)]
pub(super) struct SettingsOverlay {
    pub(super) selected: usize,
    pub(super) editing: bool,
    pub(super) edit_buffer: String,
    pub(super) draft: EditableSettings,
    pub(super) available_models: Vec<String>,
    pub(super) model_dropdown_open: bool,
    pub(super) model_dropdown_selected: usize,
    pub(super) selected_herd_mode: usize,
    pub(super) herd_mode_prompt_editor_open: bool,
    pub(super) herd_mode_prompt_buffer: String,
    pub(super) fetch_status: Option<String>,
}

impl SettingsOverlay {
    pub(super) fn from_settings(settings: &EditableSettings) -> Self {
        let mut draft = settings.clone();
        if draft.herd_modes.is_empty() {
            draft.herd_modes.push(EditableHerdMode {
                name: "Balanced".to_string(),
                rule_file: "herd_modes/balanced.json".to_string(),
                rule_json: default_herd_mode_rule_text("Balanced"),
            });
        }
        Self {
            selected: 0,
            editing: false,
            edit_buffer: String::new(),
            draft,
            available_models: Vec::new(),
            model_dropdown_open: false,
            model_dropdown_selected: 0,
            selected_herd_mode: 0,
            herd_mode_prompt_editor_open: false,
            herd_mode_prompt_buffer: String::new(),
            fetch_status: None,
        }
    }

    pub(super) fn selected_field(&self) -> SettingsField {
        SettingsField::from_index(self.selected.min(SettingsField::max_index()))
    }
}

#[derive(Clone, Debug)]
pub(super) enum SettingsAction {
    RefreshModels { provider: String, api_key: String },
    Save(EditableSettings),
}
