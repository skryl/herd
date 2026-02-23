use crate::agent::{AgentStatus, ProcessAssessment};
use crate::domain::SessionRef;

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
pub(super) struct HerderLogEntry {
    pub(super) timestamp: String,
    pub(super) message: String,
    pub(super) herd_id: Option<u8>,
}

#[derive(Clone, Debug)]
pub(super) enum TmuxServerStatus {
    Online,
    Offline(String),
}
