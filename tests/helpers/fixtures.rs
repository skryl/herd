use herd::agent::{AgentStatus, PriorProcessState, ProcessAssessment, ProcessState};
use herd::domain::{PaneSnapshot, SessionRef};
use herd::herd::HerdRegistry;
use herd::rules::{RuleRuntimeContext, RuleStatusContext};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, Deserialize)]
pub struct WorkerFixture {
    pub pane_id: String,
    pub session_name: String,
    #[serde(default = "default_window_name")]
    pub window_name: String,
    #[serde(default)]
    pub window_index: i64,
    #[serde(default)]
    pub pane_index: i64,
    #[serde(default = "default_command")]
    pub pane_current_command: String,
    pub captured_at_unix: i64,
    pub last_activity_unix: i64,
    pub content: String,
    #[serde(default)]
    pub prior: WorkerPriorFixture,
    pub expected: WorkerExpectedFixture,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct WorkerPriorFixture {
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub state_entered_unix: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct WorkerExpectedFixture {
    pub state: String,
    pub display_status: String,
    pub eligible_for_herd: bool,
    #[serde(default)]
    pub reasons: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct RuleExpectationFixture {
    #[serde(default)]
    pub matched_rule_id: Option<String>,
    #[serde(default)]
    pub command_to_send: Option<String>,
    #[serde(default)]
    pub logs_contains: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct MonitorExpectationFixture {
    pub expected_pane_id: String,
    pub expected_command: String,
}

impl WorkerFixture {
    pub fn pane_snapshot(&self) -> PaneSnapshot {
        PaneSnapshot {
            pane_id: self.pane_id.clone(),
            content: self.content.clone(),
            captured_at_unix: self.captured_at_unix,
            last_activity_unix: self.last_activity_unix,
        }
    }

    pub fn prior_process_state(&self) -> PriorProcessState {
        PriorProcessState {
            state: self.prior.state.as_deref().map(process_state_from_str),
            state_entered_unix: self.prior.state_entered_unix,
        }
    }

    pub fn session_ref(&self) -> SessionRef {
        SessionRef {
            session_id: "$fixture".to_string(),
            session_name: self.session_name.clone(),
            window_id: format!("@{}", self.window_index),
            window_index: self.window_index,
            window_name: self.window_name.clone(),
            pane_id: self.pane_id.clone(),
            pane_index: self.pane_index,
            pane_current_path: "/tmp".to_string(),
            pane_current_command: self.pane_current_command.clone(),
            pane_dead: false,
            pane_last_activity_unix: self.last_activity_unix,
        }
    }

    pub fn runtime_context(&self, assessment: &ProcessAssessment) -> RuleRuntimeContext {
        RuleRuntimeContext {
            pane_id: self.pane_id.clone(),
            session_name: self.session_name.clone(),
            status: RuleStatusContext {
                state: assessment.state.as_str().to_string(),
                display_status: assessment.display_status.as_str().to_string(),
                inactive_secs: assessment.inactive_secs,
                waiting_secs: assessment.waiting_secs,
                confidence: assessment.confidence,
                eligible_for_herd: assessment.eligible_for_herd,
                reasons: assessment.reason_labels(),
            },
        }
    }
}

pub fn fixture_path(relative: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join(relative)
}

pub fn read_fixture_text(relative: &str) -> String {
    let path = fixture_path(relative);
    fs::read_to_string(&path)
        .unwrap_or_else(|err| panic!("failed reading fixture {:?}: {err}", path))
}

pub fn read_fixture_json<T: DeserializeOwned>(relative: &str) -> T {
    let raw = read_fixture_text(relative);
    serde_json::from_str(&raw)
        .unwrap_or_else(|err| panic!("failed parsing fixture JSON {}: {err}", relative))
}

pub fn load_worker_fixture(name: &str) -> WorkerFixture {
    read_fixture_json(&format!("worker/{name}.json"))
}

pub fn load_rule_expectation(name: &str) -> RuleExpectationFixture {
    read_fixture_json(&format!("herder/expectations/{name}.json"))
}

pub fn load_monitor_expectation(name: &str) -> MonitorExpectationFixture {
    read_fixture_json(&format!("herder/expectations/{name}.json"))
}

pub fn load_rule_file_path(name: &str) -> PathBuf {
    fixture_path(&format!("herder/rules/{name}.json"))
}

pub fn load_llm_output(name: &str) -> String {
    read_fixture_text(&format!("herder/output/{name}.json"))
}

pub fn load_herder_output_text(name: &str) -> String {
    read_fixture_text(&format!("herder/output/{name}.txt"))
}

pub fn load_registry_fixture(name: &str) -> HerdRegistry {
    read_fixture_json(&format!("herder/registry/{name}.json"))
}

pub fn load_config_fixture_text(name: &str) -> String {
    read_fixture_text(&format!("herder/config/{name}.json"))
}

pub fn temp_settings_path(prefix: &str) -> PathBuf {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be monotonic enough")
        .as_millis();
    std::env::temp_dir()
        .join(format!("{prefix}_{suffix}"))
        .join("settings.json")
}

pub fn process_state_from_str(value: &str) -> ProcessState {
    match value.trim().to_ascii_lowercase().as_str() {
        "unknown" => ProcessState::Unknown,
        "running" => ProcessState::Running,
        "waiting" => ProcessState::Waiting,
        "waiting_long" => ProcessState::WaitingLong,
        "stalled" => ProcessState::Stalled,
        "finished" => ProcessState::Finished,
        other => panic!("unsupported process state fixture value: {other}"),
    }
}

pub fn agent_status_from_str(value: &str) -> AgentStatus {
    match value.trim().to_ascii_lowercase().as_str() {
        "unknown" => AgentStatus::Unknown,
        "running" => AgentStatus::Running,
        "waiting" => AgentStatus::Waiting,
        "stalled" => AgentStatus::Stalled,
        "finished" => AgentStatus::Finished,
        other => panic!("unsupported agent status fixture value: {other}"),
    }
}

fn default_window_name() -> String {
    "editor".to_string()
}

fn default_command() -> String {
    "claude".to_string()
}
