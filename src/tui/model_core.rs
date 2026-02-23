use std::collections::HashMap;
use std::path::Path;

use crate::config::{AppConfig, MAX_HERDS, default_primary_herd_mode};
use crate::herd::{DEFAULT_HERD_MODE_NAME, HerdRegistry};

use super::settings_io::hydrate_herd_mode_rules;
use super::{
    EditableHerdMode, EditableSettings, FocusPane, HerderLogEntry, InputMode, SettingsAction,
    SettingsOverlay, TmuxServerStatus, UiSession,
};

#[derive(Clone, Debug)]
pub struct AppModel {
    pub(super) sessions: Vec<UiSession>,
    pub(super) selected: usize,
    pub(super) focus: FocusPane,
    pub(super) input_mode: InputMode,
    pub(super) input_buffer: String,
    pub(super) submitted_input: Option<String>,
    pub(super) herd_count: u8,
    pub(super) herd_modes: Vec<String>,
    pub(super) selected_herd: u8,
    pub(super) content_scroll_overrides: HashMap<String, u16>,
    pub(super) content_viewport_height: u16,
    pub(super) herder_log_entries: Vec<HerderLogEntry>,
    pub(super) herder_log_filter: Option<u8>,
    pub(super) herder_log_scroll_override: Option<u16>,
    pub(super) herder_log_viewport_height: u16,
    pub(super) tmux_server_status: TmuxServerStatus,
    pub(super) status_message: Option<String>,
    pub(super) settings: EditableSettings,
    pub(super) settings_overlay: Option<SettingsOverlay>,
    pub(super) pending_settings_action: Option<SettingsAction>,
}

impl AppModel {
    pub fn new(sessions: Vec<UiSession>) -> Self {
        let defaults = AppConfig::default();
        let provider = defaults.normalized_provider().to_string();
        let mut default_modes = defaults
            .herd_modes
            .iter()
            .map(|mode| EditableHerdMode {
                name: mode.name.clone(),
                rule_file: mode.rule_file.clone(),
                rule_json: String::new(),
            })
            .collect::<Vec<_>>();
        if default_modes.is_empty() {
            let primary_mode = default_primary_herd_mode();
            default_modes.push(EditableHerdMode {
                name: primary_mode.name,
                rule_file: primary_mode.rule_file,
                rule_json: String::new(),
            });
        }
        let settings = EditableSettings {
            herd_count: defaults.normalized_herd_count(),
            openai_api_key: defaults.openai_api_key,
            anthropic_api_key: defaults.anthropic_api_key,
            llm_provider: provider,
            llm_model: defaults.llm_model,
            herd_modes: default_modes,
        };
        let herd_count = settings.herd_count.clamp(1, MAX_HERDS);
        let default_mode_name = settings
            .herd_modes
            .first()
            .map(|mode| mode.name.clone())
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_HERD_MODE_NAME.to_string());
        Self {
            sessions,
            selected: 0,
            focus: FocusPane::Sessions,
            input_mode: InputMode::Command,
            input_buffer: String::new(),
            submitted_input: None,
            herd_count,
            herd_modes: vec![default_mode_name; MAX_HERDS as usize],
            selected_herd: 0,
            content_scroll_overrides: HashMap::new(),
            content_viewport_height: 1,
            herder_log_entries: Vec::new(),
            herder_log_filter: None,
            herder_log_scroll_override: None,
            herder_log_viewport_height: 1,
            tmux_server_status: TmuxServerStatus::Online,
            status_message: None,
            settings,
            settings_overlay: None,
            pending_settings_action: None,
        }
    }

    pub fn selected_index(&self) -> usize {
        self.selected
    }

    pub fn focus(&self) -> FocusPane {
        self.focus
    }

    pub fn input_mode(&self) -> InputMode {
        self.input_mode
    }

    pub fn is_input_mode(&self) -> bool {
        self.input_mode == InputMode::Input
    }

    pub fn input_buffer(&self) -> &str {
        &self.input_buffer
    }

    pub fn take_submitted_input(&mut self) -> Option<String> {
        self.submitted_input.take()
    }

    pub(super) fn restore_unsent_input(&mut self, message: String) {
        self.input_mode = InputMode::Input;
        self.input_buffer = message;
        self.submitted_input = None;
    }

    pub(super) fn take_settings_action(&mut self) -> Option<SettingsAction> {
        self.pending_settings_action.take()
    }

    pub(super) fn load_settings(&mut self, config: &AppConfig, config_path: &Path) {
        self.settings = EditableSettings::from_config(config);
        hydrate_herd_mode_rules(&mut self.settings, config_path);
        self.set_herd_count(self.settings.herd_count);
        self.normalize_herd_mode_assignments();
    }

    pub(super) fn is_settings_overlay_open(&self) -> bool {
        self.settings_overlay.is_some()
    }

    pub fn selected_session(&self) -> Option<&UiSession> {
        self.sessions.get(self.selected)
    }

    pub fn selected_herd_state(&self) -> Option<(String, bool, Option<u8>)> {
        self.selected_session()
            .map(|session| (session.pane_id.clone(), session.herded, session.herd_id))
    }

    pub fn herd_mode(&self, herd_id: u8) -> &str {
        self.herd_modes
            .get(usize::from(herd_id.min(MAX_HERDS - 1)))
            .map(String::as_str)
            .unwrap_or(DEFAULT_HERD_MODE_NAME)
    }

    pub(super) fn herd_count(&self) -> u8 {
        self.herd_count.clamp(1, MAX_HERDS)
    }

    pub(super) fn max_herd_id(&self) -> u8 {
        self.herd_count().saturating_sub(1)
    }

    pub(super) fn herd_shortcut_range_label(&self) -> String {
        if self.max_herd_id() == 0 {
            "0".to_string()
        } else {
            format!("0-{}", self.max_herd_id())
        }
    }

    pub fn herd_counts(&self) -> [usize; MAX_HERDS as usize] {
        let mut counts = [0usize; MAX_HERDS as usize];
        for session in &self.sessions {
            if let Some(herd_id) = session.herd_id
                && usize::from(herd_id) < counts.len()
            {
                counts[usize::from(herd_id)] += 1;
            }
        }
        counts
    }

    pub fn active_herd(&self) -> u8 {
        if self.focus == FocusPane::Herds {
            return self.selected_herd.min(self.max_herd_id());
        }
        self.selected_session()
            .and_then(|session| session.herd_id)
            .unwrap_or(self.selected_herd)
            .min(self.max_herd_id())
    }

    pub fn load_herd_modes(&mut self, registry: &HerdRegistry) {
        for herd_id in 0..MAX_HERDS {
            self.herd_modes[usize::from(herd_id)] = registry.herd_mode(herd_id);
        }
        self.normalize_herd_mode_assignments();
    }

    pub fn sync_herd_registry(&self, registry: &mut HerdRegistry) {
        for herd_id in 0..MAX_HERDS {
            registry.set_herd_mode(herd_id, self.herd_mode(herd_id).to_string());
        }
        for session in &self.sessions {
            if session.herd_id.is_some() {
                registry.set_herd_group(&session.pane_id, session.herd_id);
            } else {
                registry.set_herded(&session.pane_id, session.herded);
            }
        }
    }

    pub fn content_scroll(&self) -> u16 {
        self.effective_content_scroll()
    }
}
