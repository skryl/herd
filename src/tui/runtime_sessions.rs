use std::collections::{HashMap, HashSet};
use std::env;

use crate::agent::{
    AgentStatus, PriorProcessState, ProcessAssessment, SessionClassifier, agent_name_for_command,
    display_command, should_highlight_command, should_track_status_for_command,
};
use crate::codex::{CodexThreadState, assessment_from_codex_state, is_codex_command, now_unix};
use crate::config::AppConfig;
use crate::domain::{PaneSnapshot, SessionRef};
use crate::herd::HerdRegistry;
use crate::tmux::{ControlOutputEvent, TmuxAdapter};

use super::runtime::PaneContentCacheEntry;
use super::{StatusSource, UiSession};

pub(crate) fn apply_registry_to_sessions(sessions: &mut [UiSession], registry: &HerdRegistry) {
    for session in sessions {
        session.herded = registry.is_herded(&session.pane_id);
        session.herd_id = registry.herd_group(&session.pane_id);
        if session.herd_id.is_some() {
            session.herded = true;
        }
    }
}

pub(crate) fn load_session_refs<A: TmuxAdapter>(adapter: &A) -> Result<Vec<SessionRef>, String> {
    let mut sessions = adapter.list_sessions()?;
    sessions.sort_by(|a, b| {
        a.session_name
            .cmp(&b.session_name)
            .then(a.window_index.cmp(&b.window_index))
            .then(a.pane_index.cmp(&b.pane_index))
            .then(a.pane_id.cmp(&b.pane_id))
    });
    Ok(sessions)
}

pub(crate) fn current_tmux_pane_id() -> Option<String> {
    env::var("TMUX_PANE")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub(crate) fn filter_local_pane_from_sessions(
    mut sessions: Vec<SessionRef>,
    local_pane_id: Option<&str>,
) -> Vec<SessionRef> {
    if let Some(local_pane) = local_pane_id {
        sessions.retain(|session| session.pane_id != local_pane);
    }
    sessions
}

pub(crate) fn collect_session_names(sessions: &[SessionRef]) -> HashSet<String> {
    sessions
        .iter()
        .map(|session| session.session_name.clone())
        .collect()
}

pub(crate) fn append_control_events_to_cache(
    pane_cache: &mut HashMap<String, PaneContentCacheEntry>,
    events: Vec<ControlOutputEvent>,
    max_lines: usize,
) -> bool {
    let mut changed = false;
    for event in events {
        if event.content.is_empty() {
            continue;
        }
        let entry = pane_cache.entry(event.pane_id).or_default();
        entry.content.push_str(&event.content);
        entry.last_update_unix = entry.last_update_unix.max(event.captured_at_unix);
        trim_content_to_recent_lines(&mut entry.content, max_lines);
        changed = true;
    }
    changed
}

fn trim_content_to_recent_lines(content: &mut String, max_lines: usize) {
    if max_lines == 0 {
        content.clear();
        return;
    }
    let line_count = content.lines().count();
    if line_count <= max_lines + 128 {
        return;
    }
    let retained = content
        .lines()
        .rev()
        .take(max_lines)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n");
    *content = retained;
}

pub(crate) fn build_ui_sessions_from_refs<A: TmuxAdapter, C: SessionClassifier>(
    adapter: &A,
    classifier: &C,
    config: &AppConfig,
    registry: &HerdRegistry,
    sessions: &[SessionRef],
    capture_lines: usize,
    pane_cache: &mut HashMap<String, PaneContentCacheEntry>,
    codex_status_by_cwd: &HashMap<String, CodexThreadState>,
) -> Vec<UiSession> {
    let mut ui_sessions = Vec::with_capacity(sessions.len());
    for session in sessions {
        let tracked = should_track_status_for_command(&session.pane_current_command, config);
        let highlighted = should_highlight_command(&session.pane_current_command, config);
        let agent_name = agent_name_for_command(&session.pane_current_command, config);
        let command = display_command(&session.pane_current_command);

        let cached = pane_cache.get(&session.pane_id).cloned();
        let (content, last_update_unix) = if let Some(cached) = cached {
            (cached.content, cached.last_update_unix)
        } else {
            match adapter.capture_pane(&session.pane_id, capture_lines) {
                Ok(snapshot) => {
                    let captured_at = snapshot.captured_at_unix;
                    pane_cache.insert(
                        session.pane_id.clone(),
                        PaneContentCacheEntry {
                            content: snapshot.content.clone(),
                            last_update_unix: captured_at,
                        },
                    );
                    (snapshot.content, captured_at)
                }
                Err(err) => (
                    format!("failed to capture pane {}: {err}", session.pane_id),
                    now_unix(),
                ),
            }
        };

        let captured_at_unix = if last_update_unix > 0 {
            last_update_unix
        } else {
            now_unix()
        };
        let snapshot = PaneSnapshot {
            pane_id: session.pane_id.clone(),
            content: content.clone(),
            captured_at_unix,
            last_activity_unix: normalize_activity_timestamp(
                session.pane_last_activity_unix,
                captured_at_unix,
            ),
        };
        let prior = if tracked {
            registry.prior_process_state(&session.pane_id)
        } else {
            PriorProcessState::default()
        };
        let mut assessment = if tracked {
            classifier.assess(&snapshot, prior)
        } else {
            ProcessAssessment::from_display_status(AgentStatus::Unknown)
        };
        let mut status_source = if tracked {
            StatusSource::TmuxHeuristic
        } else {
            StatusSource::NotTracked
        };
        if tracked && is_codex_command(&session.pane_current_command) {
            status_source = StatusSource::TmuxFallback;
            if let Some(codex_state) = codex_status_by_cwd.get(&session.pane_current_path) {
                let codex_captured_at = captured_at_unix.max(codex_state.thread_updated_unix);
                assessment = assessment_from_codex_state(
                    codex_state,
                    prior,
                    codex_captured_at,
                    config.status_waiting_grace_secs(),
                );
                status_source = StatusSource::CodexAppServer;
            }
        }
        let status = assessment.display_status;

        ui_sessions.push(
            UiSession::new(
                &session.session_name,
                session.window_index,
                &session.window_name,
                &session.pane_id,
                session.pane_index,
                status,
                &content,
            )
            .with_runtime(command, tracked)
            .with_assessment(assessment)
            .with_status_source(status_source)
            .with_agent_runtime(highlighted, agent_name)
            .with_last_update_unix(captured_at_unix),
        );
    }
    ui_sessions
}

fn normalize_activity_timestamp(activity_unix: i64, captured_at_unix: i64) -> i64 {
    // Some tmux versions expose only pane_last (0/1), not epoch activity time.
    if activity_unix >= 1_000_000_000 && activity_unix <= captured_at_unix + 86_400 {
        activity_unix
    } else {
        captured_at_unix
    }
}
