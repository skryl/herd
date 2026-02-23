use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

use super::settings_io::{default_herd_mode_rule_text, suggest_herd_mode_file};
use super::{AppModel, EditableHerdMode, SettingsOverlay};

impl AppModel {
    pub(super) fn selected_editable_herd_mode(
        overlay: &SettingsOverlay,
    ) -> Option<&EditableHerdMode> {
        overlay.draft.herd_modes.get(overlay.selected_herd_mode)
    }

    pub(super) fn selected_editable_herd_mode_mut(
        overlay: &mut SettingsOverlay,
    ) -> Option<&mut EditableHerdMode> {
        overlay.draft.herd_modes.get_mut(overlay.selected_herd_mode)
    }

    pub(super) fn cycle_overlay_herd_mode(&mut self, direction: i8) {
        let Some(overlay) = self.settings_overlay.as_mut() else {
            return;
        };
        if overlay.draft.herd_modes.is_empty() {
            return;
        }
        let len = overlay.draft.herd_modes.len() as i8;
        let next = (overlay.selected_herd_mode as i8 + direction).rem_euclid(len);
        overlay.selected_herd_mode = next as usize;
    }

    pub(super) fn add_overlay_herd_mode(&mut self) {
        let Some(overlay) = self.settings_overlay.as_mut() else {
            return;
        };
        let next_index = overlay.draft.herd_modes.len() + 1;
        let name = format!("Mode {next_index}");
        let file = suggest_herd_mode_file(&name, &overlay.draft.herd_modes, None);
        overlay.draft.herd_modes.push(EditableHerdMode {
            name: name.clone(),
            rule_file: file,
            rule_json: default_herd_mode_rule_text(&name),
        });
        overlay.selected_herd_mode = overlay.draft.herd_modes.len().saturating_sub(1);
    }

    pub(super) fn remove_overlay_herd_mode(&mut self) {
        let Some(overlay) = self.settings_overlay.as_mut() else {
            return;
        };
        if overlay.draft.herd_modes.len() <= 1 {
            overlay.fetch_status = Some("At least one herd mode is required".to_string());
            return;
        }
        let remove_index = overlay
            .selected_herd_mode
            .min(overlay.draft.herd_modes.len().saturating_sub(1));
        overlay.draft.herd_modes.remove(remove_index);
        overlay.selected_herd_mode = overlay
            .selected_herd_mode
            .min(overlay.draft.herd_modes.len().saturating_sub(1));
    }

    pub(super) fn open_herd_mode_prompt_editor(&mut self) {
        let Some(overlay) = self.settings_overlay.as_mut() else {
            return;
        };
        let prompt = Self::selected_editable_herd_mode(overlay)
            .map(|mode| mode.rule_json.clone())
            .unwrap_or_default();
        if !prompt.is_empty() || !overlay.draft.herd_modes.is_empty() {
            overlay.herd_mode_prompt_editor_open = true;
            overlay.herd_mode_prompt_buffer = prompt;
            overlay.editing = false;
            overlay.edit_buffer.clear();
        }
    }

    pub(super) fn close_herd_mode_prompt_editor(&mut self) {
        if let Some(overlay) = self.settings_overlay.as_mut() {
            overlay.herd_mode_prompt_editor_open = false;
            overlay.herd_mode_prompt_buffer.clear();
        }
    }

    pub(super) fn save_herd_mode_prompt_editor(&mut self) {
        let Some(overlay) = self.settings_overlay.as_mut() else {
            return;
        };
        let updated_prompt = overlay.herd_mode_prompt_buffer.clone();
        if let Some(mode) = Self::selected_editable_herd_mode_mut(overlay) {
            mode.rule_json = updated_prompt;
        }
        overlay.herd_mode_prompt_editor_open = false;
        overlay.herd_mode_prompt_buffer.clear();
    }

    pub(super) fn handle_herd_mode_prompt_editor_key(&mut self, key: KeyEvent) {
        if !self.is_herd_mode_prompt_editor_open() {
            return;
        }

        match key.code {
            KeyCode::Esc => self.close_herd_mode_prompt_editor(),
            KeyCode::Enter => {
                if let Some(overlay) = self.settings_overlay.as_mut() {
                    overlay.herd_mode_prompt_buffer.push('\n');
                }
            }
            KeyCode::Backspace => {
                if let Some(overlay) = self.settings_overlay.as_mut() {
                    overlay.herd_mode_prompt_buffer.pop();
                }
            }
            KeyCode::Tab => {
                if let Some(overlay) = self.settings_overlay.as_mut() {
                    overlay.herd_mode_prompt_buffer.push('\t');
                }
            }
            KeyCode::Char('s') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.save_herd_mode_prompt_editor();
            }
            KeyCode::Char(c)
                if !key
                    .modifiers
                    .intersects(KeyModifiers::ALT | KeyModifiers::CONTROL) =>
            {
                if let Some(overlay) = self.settings_overlay.as_mut() {
                    overlay.herd_mode_prompt_buffer.push(c);
                }
            }
            _ => {}
        }
    }
}
