use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use herd::agent::AgentStatus;
use herd::tui::{AppModel, StatusSource, UiSession, render_to_string};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

const SHOT_WIDTH: u16 = 180;
const SHOT_HEIGHT: u16 = 52;

fn key(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::NONE)
}

fn screenshot_raw_dir() -> PathBuf {
    if let Ok(path) = env::var("HERD_DOC_SCREENSHOT_DIR")
        && !path.trim().is_empty()
    {
        return PathBuf::from(path);
    }
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("docs")
        .join("screenshots")
        .join("raw")
}

fn render_lines(model: &AppModel) -> Vec<String> {
    let flat = render_to_string(model, SHOT_WIDTH, SHOT_HEIGHT);
    let cells = flat.chars().collect::<Vec<_>>();
    let row_width = usize::from(SHOT_WIDTH);
    let row_count = usize::from(SHOT_HEIGHT);
    let mut lines = Vec::with_capacity(row_count);
    for row in 0..row_count {
        let start = row * row_width;
        let end = start + row_width;
        let mut line = if end <= cells.len() {
            cells[start..end].iter().collect::<String>()
        } else if start < cells.len() {
            let mut partial = cells[start..].iter().collect::<String>();
            partial.push_str(&" ".repeat(end - cells.len()));
            partial
        } else {
            " ".repeat(row_width)
        };
        while line.ends_with(' ') {
            line.pop();
        }
        lines.push(line);
    }
    lines
}

fn write_snapshot(name: &str, model: &AppModel) -> Result<(), String> {
    let output_dir = screenshot_raw_dir();
    fs::create_dir_all(&output_dir).map_err(|err| {
        format!(
            "failed creating screenshot directory {:?}: {err}",
            output_dir
        )
    })?;
    let output_path = output_dir.join(format!("{name}.txt"));
    let mut content = render_lines(model).join("\n");
    content.push('\n');
    fs::write(&output_path, content).map_err(|err| {
        format!(
            "failed writing screenshot snapshot {:?}: {err}",
            output_path
        )
    })?;
    Ok(())
}

fn base_model() -> AppModel {
    let sessions = vec![
        UiSession::new(
            "alpha",
            0,
            "plan",
            "%1",
            0,
            AgentStatus::Running,
            "$ codex\nPlanning phased refactor...\nGathering context...",
        )
        .with_runtime("codex".to_string(), true)
        .with_agent_runtime(true, "codex".to_string())
        .with_status_source(StatusSource::CodexAppServer),
        UiSession::new(
            "beta",
            0,
            "review",
            "%2",
            1,
            AgentStatus::Waiting,
            "$ bash\nwaiting for user input...",
        )
        .with_runtime("bash".to_string(), true)
        .with_agent_runtime(false, "shell".to_string())
        .with_status_source(StatusSource::TmuxHeuristic),
        UiSession::new(
            "gamma",
            1,
            "logs",
            "%3",
            0,
            AgentStatus::Stalled,
            "$ claude\nno output for 4m 12s",
        )
        .with_runtime("claude".to_string(), true)
        .with_agent_runtime(true, "claude".to_string())
        .with_status_source(StatusSource::TmuxFallback),
    ];
    let mut model = AppModel::new(sessions);

    model.handle_key(key(KeyCode::Char('0')));
    model.handle_key(key(KeyCode::Char('j')));
    model.handle_key(key(KeyCode::Char('1')));
    model.handle_key(key(KeyCode::Char('j')));
    model.handle_key(key(KeyCode::Char('2')));
    model.handle_key(key(KeyCode::Char('g')));

    model.push_herder_log_for_herd(Some(0), "rule_start id=default_nudge type=regex");
    model.push_herder_log_for_herd(Some(0), "rule_match id=default_nudge command=continue");
    model.push_herder_log_for_herd(Some(1), "cycle_end matched=false");
    model.push_herder_log_for_herd(Some(2), "dispatch_ok pane=%3");
    model.set_status_message("source: codex app-server");
    model
}

#[test]
#[ignore = "Generates docs screenshot artifacts"]
fn generate_docs_screenshots_from_tui_states() {
    let model = base_model();
    write_snapshot("tui_overview", &model).expect("overview snapshot should be written");

    let mut settings = base_model();
    settings.handle_key(key(KeyCode::Char(',')));
    write_snapshot("tui_settings_overlay", &settings).expect("settings snapshot should be written");

    let mut input = base_model();
    input.handle_key(key(KeyCode::Char('L')));
    input.handle_key(key(KeyCode::Char('i')));
    for ch in "Please continue and run tests.".chars() {
        input.handle_key(key(KeyCode::Char(ch)));
    }
    input.handle_key(key(KeyCode::Enter));
    for ch in "Report back with failures first.".chars() {
        input.handle_key(key(KeyCode::Char(ch)));
    }
    write_snapshot("tui_input_mode", &input).expect("input snapshot should be written");

    let mut log_filter = base_model();
    log_filter.handle_key(key(KeyCode::Char('J')));
    log_filter.handle_key(key(KeyCode::Char('J')));
    log_filter.handle_key(key(KeyCode::Char('J')));
    log_filter.handle_key(key(KeyCode::Char('J')));
    log_filter.handle_key(key(KeyCode::Char('2')));
    write_snapshot("tui_herder_log_filter", &log_filter)
        .expect("herder log filter snapshot should be written");
}
