use std::collections::{HashMap, HashSet};
use std::path::Path;

use crate::agent::HeuristicSessionClassifier;
use crate::codex::{CodexSessionStateProvider, CodexThreadState, collect_codex_cwds_from_sessions};
use crate::config::AppConfig;
use crate::domain::SessionRef;
use crate::herd::{HerdRegistry, HerdRuleEngine};
use crate::tmux::{ControlModeMultiplexer, SystemTmuxAdapter};

use super::runtime::{
    PaneContentCacheEntry, append_control_events_to_cache, apply_registry_to_sessions,
    build_ui_sessions_from_refs, collect_session_names, evaluate_and_dispatch_rules_for_session,
    filter_local_pane_from_sessions, load_session_refs,
};
use super::{AppModel, now_unix};

pub(super) fn apply_streamed_control_updates(
    control: &ControlModeMultiplexer,
    pane_cache: &mut HashMap<String, PaneContentCacheEntry>,
    runtime_config: &AppConfig,
    codex_provider: &mut CodexSessionStateProvider,
    session_refs: &[SessionRef],
    codex_status_by_cwd: &mut HashMap<String, CodexThreadState>,
    adapter: &SystemTmuxAdapter,
    classifier: &HeuristicSessionClassifier,
    registry: &HerdRegistry,
    model: &mut AppModel,
) {
    let control_events = control.drain_events();
    if append_control_events_to_cache(
        pane_cache,
        control_events,
        runtime_config.live_capture_line_limit(),
    ) {
        *codex_status_by_cwd = codex_provider
            .statuses_for_cwds(&collect_codex_cwds_from_sessions(session_refs), now_unix());
        let mut streamed_sessions = build_ui_sessions_from_refs(
            adapter,
            classifier,
            runtime_config,
            registry,
            session_refs,
            runtime_config.capture_lines,
            pane_cache,
            codex_status_by_cwd,
        );
        apply_registry_to_sessions(&mut streamed_sessions, registry);
        model.set_sessions(streamed_sessions);
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn perform_periodic_refresh(
    adapter: &mut SystemTmuxAdapter,
    control: &mut ControlModeMultiplexer,
    classifier: &HeuristicSessionClassifier,
    engine: &HerdRuleEngine,
    codex_provider: &mut CodexSessionStateProvider,
    registry: &mut HerdRegistry,
    runtime_config: &AppConfig,
    config_path: &Path,
    state_path: &Path,
    local_pane_id: Option<&str>,
    session_refs: &mut Vec<SessionRef>,
    pane_cache: &mut HashMap<String, PaneContentCacheEntry>,
    codex_status_by_cwd: &mut HashMap<String, CodexThreadState>,
    model: &mut AppModel,
    tmux_server_online: &mut bool,
) {
    match load_session_refs(adapter) {
        Ok(new_refs) => {
            if !*tmux_server_online {
                adapter.enable_extended_keys_passthrough();
            }
            *tmux_server_online = true;
            model.set_tmux_server_online();
            *session_refs = filter_local_pane_from_sessions(new_refs, local_pane_id);
            *codex_status_by_cwd = codex_provider
                .statuses_for_cwds(&collect_codex_cwds_from_sessions(session_refs), now_unix());
            if let Some(err) = codex_provider.take_last_error() {
                model.push_herder_log(format!("codex_status_provider_error error={err}"));
            }

            if let Err(err) = control.sync_sessions(&collect_session_names(session_refs)) {
                model.note_refresh_error(format!("control sync error: {err}"));
            }

            let mut new_sessions = build_ui_sessions_from_refs(
                adapter,
                classifier,
                runtime_config,
                registry,
                session_refs,
                runtime_config.capture_lines,
                pane_cache,
                codex_status_by_cwd,
            );
            apply_registry_to_sessions(&mut new_sessions, registry);

            let now = now_unix();
            let mut event_message: Option<String> = None;
            for session in &new_sessions {
                if !session.status_tracked {
                    continue;
                }
                let mut cycle_logs = Vec::new();
                match evaluate_and_dispatch_rules_for_session(
                    adapter,
                    engine,
                    registry,
                    runtime_config,
                    config_path,
                    session,
                    now,
                    &mut cycle_logs,
                ) {
                    Ok(Some(command)) => {
                        event_message = Some(format!(
                            "rule command sent to {} ({})",
                            session.session_name, session.pane_id
                        ));
                        cycle_logs.push(format!(
                            "dispatch pane={} command={command}",
                            session.pane_id
                        ));
                    }
                    Ok(None) => {}
                    Err(err) => {
                        event_message = Some(format!(
                            "failed to evaluate rules for {}: {}",
                            session.session_name, err
                        ));
                        cycle_logs
                            .push(format!("cycle_error pane={} error={err}", session.pane_id));
                    }
                }
                for log_line in cycle_logs {
                    model.push_herder_log_for_herd(session.herd_id, log_line);
                }
            }

            if let Err(err) = registry.save_to_path(state_path) {
                model.set_status_message(format!("failed to save herd state: {err}"));
            } else if let Some(message) = event_message {
                model.set_status_message(message);
            } else {
                model.note_refresh_success();
            }
            model.set_sessions(new_sessions);
        }
        Err(err) => {
            *tmux_server_online = false;
            session_refs.clear();
            pane_cache.clear();
            model.set_sessions(Vec::new());
            let empty_sessions = HashSet::new();
            if let Err(sync_err) = control.sync_sessions(&empty_sessions) {
                model.push_herder_log(format!("control_sync_error error={sync_err}"));
            }
            model.set_tmux_server_offline(err.clone());
            model.note_refresh_error(format!("refresh error: {err}"));
        }
    }
}
