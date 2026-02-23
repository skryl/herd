use crate::config::{MAX_HERDS, normalize_provider};

use super::settings_io::suggest_herd_mode_file;
use super::{AppModel, SettingsAction, SettingsField};

impl AppModel {
    pub(super) fn save_overlay_settings(&mut self) {
        let Some(overlay) = self.settings_overlay.take() else {
            return;
        };
        self.settings = overlay.draft;
        self.settings.llm_provider = normalize_provider(&self.settings.llm_provider).to_string();
        self.settings.herd_count = self.settings.herd_count.clamp(1, MAX_HERDS);
        self.set_herd_count(self.settings.herd_count);
        self.normalize_herd_mode_assignments();
        self.pending_settings_action = Some(SettingsAction::Save(self.settings.clone()));
    }

    pub(super) fn begin_overlay_edit(&mut self) {
        let Some(overlay) = self.settings_overlay.as_mut() else {
            return;
        };
        if overlay.selected_field().is_text() {
            overlay.editing = true;
            overlay.edit_buffer = match overlay.selected_field() {
                SettingsField::HerdCount => overlay.draft.herd_count.to_string(),
                SettingsField::OpenAiKey => overlay.draft.openai_api_key.clone(),
                SettingsField::AnthropicKey => overlay.draft.anthropic_api_key.clone(),
                SettingsField::HerdModeName => overlay
                    .draft
                    .herd_modes
                    .get(overlay.selected_herd_mode)
                    .map(|mode| mode.name.clone())
                    .unwrap_or_default(),
                _ => String::new(),
            };
        }
    }

    pub(super) fn commit_overlay_edit(&mut self) {
        let Some(overlay) = self.settings_overlay.as_mut() else {
            return;
        };
        if !overlay.editing {
            return;
        }

        match overlay.selected_field() {
            SettingsField::HerdCount => {
                if let Ok(value) = overlay.edit_buffer.trim().parse::<u8>() {
                    overlay.draft.herd_count = value.clamp(1, MAX_HERDS);
                } else {
                    overlay.fetch_status =
                        Some("Herd count must be a number between 1 and 10".to_string());
                }
            }
            SettingsField::OpenAiKey => {
                overlay.draft.openai_api_key = overlay.edit_buffer.trim().to_string();
            }
            SettingsField::AnthropicKey => {
                overlay.draft.anthropic_api_key = overlay.edit_buffer.trim().to_string();
            }
            SettingsField::HerdModeName => {
                let new_name = overlay.edit_buffer.trim().to_string();
                if new_name.is_empty() {
                    overlay.fetch_status = Some("Herd mode name cannot be empty".to_string());
                } else {
                    let selected_mode = overlay.selected_herd_mode;
                    let current_file = overlay
                        .draft
                        .herd_modes
                        .get(selected_mode)
                        .map(|mode| mode.rule_file.clone())
                        .unwrap_or_default();
                    let suggested = suggest_herd_mode_file(
                        &new_name,
                        &overlay.draft.herd_modes,
                        Some(selected_mode),
                    );
                    if let Some(mode) = Self::selected_editable_herd_mode_mut(overlay) {
                        mode.name = new_name;
                        if current_file.starts_with("herd_modes/") {
                            mode.rule_file = suggested;
                        }
                    }
                }
            }
            _ => {}
        }
        overlay.editing = false;
        overlay.edit_buffer.clear();
    }

    pub(super) fn cancel_overlay_edit(&mut self) {
        if let Some(overlay) = self.settings_overlay.as_mut() {
            overlay.editing = false;
            overlay.edit_buffer.clear();
        }
    }
}
