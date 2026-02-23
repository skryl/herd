pub(crate) use super::runtime_rules::evaluate_and_dispatch_rules_for_session;
pub(crate) use super::runtime_sessions::{
    append_control_events_to_cache, apply_registry_to_sessions, build_ui_sessions_from_refs,
    collect_session_names, current_tmux_pane_id, filter_local_pane_from_sessions,
    load_session_refs,
};

#[derive(Clone, Debug, Default)]
pub(crate) struct PaneContentCacheEntry {
    pub(crate) content: String,
    pub(crate) last_update_unix: i64,
}
