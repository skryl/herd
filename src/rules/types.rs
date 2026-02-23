use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const RULE_FILE_VERSION: u32 = 1;

#[derive(Clone, Debug, Default, Serialize, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum InputScope {
    #[default]
    FullBuffer,
    VisibleWindow,
}

#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
pub struct RegexRule {
    pub id: String,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub input_scope: InputScope,
    pub pattern: String,
    pub command_template: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
pub struct LlmRule {
    pub id: String,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub input_scope: InputScope,
    pub prompt: String,
    pub command_template: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RuleDefinition {
    Regex(RegexRule),
    Llm(LlmRule),
}

#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
pub struct RuleFile {
    #[serde(default = "default_rule_version")]
    pub version: u32,
    #[serde(default)]
    pub rules: Vec<RuleDefinition>,
}

impl Default for RuleFile {
    fn default() -> Self {
        Self {
            version: RULE_FILE_VERSION,
            rules: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct LlmRuleDecision {
    pub matched: bool,
    pub command: Option<String>,
    pub variables: BoundVariables,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct RuleExecutionSummary {
    pub matched_rule_id: Option<String>,
    pub command_to_send: Option<String>,
    pub variables: BoundVariables,
    pub logs: Vec<String>,
}

pub type BoundVariables = Map<String, Value>;
pub type RuleMatch = Option<(String, BoundVariables)>;

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct RuleStatusContext {
    pub state: String,
    pub display_status: String,
    pub inactive_secs: i64,
    pub waiting_secs: i64,
    pub confidence: u8,
    pub eligible_for_herd: bool,
    pub reasons: Vec<String>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct RuleRuntimeContext {
    pub pane_id: String,
    pub session_name: String,
    pub status: RuleStatusContext,
}

fn default_rule_version() -> u32 {
    RULE_FILE_VERSION
}

fn default_enabled() -> bool {
    true
}
