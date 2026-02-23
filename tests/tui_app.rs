use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use herd::agent::AgentStatus;
use herd::domain::{PaneSnapshot, SessionRef};
use herd::tmux::TmuxAdapter;
use herd::tui::{
    AppEventResult, AppModel, FocusPane, InputMode, StatusSource, UiSession,
    dispatch_submitted_input_to_selected_pane, render_to_string,
};

fn key(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::NONE)
}

fn key_with_modifiers(code: KeyCode, modifiers: KeyModifiers) -> KeyEvent {
    KeyEvent::new(code, modifiers)
}

#[derive(Default)]
struct RecordingTmuxAdapter {
    sent: Vec<(String, String)>,
    send_error: Option<String>,
}

impl TmuxAdapter for RecordingTmuxAdapter {
    fn list_sessions(&self) -> Result<Vec<SessionRef>, String> {
        Ok(Vec::new())
    }

    fn capture_pane(&self, pane_id: &str, _lines: usize) -> Result<PaneSnapshot, String> {
        Ok(PaneSnapshot {
            pane_id: pane_id.to_string(),
            content: String::new(),
            captured_at_unix: 0,
            last_activity_unix: 0,
        })
    }

    fn pane_height(&self, _pane_id: &str) -> Result<usize, String> {
        Ok(24)
    }

    fn send_keys(&mut self, pane_id: &str, message: &str) -> Result<(), String> {
        if let Some(err) = &self.send_error {
            return Err(err.clone());
        }
        self.sent.push((pane_id.to_string(), message.to_string()));
        Ok(())
    }
}

#[test]
fn vim_navigation_moves_selection_focus_and_herd_controls() {
    let mut model = AppModel::new(vec![
        UiSession::new(
            "agent-a",
            0,
            "editor",
            "%1",
            0,
            AgentStatus::Running,
            "content a",
        ),
        UiSession::new(
            "agent-b",
            0,
            "editor",
            "%2",
            1,
            AgentStatus::Waiting,
            "content b",
        ),
        UiSession::new(
            "agent-c",
            1,
            "logs",
            "%3",
            0,
            AgentStatus::Stalled,
            "content c",
        ),
    ]);

    assert_eq!(model.selected_index(), 0);
    assert_eq!(model.focus(), FocusPane::Sessions);

    assert_eq!(
        model.handle_key(key(KeyCode::Char('j'))),
        AppEventResult::Continue
    );
    assert_eq!(model.selected_index(), 1);

    assert_eq!(
        model.handle_key(key(KeyCode::Char('k'))),
        AppEventResult::Continue
    );
    assert_eq!(model.selected_index(), 0);

    assert_eq!(
        model.handle_key(key(KeyCode::Char('G'))),
        AppEventResult::Continue
    );
    assert_eq!(model.selected_index(), 2);

    assert_eq!(
        model.handle_key(key(KeyCode::Char('g'))),
        AppEventResult::Continue
    );
    assert_eq!(model.selected_index(), 0);

    assert_eq!(
        model.handle_key(key(KeyCode::Char('L'))),
        AppEventResult::Continue
    );
    assert_eq!(model.focus(), FocusPane::Content);

    assert_eq!(
        model.handle_key(key(KeyCode::Char('H'))),
        AppEventResult::Continue
    );
    assert_eq!(model.focus(), FocusPane::Sessions);

    assert_eq!(
        model.handle_key(key(KeyCode::Char('J'))),
        AppEventResult::Continue
    );
    assert_eq!(model.focus(), FocusPane::Herds);

    assert_eq!(
        model.handle_key(key(KeyCode::Char('J'))),
        AppEventResult::Continue
    );
    assert_eq!(model.focus(), FocusPane::Details);

    assert_eq!(
        model.handle_key(key(KeyCode::Char('K'))),
        AppEventResult::Continue
    );
    assert_eq!(model.focus(), FocusPane::Herds);

    assert_eq!(
        model.handle_key(key(KeyCode::Char('K'))),
        AppEventResult::Continue
    );
    assert_eq!(model.focus(), FocusPane::Sessions);

    assert_eq!(
        model.handle_key(key(KeyCode::Char('K'))),
        AppEventResult::Continue
    );
    assert_eq!(model.focus(), FocusPane::Sessions);

    assert_eq!(
        model.handle_key(key(KeyCode::Char('J'))),
        AppEventResult::Continue
    );
    assert_eq!(model.focus(), FocusPane::Herds);

    assert_eq!(
        model.handle_key(key(KeyCode::Char('J'))),
        AppEventResult::Continue
    );
    assert_eq!(model.focus(), FocusPane::Details);

    assert!(!model.selected_session().expect("selected").herded);
    assert_eq!(
        model.handle_key(key(KeyCode::Enter)),
        AppEventResult::Continue
    );
    assert!(model.selected_session().expect("selected").herded);

    assert_eq!(
        model.handle_key(key(KeyCode::Char('n'))),
        AppEventResult::Continue
    );
    assert!(!model.selected_session().expect("selected").herded);

    assert_eq!(
        model.handle_key(key(KeyCode::Char('y'))),
        AppEventResult::Continue
    );
    assert!(model.selected_session().expect("selected").herded);
    assert_eq!(model.selected_session().expect("selected").herd_id, Some(0));

    assert_eq!(
        model.handle_key(key(KeyCode::Char('3'))),
        AppEventResult::Continue
    );
    assert!(model.selected_session().expect("selected").herded);
    assert_eq!(model.selected_session().expect("selected").herd_id, Some(3));

    assert_eq!(
        model.handle_key(key(KeyCode::Char('e'))),
        AppEventResult::Continue
    );
    assert_eq!(model.herd_mode(3), "Balanced");

    assert_eq!(
        model.handle_key(key(KeyCode::Char('J'))),
        AppEventResult::Continue
    );
    assert_eq!(model.focus(), FocusPane::Content);

    assert_eq!(
        model.handle_key(key(KeyCode::Char('K'))),
        AppEventResult::Continue
    );
    assert_eq!(model.focus(), FocusPane::Details);

    assert_eq!(
        model.handle_key(key(KeyCode::Char('K'))),
        AppEventResult::Continue
    );
    assert_eq!(model.focus(), FocusPane::Herds);

    assert_eq!(
        model.handle_key(key(KeyCode::Char('e'))),
        AppEventResult::Continue
    );
    assert_eq!(model.herd_mode(3), "Conservative");

    assert_eq!(
        model.handle_key(key(KeyCode::Char('-'))),
        AppEventResult::Continue
    );
    assert!(!model.selected_session().expect("selected").herded);
    assert_eq!(model.selected_session().expect("selected").herd_id, None);

    assert_eq!(
        model.handle_key(key(KeyCode::Char('q'))),
        AppEventResult::Quit
    );
}

#[test]
fn shift_hjkl_focus_navigation_matches_uppercase_shortcuts() {
    let mut model = AppModel::new(vec![
        UiSession::new(
            "agent-a",
            0,
            "editor",
            "%1",
            0,
            AgentStatus::Running,
            "content a",
        ),
        UiSession::new(
            "agent-b",
            0,
            "editor",
            "%2",
            1,
            AgentStatus::Waiting,
            "content b",
        ),
    ]);

    assert_eq!(model.focus(), FocusPane::Sessions);
    assert_eq!(
        model.handle_key(key_with_modifiers(KeyCode::Char('j'), KeyModifiers::SHIFT)),
        AppEventResult::Continue
    );
    assert_eq!(model.focus(), FocusPane::Herds);

    assert_eq!(
        model.handle_key(key_with_modifiers(KeyCode::Char('j'), KeyModifiers::SHIFT)),
        AppEventResult::Continue
    );
    assert_eq!(model.focus(), FocusPane::Details);

    assert_eq!(
        model.handle_key(key_with_modifiers(KeyCode::Char('k'), KeyModifiers::SHIFT)),
        AppEventResult::Continue
    );
    assert_eq!(model.focus(), FocusPane::Herds);

    assert_eq!(
        model.handle_key(key_with_modifiers(KeyCode::Char('l'), KeyModifiers::SHIFT)),
        AppEventResult::Continue
    );
    assert_eq!(model.focus(), FocusPane::Content);

    assert_eq!(
        model.handle_key(key_with_modifiers(KeyCode::Char('h'), KeyModifiers::SHIFT)),
        AppEventResult::Continue
    );
    assert_eq!(model.focus(), FocusPane::Sessions);
}

#[test]
fn content_focus_defaults_to_end_and_du_scroll_controls() {
    let content = (0..120)
        .map(|line| format!("line {line}"))
        .collect::<Vec<_>>()
        .join("\n");
    let mut model = AppModel::new(vec![UiSession::new(
        "agent-a",
        0,
        "editor",
        "%1",
        0,
        AgentStatus::Running,
        &content,
    )]);

    model.set_content_viewport_height(10);
    assert_eq!(
        model.handle_key(key(KeyCode::Char('L'))),
        AppEventResult::Continue
    );
    assert_eq!(model.focus(), FocusPane::Content);
    assert_eq!(model.content_scroll(), 110);

    assert_eq!(
        model.handle_key(key(KeyCode::Char('j'))),
        AppEventResult::Continue
    );
    assert_eq!(model.content_scroll(), 110);

    assert_eq!(
        model.handle_key(key(KeyCode::Char('u'))),
        AppEventResult::Continue
    );
    assert_eq!(model.content_scroll(), 100);

    assert_eq!(
        model.handle_key(key(KeyCode::Char('d'))),
        AppEventResult::Continue
    );
    assert_eq!(model.content_scroll(), 110);

    let updated_content = (0..130)
        .map(|line| format!("line {line}"))
        .collect::<Vec<_>>()
        .join("\n");
    model.set_sessions(vec![UiSession::new(
        "agent-a",
        0,
        "editor",
        "%1",
        0,
        AgentStatus::Running,
        &updated_content,
    )]);
    assert_eq!(model.content_scroll(), 120);
}

#[test]
fn content_scroll_position_is_saved_per_session_when_switching() {
    let content_a = (0..120)
        .map(|line| format!("a {line}"))
        .collect::<Vec<_>>()
        .join("\n");
    let content_b = (0..60)
        .map(|line| format!("b {line}"))
        .collect::<Vec<_>>()
        .join("\n");
    let mut model = AppModel::new(vec![
        UiSession::new(
            "agent-a",
            0,
            "editor",
            "%1",
            0,
            AgentStatus::Running,
            &content_a,
        ),
        UiSession::new(
            "agent-b",
            0,
            "logs",
            "%2",
            1,
            AgentStatus::Running,
            &content_b,
        ),
    ]);

    model.set_content_viewport_height(10);
    assert_eq!(
        model.handle_key(key(KeyCode::Char('L'))),
        AppEventResult::Continue
    );
    assert_eq!(model.content_scroll(), 110);

    assert_eq!(
        model.handle_key(key(KeyCode::Char('u'))),
        AppEventResult::Continue
    );
    assert_eq!(model.content_scroll(), 100);

    assert_eq!(
        model.handle_key(key(KeyCode::Char('H'))),
        AppEventResult::Continue
    );
    assert_eq!(
        model.handle_key(key(KeyCode::Char('j'))),
        AppEventResult::Continue
    );
    assert_eq!(model.selected_index(), 1);
    assert_eq!(model.content_scroll(), 50);

    assert_eq!(
        model.handle_key(key(KeyCode::Char('L'))),
        AppEventResult::Continue
    );
    assert_eq!(
        model.handle_key(key(KeyCode::Char('u'))),
        AppEventResult::Continue
    );
    assert_eq!(model.content_scroll(), 40);

    assert_eq!(
        model.handle_key(key(KeyCode::Char('H'))),
        AppEventResult::Continue
    );
    assert_eq!(
        model.handle_key(key(KeyCode::Char('k'))),
        AppEventResult::Continue
    );
    assert_eq!(model.selected_index(), 0);
    assert_eq!(model.content_scroll(), 100);

    assert_eq!(
        model.handle_key(key(KeyCode::Char('j'))),
        AppEventResult::Continue
    );
    assert_eq!(model.selected_index(), 1);
    assert_eq!(model.content_scroll(), 40);
}

#[test]
fn content_input_mode_toggles_and_blocks_command_shortcuts_until_escape() {
    let content = (0..50)
        .map(|line| format!("line {line}"))
        .collect::<Vec<_>>()
        .join("\n");
    let mut model = AppModel::new(vec![UiSession::new(
        "agent-a",
        0,
        "editor",
        "%1",
        0,
        AgentStatus::Running,
        &content,
    )]);

    model.set_content_viewport_height(10);
    assert_eq!(
        model.handle_key(key(KeyCode::Char('i'))),
        AppEventResult::Continue
    );
    assert_eq!(model.input_mode(), InputMode::Command);

    assert_eq!(
        model.handle_key(key(KeyCode::Char('L'))),
        AppEventResult::Continue
    );
    assert_eq!(model.focus(), FocusPane::Content);
    assert_eq!(model.content_scroll(), 40);
    assert_eq!(model.input_mode(), InputMode::Command);

    assert_eq!(
        model.handle_key(key(KeyCode::Char('i'))),
        AppEventResult::Continue
    );
    assert_eq!(model.input_mode(), InputMode::Input);
    assert_eq!(model.input_buffer(), "");
    assert_eq!(model.take_submitted_input(), None);

    assert_eq!(
        model.handle_key(key(KeyCode::Char('k'))),
        AppEventResult::Continue
    );
    assert_eq!(model.input_buffer(), "k");
    assert_eq!(model.take_submitted_input(), None);
    assert_eq!(model.content_scroll(), 40);

    let unsent_render = render_to_string(&model, 220, 24);
    assert!(unsent_render.contains("unsent>"));
    assert!(unsent_render.contains("k"));
    assert!(unsent_render.contains("[shift+enter/ctrl-s] send to tmux"));
    assert_eq!(
        model.handle_key(key(KeyCode::Char('H'))),
        AppEventResult::Continue
    );
    assert_eq!(model.input_buffer(), "kH");
    assert_eq!(model.focus(), FocusPane::Content);
    assert_eq!(
        model.handle_key(key(KeyCode::Char('q'))),
        AppEventResult::Continue
    );
    assert_eq!(model.input_buffer(), "kHq");

    assert_eq!(
        model.handle_key(key(KeyCode::Backspace)),
        AppEventResult::Continue
    );
    assert_eq!(model.input_buffer(), "kH");
    assert_eq!(model.take_submitted_input(), None);

    assert_eq!(
        model.handle_key(key(KeyCode::Enter)),
        AppEventResult::Continue
    );
    assert_eq!(model.input_buffer(), "kH\n");
    assert_eq!(model.take_submitted_input(), None);
    let multiline_unsent_render = render_to_string(&model, 220, 24);
    assert!(multiline_unsent_render.contains("unsent>"));
    assert!(multiline_unsent_render.contains("kH"));

    assert_eq!(
        model.handle_key(key_with_modifiers(KeyCode::Enter, KeyModifiers::SHIFT)),
        AppEventResult::Continue
    );
    assert_eq!(model.input_buffer(), "");
    assert_eq!(model.take_submitted_input().as_deref(), Some("kH\n"));
    assert_eq!(model.take_submitted_input(), None);

    assert_eq!(
        model.handle_key(key(KeyCode::Esc)),
        AppEventResult::Continue
    );
    assert_eq!(model.input_mode(), InputMode::Command);
    assert_eq!(
        model.handle_key(key(KeyCode::Char('k'))),
        AppEventResult::Continue
    );
    assert_eq!(model.content_scroll(), 39);
}

#[test]
fn submitted_input_dispatches_to_selected_tmux_pane() {
    let mut model = AppModel::new(vec![UiSession::new(
        "agent-a",
        0,
        "editor",
        "%1",
        0,
        AgentStatus::Running,
        "content",
    )]);
    let mut adapter = RecordingTmuxAdapter::default();

    assert_eq!(
        model.handle_key(key(KeyCode::Char('L'))),
        AppEventResult::Continue
    );
    assert_eq!(
        model.handle_key(key(KeyCode::Char('i'))),
        AppEventResult::Continue
    );
    assert_eq!(
        model.handle_key(key(KeyCode::Char('l'))),
        AppEventResult::Continue
    );
    assert_eq!(
        model.handle_key(key(KeyCode::Char('s'))),
        AppEventResult::Continue
    );
    assert_eq!(
        model.handle_key(key_with_modifiers(KeyCode::Enter, KeyModifiers::SHIFT)),
        AppEventResult::Continue
    );

    dispatch_submitted_input_to_selected_pane(&mut model, &mut adapter, None);

    assert_eq!(adapter.sent, vec![("%1".to_string(), "ls".to_string())]);
    assert_eq!(model.input_buffer(), "");
    assert_eq!(model.take_submitted_input(), None);
    assert_eq!(model.status_message(), Some("input sent to %1"));
}

#[test]
fn submitted_input_blocked_for_local_ui_pane_restores_unsent_draft() {
    let mut model = AppModel::new(vec![UiSession::new(
        "agent-a",
        0,
        "editor",
        "%1",
        0,
        AgentStatus::Running,
        "content",
    )]);
    let mut adapter = RecordingTmuxAdapter::default();

    assert_eq!(
        model.handle_key(key(KeyCode::Char('L'))),
        AppEventResult::Continue
    );
    assert_eq!(
        model.handle_key(key(KeyCode::Char('i'))),
        AppEventResult::Continue
    );
    assert_eq!(
        model.handle_key(key(KeyCode::Char('p'))),
        AppEventResult::Continue
    );
    assert_eq!(
        model.handle_key(key(KeyCode::Char('w'))),
        AppEventResult::Continue
    );
    assert_eq!(
        model.handle_key(key(KeyCode::Char('d'))),
        AppEventResult::Continue
    );
    assert_eq!(
        model.handle_key(key_with_modifiers(KeyCode::Enter, KeyModifiers::SHIFT)),
        AppEventResult::Continue
    );

    dispatch_submitted_input_to_selected_pane(&mut model, &mut adapter, Some("%1"));

    assert!(adapter.sent.is_empty());
    assert_eq!(model.input_mode(), InputMode::Input);
    assert_eq!(model.input_buffer(), "pwd");
    assert_eq!(
        model.status_message(),
        Some("input send blocked: selected pane is herd ui")
    );
}

#[test]
fn ctrl_s_submits_input_in_content_input_mode() {
    let mut model = AppModel::new(vec![UiSession::new(
        "agent-a",
        0,
        "editor",
        "%1",
        0,
        AgentStatus::Running,
        "content",
    )]);
    let mut adapter = RecordingTmuxAdapter::default();

    assert_eq!(
        model.handle_key(key(KeyCode::Char('L'))),
        AppEventResult::Continue
    );
    assert_eq!(
        model.handle_key(key(KeyCode::Char('i'))),
        AppEventResult::Continue
    );
    assert_eq!(
        model.handle_key(key(KeyCode::Char('e'))),
        AppEventResult::Continue
    );
    assert_eq!(
        model.handle_key(key(KeyCode::Char('c'))),
        AppEventResult::Continue
    );
    assert_eq!(
        model.handle_key(key(KeyCode::Char('h'))),
        AppEventResult::Continue
    );
    assert_eq!(
        model.handle_key(key(KeyCode::Char('o'))),
        AppEventResult::Continue
    );

    assert_eq!(
        model.handle_key(key_with_modifiers(
            KeyCode::Char('s'),
            KeyModifiers::CONTROL
        )),
        AppEventResult::Continue
    );
    dispatch_submitted_input_to_selected_pane(&mut model, &mut adapter, None);

    assert_eq!(adapter.sent, vec![("%1".to_string(), "echo".to_string())]);
    assert_eq!(model.input_buffer(), "");
    assert_eq!(model.take_submitted_input(), None);
}

#[test]
fn ctrl_s_control_char_variant_submits_input() {
    let mut model = AppModel::new(vec![UiSession::new(
        "agent-a",
        0,
        "editor",
        "%1",
        0,
        AgentStatus::Running,
        "content",
    )]);
    let mut adapter = RecordingTmuxAdapter::default();

    assert_eq!(
        model.handle_key(key(KeyCode::Char('L'))),
        AppEventResult::Continue
    );
    assert_eq!(
        model.handle_key(key(KeyCode::Char('i'))),
        AppEventResult::Continue
    );
    assert_eq!(
        model.handle_key(key(KeyCode::Char('p'))),
        AppEventResult::Continue
    );
    assert_eq!(
        model.handle_key(key(KeyCode::Char('w'))),
        AppEventResult::Continue
    );
    // DC3 control char variant that some terminals produce for Ctrl+S.
    assert_eq!(
        model.handle_key(key(KeyCode::Char('\u{13}'))),
        AppEventResult::Continue
    );
    dispatch_submitted_input_to_selected_pane(&mut model, &mut adapter, None);

    assert_eq!(adapter.sent, vec![("%1".to_string(), "pw".to_string())]);
    assert_eq!(model.input_buffer(), "");
}

#[test]
fn status_bar_shows_active_pane_and_input_mode() {
    let mut model = AppModel::new(vec![UiSession::new(
        "agent-a",
        0,
        "editor",
        "%1",
        0,
        AgentStatus::Running,
        "content",
    )]);

    let command_render = render_to_string(&model, 220, 20);
    assert!(command_render.contains("pane: sessions"));
    assert!(command_render.contains("mode: command"));

    assert_eq!(
        model.handle_key(key(KeyCode::Char('L'))),
        AppEventResult::Continue
    );
    assert_eq!(
        model.handle_key(key(KeyCode::Char('i'))),
        AppEventResult::Continue
    );
    let input_render = render_to_string(&model, 220, 20);
    assert!(input_render.contains("pane: content"));
    assert!(input_render.contains("mode: input"));
}

#[test]
fn herder_log_pane_is_always_visible_and_focusable() {
    let mut model = AppModel::new(vec![UiSession::new(
        "agent-a",
        0,
        "editor",
        "%1",
        0,
        AgentStatus::Running,
        "content",
    )]);

    let initial = render_to_string(&model, 220, 28);
    assert!(initial.contains("Herder Log"));
    assert!(initial.contains("No herder activity yet"));

    assert_eq!(
        model.handle_key(key(KeyCode::Char('L'))),
        AppEventResult::Continue
    );
    assert_eq!(model.focus(), FocusPane::Content);
    assert_eq!(
        model.handle_key(key(KeyCode::Char('J'))),
        AppEventResult::Continue
    );
    assert_eq!(model.focus(), FocusPane::HerderLog);

    let focused = render_to_string(&model, 220, 28);
    assert!(focused.contains("pane: herder_log"));
    assert!(focused.contains("[herder log] [j/k] scroll"));
    assert!(focused.contains("[0-9] filter"));
}

#[test]
fn herder_log_supports_numeric_filtering_by_herd() {
    let mut model = AppModel::new(vec![UiSession::new(
        "agent-a",
        0,
        "editor",
        "%1",
        0,
        AgentStatus::Running,
        "content",
    )]);
    model.push_herder_log_for_herd(Some(1), "herd one event");
    model.push_herder_log_for_herd(Some(2), "herd two event");
    model.push_herder_log("system event");

    assert_eq!(
        model.handle_key(key(KeyCode::Char('L'))),
        AppEventResult::Continue
    );
    assert_eq!(
        model.handle_key(key(KeyCode::Char('J'))),
        AppEventResult::Continue
    );
    assert_eq!(model.focus(), FocusPane::HerderLog);

    let unfiltered = render_to_string(&model, 220, 28);
    assert!(unfiltered.contains("[1]["));
    assert!(unfiltered.contains("[2]["));
    assert!(unfiltered.contains("[-]["));
    assert!(unfiltered.contains("herd one event"));
    assert!(unfiltered.contains("herd two event"));
    assert!(unfiltered.contains("system event"));

    assert_eq!(
        model.handle_key(key(KeyCode::Char('2'))),
        AppEventResult::Continue
    );
    let herd_two_only = render_to_string(&model, 220, 28);
    assert!(!herd_two_only.contains("[1]["));
    assert!(herd_two_only.contains("[2]["));
    assert!(!herd_two_only.contains("[-]["));
    assert!(!herd_two_only.contains("herd one event"));
    assert!(herd_two_only.contains("herd two event"));
    assert!(!herd_two_only.contains("system event"));

    assert_eq!(
        model.handle_key(key(KeyCode::Char('-'))),
        AppEventResult::Continue
    );
    let cleared = render_to_string(&model, 220, 28);
    assert!(cleared.contains("herd one event"));
    assert!(cleared.contains("herd two event"));
    assert!(cleared.contains("system event"));
}

#[test]
fn comma_opens_settings_overlay() {
    let mut model = AppModel::new(vec![UiSession::new(
        "agent-a",
        0,
        "editor",
        "%1",
        0,
        AgentStatus::Running,
        "content",
    )]);

    assert_eq!(
        model.handle_key(key(KeyCode::Char(','))),
        AppEventResult::Continue
    );
    let rendered = render_to_string(&model, 220, 24);
    assert!(rendered.contains("Settings"));
    assert!(rendered.contains("General"));
    assert!(rendered.contains("Provider Keys"));
    assert!(rendered.contains("Model Selection"));
    assert!(rendered.contains("Herd Modes"));
    assert!(rendered.contains("Herd Count"));
    assert!(rendered.contains("OpenAI Key"));
    assert!(rendered.contains("Anthropic Key"));
    assert!(rendered.contains("[settings] [j/k] select"));
}

#[test]
fn enter_on_model_field_opens_dropdown_and_supports_custom_model_typing() {
    let mut model = AppModel::new(vec![UiSession::new(
        "agent-a",
        0,
        "editor",
        "%1",
        0,
        AgentStatus::Running,
        "content",
    )]);

    assert_eq!(
        model.handle_key(key(KeyCode::Char(','))),
        AppEventResult::Continue
    );
    for _ in 0..4 {
        assert_eq!(
            model.handle_key(key(KeyCode::Char('j'))),
            AppEventResult::Continue
        );
    }

    assert_eq!(
        model.handle_key(key(KeyCode::Enter)),
        AppEventResult::Continue
    );
    let rendered_dropdown = render_to_string(&model, 240, 30);
    assert!(rendered_dropdown.contains("Model List"));
    assert!(rendered_dropdown.contains("Custom model name"));
    assert!(rendered_dropdown.contains("[model list] [j/k] move"));

    assert_eq!(
        model.handle_key(key(KeyCode::Char('x'))),
        AppEventResult::Continue
    );
    let rendered_custom = render_to_string(&model, 240, 30);
    assert!(!rendered_custom.contains("Model List"));
    assert!(rendered_custom.contains("editing"));
    assert!(rendered_custom.contains("x"));
}

#[test]
fn herd_mode_prompt_editor_opens_from_settings() {
    let mut model = AppModel::new(vec![UiSession::new(
        "agent-a",
        0,
        "editor",
        "%1",
        0,
        AgentStatus::Running,
        "content",
    )]);

    assert_eq!(
        model.handle_key(key(KeyCode::Char(','))),
        AppEventResult::Continue
    );
    for _ in 0..9 {
        assert_eq!(
            model.handle_key(key(KeyCode::Char('j'))),
            AppEventResult::Continue
        );
    }
    assert_eq!(
        model.handle_key(key(KeyCode::Enter)),
        AppEventResult::Continue
    );

    let rendered_editor = render_to_string(&model, 240, 32);
    assert!(rendered_editor.contains("Herd Mode Rules"));
    assert!(rendered_editor.contains("[rules] edit json"));

    assert_eq!(
        model.handle_key(key(KeyCode::Esc)),
        AppEventResult::Continue
    );
    let rendered_closed = render_to_string(&model, 240, 32);
    assert!(!rendered_closed.contains("Herd Mode Rules"));
}

#[test]
fn settings_herd_modes_can_be_added_renamed_and_removed() {
    let mut model = AppModel::new(vec![UiSession::new(
        "agent-a",
        0,
        "editor",
        "%1",
        0,
        AgentStatus::Running,
        "content",
    )]);

    assert_eq!(
        model.handle_key(key(KeyCode::Char(','))),
        AppEventResult::Continue
    );
    for _ in 0..10 {
        assert_eq!(
            model.handle_key(key(KeyCode::Char('j'))),
            AppEventResult::Continue
        );
    }
    assert_eq!(
        model.handle_key(key(KeyCode::Enter)),
        AppEventResult::Continue
    );

    let rendered_added = render_to_string(&model, 240, 32);
    assert!(rendered_added.contains("4/4 (Mode 4)"));
    assert!(rendered_added.contains("herd_modes/mode-4.json"));

    for _ in 0..3 {
        assert_eq!(
            model.handle_key(key(KeyCode::Char('k'))),
            AppEventResult::Continue
        );
    }
    assert_eq!(
        model.handle_key(key(KeyCode::Enter)),
        AppEventResult::Continue
    );
    assert_eq!(
        model.handle_key(key(KeyCode::Enter)),
        AppEventResult::Continue
    );
    let rendered_same_name = render_to_string(&model, 240, 32);
    assert!(rendered_same_name.contains("herd_modes/mode-4.json"));

    assert_eq!(
        model.handle_key(key(KeyCode::Enter)),
        AppEventResult::Continue
    );
    assert_eq!(
        model.handle_key(key(KeyCode::Char('x'))),
        AppEventResult::Continue
    );
    assert_eq!(
        model.handle_key(key(KeyCode::Enter)),
        AppEventResult::Continue
    );

    let rendered_renamed = render_to_string(&model, 240, 32);
    assert!(rendered_renamed.contains("Mode 4x"));
    assert!(rendered_renamed.contains("herd_modes/mode-4x.json"));

    for _ in 0..4 {
        assert_eq!(
            model.handle_key(key(KeyCode::Char('j'))),
            AppEventResult::Continue
        );
    }
    assert_eq!(
        model.handle_key(key(KeyCode::Enter)),
        AppEventResult::Continue
    );

    let rendered_removed = render_to_string(&model, 240, 32);
    assert!(rendered_removed.contains("3/3 (Aggressive)"));
    assert!(!rendered_removed.contains("Mode 4x"));
}

#[test]
fn settings_overlay_intercepts_quit_until_closed() {
    let mut model = AppModel::new(vec![UiSession::new(
        "agent-a",
        0,
        "editor",
        "%1",
        0,
        AgentStatus::Running,
        "content",
    )]);

    assert_eq!(
        model.handle_key(key(KeyCode::Char(','))),
        AppEventResult::Continue
    );
    assert_eq!(
        model.handle_key(key(KeyCode::Char('q'))),
        AppEventResult::Continue
    );
    assert_eq!(
        model.handle_key(key(KeyCode::Esc)),
        AppEventResult::Continue
    );
    assert_eq!(
        model.handle_key(key(KeyCode::Char('q'))),
        AppEventResult::Quit
    );
}

#[test]
fn render_contains_left_session_list_and_right_content_pane() {
    let model = AppModel::new(vec![
        UiSession::new(
            "agent-a",
            0,
            "editor",
            "%1",
            0,
            AgentStatus::Running,
            "line one\nline two",
        )
        .with_runtime("claude".to_string(), true),
        UiSession::new("agent-b", 1, "logs", "%2", 1, AgentStatus::Finished, "done")
            .with_runtime("zsh".to_string(), false),
    ]);

    let rendered = render_to_string(&model, 140, 30);

    assert!(rendered.contains("Sessions"));
    assert!(rendered.contains("Herds"));
    assert!(rendered.contains("Details"));
    assert!(
        rendered.find("Herds").unwrap_or(usize::MAX)
            < rendered.find("Details").unwrap_or(usize::MAX)
    );
    assert!(rendered.contains("Content"));
    assert!(rendered.contains("server (online)"));
    assert!(
        rendered.find("server (online)").unwrap_or(usize::MAX)
            < rendered.find("session: agent-a").unwrap_or(usize::MAX)
    );
    assert!(rendered.contains("session: agent-a"));
    assert!(
        rendered.find("session: agent-a").unwrap_or(usize::MAX)
            < rendered.find("window 0:editor").unwrap_or(usize::MAX)
    );
    assert!(rendered.contains("window 0:editor"));
    let first_row = rendered
        .lines()
        .find(|line| line.contains("0:1"))
        .unwrap_or_default();
    assert!(first_row.contains("claude"));
    assert!(first_row.contains("(running)"));
    assert!(first_row.contains("h:-"));
    let second_row = rendered
        .lines()
        .find(|line| line.contains("1:2") && line.contains("none"))
        .unwrap_or_default();
    assert!(second_row.contains("none"));
    assert!(second_row.contains("n/a"));
    assert!(second_row.contains("h:-"));
    assert!(!rendered.contains("run=claude"));
    assert!(rendered.contains("process"));
    assert!(rendered.contains("agent"));
    assert!(rendered.contains("source"));
    assert!(rendered.contains("tmux heuristic"));
    assert!(rendered.contains("herd"));
    assert!(!rendered.contains("process:"));
    assert!(!rendered.contains("agent:"));
    assert!(!rendered.contains("herd:"));
    assert!(rendered.contains("0  Balanced"));
    assert!(rendered.contains("line one"));
}

#[test]
fn sessions_pane_shows_tmux_server_offline_status_header() {
    let mut model = AppModel::new(vec![UiSession::new(
        "agent-a",
        0,
        "editor",
        "%1",
        0,
        AgentStatus::Running,
        "content",
    )]);
    model.set_tmux_server_offline("tmux [\"list-panes\"] failed: no server running on /tmp/tmux");

    let rendered = render_to_string(&model, 140, 30);
    assert!(rendered.contains("server (offline: no server running)"));
    assert!(rendered.contains("session: agent-a"));
    assert!(rendered.contains("window 0:editor"));
}

#[test]
fn details_show_codex_status_source_or_tmux_fallback() {
    let codex_model = AppModel::new(vec![
        UiSession::new(
            "agent-a",
            0,
            "editor",
            "%1",
            0,
            AgentStatus::Running,
            "line one\nline two",
        )
        .with_runtime("codex".to_string(), true)
        .with_status_source(StatusSource::CodexAppServer),
    ]);
    let codex_rendered = render_to_string(&codex_model, 140, 30);
    assert!(codex_rendered.contains("source"));
    assert!(codex_rendered.contains("codex app-server"));

    let fallback_model = AppModel::new(vec![
        UiSession::new(
            "agent-a",
            0,
            "editor",
            "%1",
            0,
            AgentStatus::Running,
            "line one\nline two",
        )
        .with_runtime("codex".to_string(), true)
        .with_status_source(StatusSource::TmuxFallback),
    ]);
    let fallback_rendered = render_to_string(&fallback_model, 140, 30);
    assert!(fallback_rendered.contains("source"));
    assert!(fallback_rendered.contains("tmux fallback"));
}

#[test]
fn render_content_parses_ansi_sequences_without_showing_escape_codes() {
    let model = AppModel::new(vec![UiSession::new(
        "agent-a",
        0,
        "editor",
        "%1",
        0,
        AgentStatus::Running,
        "\u{1b}[31mred\u{1b}[0m normal",
    )]);

    let rendered = render_to_string(&model, 100, 20);

    assert!(rendered.contains("red normal"));
    assert!(!rendered.contains('\u{1b}'));
    assert!(!rendered.contains("[31m"));
}

#[test]
fn render_content_lines_stay_column_aligned_without_diagonal_shift() {
    let model = AppModel::new(vec![UiSession::new(
        "agent-a",
        0,
        "editor",
        "%1",
        0,
        AgentStatus::Running,
        "herd_line_a\nherd_line_b\nherd_line_c",
    )]);

    let width: u16 = 120;
    let height: u16 = 24;
    let rendered = render_to_string(&model, width, height);
    let cells: Vec<char> = rendered.chars().collect();
    let rows: Vec<String> = cells
        .chunks(usize::from(width))
        .map(|row| row.iter().collect::<String>())
        .collect();

    let pos_a = rows
        .iter()
        .enumerate()
        .find_map(|(row_idx, row)| row.find("herd_line_a").map(|byte_idx| (row_idx, byte_idx)))
        .expect("row for herd_line_a should exist");
    let pos_b = rows
        .iter()
        .enumerate()
        .find_map(|(row_idx, row)| row.find("herd_line_b").map(|byte_idx| (row_idx, byte_idx)))
        .expect("row for herd_line_b should exist");
    let pos_c = rows
        .iter()
        .enumerate()
        .find_map(|(row_idx, row)| row.find("herd_line_c").map(|byte_idx| (row_idx, byte_idx)))
        .expect("row for herd_line_c should exist");
    let col_a = rows[pos_a.0][..pos_a.1].chars().count();
    let col_b = rows[pos_b.0][..pos_b.1].chars().count();
    let col_c = rows[pos_c.0][..pos_c.1].chars().count();

    assert_eq!(
        col_a, col_b,
        "cols differ: a={:?} b={:?} c={:?}\nrow_a={}\nrow_b={}\nrow_c={}",
        pos_a, pos_b, pos_c, rows[pos_a.0], rows[pos_b.0], rows[pos_c.0]
    );
    assert_eq!(
        col_b, col_c,
        "cols differ: a={:?} b={:?} c={:?}\nrow_a={}\nrow_b={}\nrow_c={}",
        pos_a, pos_b, pos_c, rows[pos_a.0], rows[pos_b.0], rows[pos_c.0]
    );
}

#[test]
fn render_displays_content_scrollbar_for_overflowing_output() {
    let content = (0..120)
        .map(|line| format!("line {line}"))
        .collect::<Vec<_>>()
        .join("\n");
    let model = AppModel::new(vec![UiSession::new(
        "agent-a",
        0,
        "editor",
        "%1",
        0,
        AgentStatus::Running,
        &content,
    )]);

    let rendered = render_to_string(&model, 80, 15);

    assert!(rendered.contains("█"));
}

#[test]
fn content_scrollbar_thumb_reaches_bottom_when_at_tail() {
    let content = (0..200)
        .map(|line| format!("line {line}"))
        .collect::<Vec<_>>()
        .join("\n");
    let model = AppModel::new(vec![UiSession::new(
        "agent-a",
        0,
        "editor",
        "%1",
        0,
        AgentStatus::Running,
        &content,
    )]);

    let width: u16 = 100;
    let height: u16 = 26;
    let rendered = render_to_string(&model, width, height);
    let cells: Vec<char> = rendered.chars().collect();
    let row_width = usize::from(width);
    let rows: Vec<&[char]> = cells.chunks(row_width).collect();

    let mut best_col = None;
    let mut best_count = 0usize;
    for col in 0..row_width {
        let count = rows
            .iter()
            .filter(|row| matches!(row[col], '┆' | '█'))
            .count();
        if count > best_count {
            best_count = count;
            best_col = Some(col);
        }
    }

    let col = best_col.expect("expected scrollbar column");
    assert!(best_count > 0, "expected scrollbar symbols to render");

    let max_track_row = rows
        .iter()
        .enumerate()
        .filter_map(|(row_idx, row)| matches!(row[col], '┆' | '█').then_some(row_idx))
        .max()
        .expect("expected scrollbar track rows");
    let max_thumb_row = rows
        .iter()
        .enumerate()
        .filter_map(|(row_idx, row)| (row[col] == '█').then_some(row_idx))
        .max()
        .expect("expected scrollbar thumb rows");

    assert_eq!(max_thumb_row, max_track_row);
}
