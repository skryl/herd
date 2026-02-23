use crate::config::AppConfig;
use crate::tmux::TmuxAdapter;
use render_surface::render_to_string as render_to_string_surface;
use runtime_loop::{
    dispatch_submitted_input_to_selected_pane as dispatch_submitted_input_to_selected_pane_inner,
    run_tui as run_tui_inner,
};

use settings_types::{
    EditableHerdMode, EditableSettings, SettingsAction, SettingsField, SettingsOverlay,
};

mod interaction_state;
mod key_handling;
mod log_status_state;
mod model_core;
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
mod types;

pub use self::model_core::AppModel;
pub use self::types::{AppEventResult, FocusPane, InputMode, StatusSource, UiSession};
use self::types::{HerderLogEntry, TmuxServerStatus};

const HERDER_LOG_MAX_LINES: usize = 10_000;

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
