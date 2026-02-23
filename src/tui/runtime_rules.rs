use std::path::{Path, PathBuf};

use serde_json::json;

use crate::config::{AppConfig, HerdModeDefinition, MAX_HERDS};
use crate::herd::{HerdEngine, HerdRegistry};
use crate::llm::evaluate_rule;
use crate::rules::{
    RuleRuntimeContext, RuleStatusContext, evaluate_rules_in_order, load_rule_file, tail_lines,
};
use crate::tmux::TmuxAdapter;

use super::UiSession;

fn resolve_herd_mode_definition<'a>(
    config: &'a AppConfig,
    mode_name: &str,
) -> Option<&'a HerdModeDefinition> {
    config
        .herd_modes
        .iter()
        .find(|mode| mode.name.eq_ignore_ascii_case(mode_name))
        .or_else(|| config.herd_modes.first())
}

fn herd_mode_rule_path(config_path: &Path, mode: &HerdModeDefinition) -> PathBuf {
    let root = config_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    root.join(&mode.rule_file)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn evaluate_and_dispatch_rules_for_session<A: TmuxAdapter, E: HerdEngine>(
    adapter: &mut A,
    engine: &E,
    registry: &mut HerdRegistry,
    runtime_config: &AppConfig,
    config_path: &Path,
    session: &UiSession,
    now_unix: i64,
    logs: &mut Vec<String>,
) -> Result<Option<String>, String> {
    let reason_labels = session.assessment.reason_labels();
    registry.record_assessment(&session.pane_id, &session.assessment);
    let session_ref = session.to_session_ref();
    if !engine.should_nudge(
        &session_ref,
        &session.assessment,
        registry.session_state(&session.pane_id),
        now_unix,
    ) {
        return Ok(None);
    }

    let herd_id = session.herd_id.unwrap_or(0).min(MAX_HERDS - 1);
    let mode_name = registry.herd_mode(herd_id);
    logs.push(format!(
        "mode_selected pane={} herd={} mode={}",
        session.pane_id, herd_id, mode_name
    ));
    let mode_definition = resolve_herd_mode_definition(runtime_config, &mode_name)
        .ok_or_else(|| "no herd mode definition is configured".to_string())?;
    let rule_path = herd_mode_rule_path(config_path, mode_definition);
    logs.push(format!(
        "mode_file pane={} path={}",
        session.pane_id,
        rule_path.display()
    ));

    let rule_file = load_rule_file(&rule_path)?;
    let pane_height = adapter.pane_height(&session.pane_id).unwrap_or(40).max(1);
    let visible_window = tail_lines(&session.content, pane_height);
    let runtime_context = RuleRuntimeContext {
        pane_id: session.pane_id.clone(),
        session_name: session.session_name.clone(),
        status: RuleStatusContext {
            state: session.assessment.state.as_str().to_string(),
            display_status: session.assessment.display_status.as_str().to_string(),
            inactive_secs: session.assessment.inactive_secs,
            waiting_secs: session.assessment.waiting_secs,
            confidence: session.assessment.confidence,
            eligible_for_herd: session.assessment.eligible_for_herd,
            reasons: reason_labels,
        },
    };
    logs.push(format!(
        "inputs pane={} full_lines={} visible_lines={}",
        session.pane_id,
        session.content.lines().count(),
        pane_height
    ));

    let provider = runtime_config.normalized_provider();
    let api_key = runtime_config
        .provider_api_key(provider)
        .unwrap_or_default();
    let model = runtime_config.llm_model.clone();
    let summary = evaluate_rules_in_order(
        &rule_file,
        &session.content,
        &visible_window,
        &runtime_context,
        |rule, input, context| {
            let payload = json!({
                "status_context": {
                    "pane_id": context.pane_id.as_str(),
                    "session_name": context.session_name.as_str(),
                    "state": context.status.state.as_str(),
                    "display_status": context.status.display_status.as_str(),
                    "inactive_secs": context.status.inactive_secs,
                    "waiting_secs": context.status.waiting_secs,
                    "confidence": context.status.confidence,
                    "eligible_for_herd": context.status.eligible_for_herd,
                    "reasons": &context.status.reasons,
                },
                "pane_input": input
            })
            .to_string();
            evaluate_rule(provider, api_key, &model, &rule.prompt, &payload)
        },
    );

    for log_line in summary.logs {
        logs.push(format!(
            "rule_eval pane={} mode={} {}",
            session.pane_id, mode_name, log_line
        ));
    }

    if let Some(command) = summary.command_to_send {
        adapter
            .send_keys(&session.pane_id, &command)
            .map_err(|err| format!("dispatch failed for {}: {err}", session.pane_id))?;
        registry.record_nudge(&session.pane_id, now_unix);
        logs.push(format!(
            "dispatch_ok pane={} command={}",
            session.pane_id, command
        ));
        Ok(Some(command))
    } else {
        logs.push(format!(
            "dispatch_skip pane={} reason=no_match",
            session.pane_id
        ));
        Ok(None)
    }
}
