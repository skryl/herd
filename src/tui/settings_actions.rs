use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

use crate::config::{ANTHROPIC_PROVIDER, normalize_provider};

use super::{AppModel, SettingsAction, SettingsField, SettingsOverlay};

impl AppModel {
    pub(super) fn open_settings_overlay(&mut self) {
        self.settings_overlay = Some(SettingsOverlay::from_settings(&self.settings));
        if let Some(overlay) = self.settings_overlay.as_mut() {
            let provider = normalize_provider(&overlay.draft.llm_provider).to_string();
            let api_key = match provider.as_str() {
                ANTHROPIC_PROVIDER => overlay.draft.anthropic_api_key.trim().to_string(),
                _ => overlay.draft.openai_api_key.trim().to_string(),
            };
            if !api_key.is_empty() {
                overlay.fetch_status = Some(format!("Fetching {provider} models..."));
                self.pending_settings_action =
                    Some(SettingsAction::RefreshModels { provider, api_key });
            }
        }
    }

    pub(super) fn is_model_dropdown_open(&self) -> bool {
        self.settings_overlay
            .as_ref()
            .is_some_and(|overlay| overlay.model_dropdown_open)
    }

    pub(super) fn is_herd_mode_prompt_editor_open(&self) -> bool {
        self.settings_overlay
            .as_ref()
            .is_some_and(|overlay| overlay.herd_mode_prompt_editor_open)
    }

    pub(super) fn apply_model_fetch_result(&mut self, mut models: Vec<String>) {
        let Some(overlay) = self.settings_overlay.as_mut() else {
            return;
        };
        models.sort();
        models.dedup();
        if models.is_empty() {
            overlay.fetch_status = Some("No models returned by provider".to_string());
            return;
        }
        if overlay.draft.llm_model.trim().is_empty() {
            overlay.draft.llm_model = models[0].clone();
        }
        overlay.available_models = models;
        overlay.model_dropdown_selected = overlay
            .available_models
            .iter()
            .position(|model| model == &overlay.draft.llm_model)
            .map(|index| index + 1)
            .unwrap_or(0);
        overlay.fetch_status = Some("Model list updated".to_string());
    }

    pub(super) fn apply_model_fetch_error(&mut self, error: impl Into<String>) {
        if let Some(overlay) = self.settings_overlay.as_mut() {
            overlay.fetch_status = Some(error.into());
        }
    }

    pub(super) fn handle_settings_key(&mut self, key: KeyEvent) {
        if self.settings_overlay.is_none() {
            return;
        }

        if self.is_model_dropdown_open() {
            self.handle_model_dropdown_key(key);
            return;
        }

        if self.is_herd_mode_prompt_editor_open() {
            self.handle_herd_mode_prompt_editor_key(key);
            return;
        }

        if self
            .settings_overlay
            .as_ref()
            .is_some_and(|overlay| overlay.editing)
        {
            match key.code {
                KeyCode::Esc => self.cancel_overlay_edit(),
                KeyCode::Enter => self.commit_overlay_edit(),
                KeyCode::Backspace => {
                    if let Some(overlay) = self.settings_overlay.as_mut() {
                        overlay.edit_buffer.pop();
                    }
                }
                KeyCode::Char(c)
                    if !key
                        .modifiers
                        .intersects(KeyModifiers::ALT | KeyModifiers::CONTROL) =>
                {
                    if let Some(overlay) = self.settings_overlay.as_mut() {
                        overlay.edit_buffer.push(c);
                    }
                }
                _ => {}
            }
            return;
        }

        match key.code {
            KeyCode::Esc => {
                self.settings_overlay = None;
            }
            KeyCode::Char('j') | KeyCode::Down => {
                if let Some(overlay) = self.settings_overlay.as_mut() {
                    overlay.selected = (overlay.selected + 1).min(SettingsField::max_index());
                }
            }
            KeyCode::Char('k') | KeyCode::Up => {
                if let Some(overlay) = self.settings_overlay.as_mut() {
                    overlay.selected = overlay.selected.saturating_sub(1);
                }
            }
            KeyCode::Char('i') => {
                if self.settings_overlay.as_ref().is_some_and(|overlay| {
                    overlay.selected_field() == SettingsField::HerdModePrompt
                }) {
                    self.open_herd_mode_prompt_editor();
                } else {
                    self.begin_overlay_edit();
                }
            }
            KeyCode::Char('s') => self.save_overlay_settings(),
            KeyCode::Char('r') => self.request_overlay_model_refresh(),
            KeyCode::Char('h') | KeyCode::Left => {
                if let Some(field) = self
                    .settings_overlay
                    .as_ref()
                    .map(SettingsOverlay::selected_field)
                {
                    match field {
                        SettingsField::Provider => self.cycle_overlay_provider(-1),
                        SettingsField::Model => self.open_model_dropdown(),
                        SettingsField::HerdModeSelection => self.cycle_overlay_herd_mode(-1),
                        _ => {}
                    }
                }
            }
            KeyCode::Char('l') | KeyCode::Right => {
                if let Some(field) = self
                    .settings_overlay
                    .as_ref()
                    .map(SettingsOverlay::selected_field)
                {
                    match field {
                        SettingsField::Provider => self.cycle_overlay_provider(1),
                        SettingsField::Model => self.open_model_dropdown(),
                        SettingsField::HerdModeSelection => self.cycle_overlay_herd_mode(1),
                        _ => {}
                    }
                }
            }
            KeyCode::Enter => {
                if let Some(field) = self
                    .settings_overlay
                    .as_ref()
                    .map(SettingsOverlay::selected_field)
                {
                    match field {
                        SettingsField::HerdCount
                        | SettingsField::OpenAiKey
                        | SettingsField::AnthropicKey
                        | SettingsField::HerdModeName => self.begin_overlay_edit(),
                        SettingsField::Model => self.open_model_dropdown(),
                        SettingsField::Provider => self.cycle_overlay_provider(1),
                        SettingsField::RefreshModels => self.request_overlay_model_refresh(),
                        SettingsField::HerdModeSelection => self.cycle_overlay_herd_mode(1),
                        SettingsField::HerdModePrompt => self.open_herd_mode_prompt_editor(),
                        SettingsField::HerdModeAdd => self.add_overlay_herd_mode(),
                        SettingsField::HerdModeRemove => self.remove_overlay_herd_mode(),
                        SettingsField::HerdModeFile => {}
                        SettingsField::Save => self.save_overlay_settings(),
                    }
                }
            }
            _ => {}
        }
    }
}
