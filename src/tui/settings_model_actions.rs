use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

use crate::config::{ANTHROPIC_PROVIDER, DEFAULT_PROVIDER, normalize_provider};

use super::{AppModel, SettingsAction};

impl AppModel {
    pub(super) fn open_model_dropdown(&mut self) {
        let mut fetch_request: Option<(String, String)> = None;
        if let Some(overlay) = self.settings_overlay.as_mut() {
            overlay.model_dropdown_open = true;
            overlay.editing = false;
            overlay.edit_buffer.clear();
            overlay.model_dropdown_selected = overlay
                .available_models
                .iter()
                .position(|model| model == &overlay.draft.llm_model)
                .map(|index| index + 1)
                .unwrap_or(0);

            if overlay.available_models.is_empty() {
                let provider = normalize_provider(&overlay.draft.llm_provider).to_string();
                let api_key = match provider.as_str() {
                    ANTHROPIC_PROVIDER => overlay.draft.anthropic_api_key.trim().to_string(),
                    _ => overlay.draft.openai_api_key.trim().to_string(),
                };
                if !api_key.is_empty() {
                    overlay.fetch_status = Some(format!("Fetching {provider} models..."));
                    fetch_request = Some((provider, api_key));
                }
            }
        }

        if let Some((provider, api_key)) = fetch_request {
            self.pending_settings_action =
                Some(SettingsAction::RefreshModels { provider, api_key });
        }
    }

    pub(super) fn close_model_dropdown(&mut self) {
        if let Some(overlay) = self.settings_overlay.as_mut() {
            overlay.model_dropdown_open = false;
        }
    }

    pub(super) fn model_dropdown_len(&self) -> usize {
        self.settings_overlay
            .as_ref()
            .map(|overlay| overlay.available_models.len() + 1)
            .unwrap_or(1)
    }

    pub(super) fn begin_custom_model_edit(&mut self, initial: Option<char>) {
        let Some(overlay) = self.settings_overlay.as_mut() else {
            return;
        };
        overlay.model_dropdown_open = false;
        overlay.editing = true;
        overlay.edit_buffer.clear();
        if let Some(c) = initial {
            overlay.edit_buffer.push(c);
        } else {
            overlay.edit_buffer = overlay.draft.llm_model.clone();
        }
    }

    pub(super) fn select_model_from_dropdown(&mut self) {
        let Some(overlay) = self.settings_overlay.as_mut() else {
            return;
        };
        if overlay.model_dropdown_selected == 0 {
            return;
        }
        let model_index = overlay.model_dropdown_selected - 1;
        if let Some(model_name) = overlay.available_models.get(model_index) {
            overlay.draft.llm_model = model_name.clone();
        }
        overlay.model_dropdown_open = false;
    }

    pub(super) fn handle_model_dropdown_key(&mut self, key: KeyEvent) {
        if !self.is_model_dropdown_open() {
            return;
        }

        match key.code {
            KeyCode::Esc => self.close_model_dropdown(),
            KeyCode::Char('j') | KeyCode::Down => {
                let max_index = self.model_dropdown_len().saturating_sub(1);
                if let Some(overlay) = self.settings_overlay.as_mut() {
                    overlay.model_dropdown_selected =
                        (overlay.model_dropdown_selected + 1).min(max_index);
                }
            }
            KeyCode::Char('k') | KeyCode::Up => {
                if let Some(overlay) = self.settings_overlay.as_mut() {
                    overlay.model_dropdown_selected =
                        overlay.model_dropdown_selected.saturating_sub(1);
                }
            }
            KeyCode::Enter => {
                let selected_custom = self
                    .settings_overlay
                    .as_ref()
                    .is_some_and(|overlay| overlay.model_dropdown_selected == 0);
                if selected_custom {
                    self.begin_custom_model_edit(None);
                } else {
                    self.select_model_from_dropdown();
                }
            }
            KeyCode::Char(c)
                if !key
                    .modifiers
                    .intersects(KeyModifiers::ALT | KeyModifiers::CONTROL) =>
            {
                self.begin_custom_model_edit(Some(c));
            }
            _ => {}
        }
    }

    pub(super) fn request_overlay_model_refresh(&mut self) {
        let Some(overlay) = self.settings_overlay.as_mut() else {
            return;
        };
        let provider = normalize_provider(&overlay.draft.llm_provider).to_string();
        let api_key = match provider.as_str() {
            ANTHROPIC_PROVIDER => overlay.draft.anthropic_api_key.trim().to_string(),
            _ => overlay.draft.openai_api_key.trim().to_string(),
        };
        if api_key.is_empty() {
            overlay.fetch_status = Some(format!("Set a {} API key first", provider));
            return;
        }
        overlay.fetch_status = Some(format!("Fetching {provider} models..."));
        self.pending_settings_action = Some(SettingsAction::RefreshModels { provider, api_key });
    }

    pub(super) fn cycle_overlay_provider(&mut self, direction: i8) {
        let Some(overlay) = self.settings_overlay.as_mut() else {
            return;
        };
        let providers = [DEFAULT_PROVIDER, ANTHROPIC_PROVIDER];
        let current_index = providers
            .iter()
            .position(|provider| *provider == normalize_provider(&overlay.draft.llm_provider))
            .unwrap_or(0) as i8;
        let next_index = (current_index + direction).rem_euclid(providers.len() as i8) as usize;
        overlay.draft.llm_provider = providers[next_index].to_string();
        overlay.fetch_status = None;
    }
}
