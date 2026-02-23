use std::collections::HashMap;
use std::path::Path;

use crate::agent::{AgentStatus, ProcessAssessment};
use crate::config::{AppConfig, MAX_HERDS, default_primary_herd_mode};
use crate::domain::SessionRef;
use crate::herd::{DEFAULT_HERD_MODE_NAME, HerdRegistry};
use crate::tmux::TmuxAdapter;
use render_surface::render_to_string as render_to_string_surface;
use runtime_loop::{
    dispatch_submitted_input_to_selected_pane as dispatch_submitted_input_to_selected_pane_inner,
    run_tui as run_tui_inner,
};
use settings_io::hydrate_herd_mode_rules;
use settings_types::{
    EditableHerdMode, EditableSettings, SettingsAction, SettingsField, SettingsOverlay,
};

mod interaction_state;
mod key_handling;
mod log_status_state;
mod render_helpers;
mod render_left_panes;
mod render_right_panes;
mod render_sections;
mod render_surface;
mod render_text_utils;
mod runtime;
mod runtime_loop;
mod runtime_refresh;
mod runtime_rules;
mod runtime_sessions;
mod settings_actions;
mod settings_edit_actions;
mod settings_herd_mode_actions;
mod settings_io;
mod settings_model_actions;
mod settings_render;
mod settings_types;
mod state_navigation;

const HERDER_LOG_MAX_LINES: usize = 10_000;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UiSession {
    pub session_name: String,
    pub window_index: i64,
    pub window_name: String,
    pub pane_id: String,
    pub pane_index: i64,
    pub current_command: String,
    pub agent_name: String,
    pub highlighted: bool,
    pub status_tracked: bool,
    pub status: AgentStatus,
    pub assessment: ProcessAssessment,
    pub status_source: StatusSource,
    pub content: String,
    pub last_update_unix: i64,
    pub herded: bool,
    pub herd_id: Option<u8>,
}

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum StatusSource {
    TmuxHeuristic,
    TmuxFallback,
    CodexAppServer,
    NotTracked,
}

impl StatusSource {
    pub fn as_str(self) -> &'static str {
        match self {
            StatusSource::TmuxHeuristic => "tmux heuristic",
            StatusSource::TmuxFallback => "tmux fallback",
            StatusSource::CodexAppServer => "codex app-server",
            StatusSource::NotTracked => "n/a",
        }
    }
}

impl UiSession {
    pub fn new(
        session_name: &str,
        window_index: i64,
        window_name: &str,
        pane_id: &str,
        pane_index: i64,
        status: AgentStatus,
        content: &str,
    ) -> Self {
        Self {
            session_name: session_name.to_string(),
            window_index,
            window_name: window_name.to_string(),
            pane_id: pane_id.to_string(),
            pane_index,
            current_command: "(none)".to_string(),
            agent_name: "none".to_string(),
            highlighted: false,
            status_tracked: true,
            status,
            assessment: ProcessAssessment::from_display_status(status),
            status_source: StatusSource::TmuxHeuristic,
            content: content.to_string(),
            last_update_unix: 0,
            herded: false,
            herd_id: None,
        }
    }

    pub fn with_runtime(mut self, current_command: String, status_tracked: bool) -> Self {
        self.current_command = current_command;
        self.status_tracked = status_tracked;
        self.status_source = if status_tracked {
            StatusSource::TmuxHeuristic
        } else {
            StatusSource::NotTracked
        };
        self
    }

    pub fn with_agent_runtime(mut self, highlighted: bool, agent_name: String) -> Self {
        self.highlighted = highlighted;
        self.agent_name = agent_name;
        self
    }

    pub fn with_last_update_unix(mut self, last_update_unix: i64) -> Self {
        self.last_update_unix = last_update_unix;
        self
    }

    pub fn with_assessment(mut self, assessment: ProcessAssessment) -> Self {
        self.status = assessment.display_status;
        self.assessment = assessment;
        self
    }

    pub fn with_status_source(mut self, status_source: StatusSource) -> Self {
        self.status_source = status_source;
        self
    }

    pub fn to_session_ref(&self) -> SessionRef {
        SessionRef {
            session_id: String::new(),
            session_name: self.session_name.clone(),
            window_id: String::new(),
            window_index: self.window_index,
            window_name: self.window_name.clone(),
            pane_id: self.pane_id.clone(),
            pane_index: self.pane_index,
            pane_current_path: String::new(),
            pane_current_command: String::new(),
            pane_dead: false,
            pane_last_activity_unix: 0,
        }
    }
}

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum FocusPane {
    Sessions,
    Herds,
    Details,
    Content,
    HerderLog,
}

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum InputMode {
    Command,
    Input,
}

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum AppEventResult {
    Continue,
    Quit,
}

#[derive(Clone, Debug)]
struct HerderLogEntry {
    timestamp: String,
    message: String,
    herd_id: Option<u8>,
}

#[derive(Clone, Debug)]
enum TmuxServerStatus {
    Online,
    Offline(String),
}

#[derive(Clone, Debug)]
pub struct AppModel {
    sessions: Vec<UiSession>,
    selected: usize,
    focus: FocusPane,
    input_mode: InputMode,
    input_buffer: String,
    submitted_input: Option<String>,
    herd_count: u8,
    herd_modes: Vec<String>,
    selected_herd: u8,
    content_scroll_overrides: HashMap<String, u16>,
    content_viewport_height: u16,
    herder_log_entries: Vec<HerderLogEntry>,
    herder_log_filter: Option<u8>,
    herder_log_scroll_override: Option<u16>,
    herder_log_viewport_height: u16,
    tmux_server_status: TmuxServerStatus,
    status_message: Option<String>,
    settings: EditableSettings,
    settings_overlay: Option<SettingsOverlay>,
    pending_settings_action: Option<SettingsAction>,
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

    fn restore_unsent_input(&mut self, message: String) {
        self.input_mode = InputMode::Input;
        self.input_buffer = message;
        self.submitted_input = None;
    }

    fn take_settings_action(&mut self) -> Option<SettingsAction> {
        self.pending_settings_action.take()
    }

    fn load_settings(&mut self, config: &AppConfig, config_path: &Path) {
        self.settings = EditableSettings::from_config(config);
        hydrate_herd_mode_rules(&mut self.settings, config_path);
        self.set_herd_count(self.settings.herd_count);
        self.normalize_herd_mode_assignments();
    }

    fn is_settings_overlay_open(&self) -> bool {
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

    fn herd_count(&self) -> u8 {
        self.herd_count.clamp(1, MAX_HERDS)
    }

    fn max_herd_id(&self) -> u8 {
        self.herd_count().saturating_sub(1)
    }

    fn herd_shortcut_range_label(&self) -> String {
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

pub fn run_tui(
    socket: Option<String>,
    config: AppConfig,
    config_path: std::path::PathBuf,
    state_path: std::path::PathBuf,
) -> Result<(), String> {
    run_tui_inner(socket, config, config_path, state_path)
}

pub fn dispatch_submitted_input_to_selected_pane<A: TmuxAdapter>(
    model: &mut AppModel,
    adapter: &mut A,
    local_pane_id: Option<&str>,
) -> Option<String> {
    dispatch_submitted_input_to_selected_pane_inner(model, adapter, local_pane_id)
}

pub fn render_to_string(model: &AppModel, width: u16, height: u16) -> String {
    render_to_string_surface(model, width, height)
}

fn now_unix() -> i64 {
    match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(duration) => duration.as_secs() as i64,
        Err(_) => 0,
    }
}
