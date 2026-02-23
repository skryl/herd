#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionRef {
    pub session_id: String,
    pub session_name: String,
    pub window_id: String,
    pub window_index: i64,
    pub window_name: String,
    pub pane_id: String,
    pub pane_index: i64,
    pub pane_current_path: String,
    pub pane_current_command: String,
    pub pane_dead: bool,
    pub pane_last_activity_unix: i64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PaneSnapshot {
    pub pane_id: String,
    pub content: String,
    pub captured_at_unix: i64,
    pub last_activity_unix: i64,
}
