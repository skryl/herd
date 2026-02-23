use std::collections::HashMap;
use std::io::{self, stdout};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use crossterm::event::{
    self, Event, KeyEventKind, KeyboardEnhancementFlags, PopKeyboardEnhancementFlags,
    PushKeyboardEnhancementFlags,
};
use crossterm::execute;
use crossterm::terminal::{
    EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode,
};
use ratatui::Terminal;
use ratatui::backend::CrosstermBackend;

use crate::agent::{ClassifierConfig, HeuristicSessionClassifier};
use crate::codex::{CodexSessionStateProvider, collect_codex_cwds_from_sessions};
use crate::config::AppConfig;
use crate::herd::{HerdConfig, HerdRegistry, HerdRuleEngine};
use crate::llm::fetch_models;
use crate::tmux::{ControlModeMultiplexer, SystemTmuxAdapter, TmuxAdapter};

use super::render_surface::render;
use super::runtime::{
    apply_registry_to_sessions, build_ui_sessions_from_refs, collect_session_names,
    current_tmux_pane_id, filter_local_pane_from_sessions, load_session_refs,
};
use super::runtime_refresh::{apply_streamed_control_updates, perform_periodic_refresh};
use super::settings_io::write_herd_mode_rule_files;
use super::{AppEventResult, AppModel, SettingsAction, now_unix};

pub(super) fn run_tui(
    socket: Option<String>,
    config: AppConfig,
    config_path: PathBuf,
    state_path: PathBuf,
) -> Result<(), String> {
    enable_raw_mode().map_err(|err| format!("failed to enable raw mode: {err}"))?;
    execute!(stdout(), EnterAlternateScreen)
        .map_err(|err| format!("failed to enter alternate screen: {err}"))?;
    let keyboard_enhancements_enabled = execute!(
        stdout(),
        PushKeyboardEnhancementFlags(
            KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES
                | KeyboardEnhancementFlags::REPORT_EVENT_TYPES
                | KeyboardEnhancementFlags::REPORT_ALL_KEYS_AS_ESCAPE_CODES
        )
    )
    .is_ok();

    let _guard = TerminalGuard {
        keyboard_enhancements_enabled,
    };
    let backend = CrosstermBackend::new(stdout());
    let mut terminal =
        Terminal::new(backend).map_err(|err| format!("failed to create terminal: {err}"))?;

    let mut runtime_config = config;
    let mut adapter = SystemTmuxAdapter::new(socket.clone());
    adapter.enable_extended_keys_passthrough();
    let mut control = ControlModeMultiplexer::new(socket);
    let mut classifier = HeuristicSessionClassifier::new(ClassifierConfig::from(&runtime_config));
    let mut engine = HerdRuleEngine::new(HerdConfig::from(&runtime_config));
    let mut codex_provider = CodexSessionStateProvider::default();
    let mut registry = HerdRegistry::load_from_path(&state_path).unwrap_or_default();
    let mut pane_cache = HashMap::new();
    let local_pane_id = current_tmux_pane_id();
    let (mut session_refs, initial_tmux_server_error) = match load_session_refs(&adapter) {
        Ok(refs) => (
            filter_local_pane_from_sessions(refs, local_pane_id.as_deref()),
            None,
        ),
        Err(err) => (Vec::new(), Some(err)),
    };
    let mut codex_status_by_cwd = codex_provider
        .statuses_for_cwds(&collect_codex_cwds_from_sessions(&session_refs), now_unix());
    let mut control_sync_error = None;
    if let Err(err) = control.sync_sessions(&collect_session_names(&session_refs)) {
        control_sync_error = Some(err);
    }
    let mut initial_sessions = build_ui_sessions_from_refs(
        &adapter,
        &classifier,
        &runtime_config,
        &registry,
        &session_refs,
        runtime_config.capture_lines,
        &mut pane_cache,
        &codex_status_by_cwd,
    );
    apply_registry_to_sessions(&mut initial_sessions, &registry);
    let mut model = AppModel::new(initial_sessions);
    model.load_settings(&runtime_config, &config_path);
    model.load_herd_modes(&registry);
    if let Some(err) = &initial_tmux_server_error {
        model.set_tmux_server_offline(err.clone());
        model.note_refresh_error(format!("refresh error: {err}"));
    } else {
        model.set_tmux_server_online();
    }
    if let Some(err) = control_sync_error {
        model.set_status_message(format!("control mode warning: {err}"));
    }
    if let Some(err) = codex_provider.take_last_error() {
        model.push_herder_log(format!("codex_status_provider_error error={err}"));
    }
    let ui_tick = Duration::from_millis(50);
    let mut last_refresh = Instant::now();
    let mut tmux_server_online = initial_tmux_server_error.is_none();

    loop {
        apply_streamed_control_updates(
            &control,
            &mut pane_cache,
            &runtime_config,
            &mut codex_provider,
            &session_refs,
            &mut codex_status_by_cwd,
            &adapter,
            &classifier,
            &registry,
            &mut model,
        );

        terminal
            .draw(|frame| render(frame, &mut model))
            .map_err(|err| format!("failed to draw frame: {err}"))?;

        let refresh_interval = Duration::from_millis(runtime_config.refresh_interval_ms);
        let timeout = refresh_interval
            .saturating_sub(last_refresh.elapsed())
            .min(ui_tick);
        if event::poll(timeout).map_err(|err| format!("event poll failed: {err}"))?
            && let Event::Key(key) =
                event::read().map_err(|err| format!("event read failed: {err}"))?
        {
            if !matches!(key.kind, KeyEventKind::Press | KeyEventKind::Repeat) {
                continue;
            }
            if model.handle_key(key) == AppEventResult::Quit {
                break;
            }

            if let Some(action) = model.take_settings_action() {
                match action {
                    SettingsAction::RefreshModels { provider, api_key } => {
                        match fetch_models(&provider, &api_key) {
                            Ok(models) => model.apply_model_fetch_result(models),
                            Err(err) => model.apply_model_fetch_error(err),
                        }
                    }
                    SettingsAction::Save(settings) => {
                        settings.apply_to_config(&mut runtime_config);
                        if let Err(err) = runtime_config.save_to_path(&config_path) {
                            model.set_status_message(format!("failed to save settings: {err}"));
                        } else if let Err(err) = write_herd_mode_rule_files(&settings, &config_path)
                        {
                            model.set_status_message(format!(
                                "failed to save herd mode rules: {err}"
                            ));
                        } else {
                            classifier = HeuristicSessionClassifier::new(ClassifierConfig::from(
                                &runtime_config,
                            ));
                            engine = HerdRuleEngine::new(HerdConfig::from(&runtime_config));
                            model.set_status_message("settings saved");
                        }
                    }
                }
            }

            if let Some(sent_pane_id) = dispatch_submitted_input_to_selected_pane(
                &mut model,
                &mut adapter,
                local_pane_id.as_deref(),
            ) {
                // Force next refresh to re-capture the pane from tmux so command output
                // appears even if control-mode streaming did not emit pane output.
                pane_cache.remove(&sent_pane_id);
            }

            if !model.is_input_mode() && !model.is_settings_overlay_open() {
                model.sync_herd_registry(&mut registry);
                if let Err(err) = registry.save_to_path(&state_path) {
                    model.set_status_message(format!("failed to save herd state: {err}"));
                } else {
                    // Command-mode key handling should not keep stale transient input errors.
                    if model
                        .status_message()
                        .is_some_and(|message| message.starts_with("input send failed"))
                    {
                        model.clear_status_message();
                    }
                }
            }
        }

        if last_refresh.elapsed() >= refresh_interval {
            perform_periodic_refresh(
                &mut adapter,
                &mut control,
                &classifier,
                &engine,
                &mut codex_provider,
                &mut registry,
                &runtime_config,
                &config_path,
                &state_path,
                local_pane_id.as_deref(),
                &mut session_refs,
                &mut pane_cache,
                &mut codex_status_by_cwd,
                &mut model,
                &mut tmux_server_online,
            );
            last_refresh = Instant::now();
        }
    }

    Ok(())
}

pub(super) fn dispatch_submitted_input_to_selected_pane<A: TmuxAdapter>(
    model: &mut AppModel,
    adapter: &mut A,
    local_pane_id: Option<&str>,
) -> Option<String> {
    let Some(message) = model.take_submitted_input() else {
        return None;
    };
    let preview = message
        .lines()
        .next()
        .unwrap_or_default()
        .chars()
        .take(80)
        .collect::<String>();
    model.push_herder_log(format!(
        "input_send attempt bytes={} lines={} preview={preview:?}",
        message.len(),
        message.lines().count().max(1)
    ));

    let Some(pane_id) = model.selected_pane_id().map(ToString::to_string) else {
        model.restore_unsent_input(message);
        model.set_status_message("input send failed: no pane selected");
        model.push_herder_log("input_send failed reason=no_selected_pane");
        return None;
    };

    if local_pane_id.is_some_and(|local| local == pane_id.as_str()) {
        model.restore_unsent_input(message);
        model.set_status_message("input send blocked: selected pane is herd ui");
        model.push_herder_log("input_send blocked reason=selected_pane_is_herd_ui");
        return None;
    }

    match adapter.send_keys(&pane_id, &message) {
        Ok(()) => {
            model.set_status_message(format!("input sent to {pane_id}"));
            model.push_herder_log(format!("input_send ok pane={pane_id}"));
            Some(pane_id)
        }
        Err(err) => {
            model.restore_unsent_input(message);
            model.set_status_message(format!("input send failed ({pane_id}): {err}"));
            model.push_herder_log(format!("input_send failed pane={pane_id} error={err}"));
            None
        }
    }
}

struct TerminalGuard {
    keyboard_enhancements_enabled: bool,
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
        if self.keyboard_enhancements_enabled {
            let _ = execute!(io::stdout(), PopKeyboardEnhancementFlags);
        }
        let _ = execute!(io::stdout(), LeaveAlternateScreen);
    }
}
