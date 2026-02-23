use ratatui::Frame;
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::widgets::Paragraph;

use super::{AppModel, FocusPane, InputMode};

#[derive(Clone, Copy)]
pub(super) struct PaneStyles {
    pub(super) sessions_border: Style,
    pub(super) sessions_hint: Style,
    pub(super) herds_border: Style,
    pub(super) herds_hint: Style,
    pub(super) details_border: Style,
    pub(super) details_hint: Style,
    pub(super) content_border: Style,
    pub(super) content_hint: Style,
    pub(super) herder_log_border: Style,
    pub(super) herder_log_hint: Style,
}

impl PaneStyles {
    pub(super) fn from_focus(focus: FocusPane) -> Self {
        Self {
            sessions_border: border_style(focus == FocusPane::Sessions),
            sessions_hint: hint_style(focus == FocusPane::Sessions),
            herds_border: border_style(focus == FocusPane::Herds),
            herds_hint: hint_style(focus == FocusPane::Herds),
            details_border: border_style(focus == FocusPane::Details),
            details_hint: hint_style(focus == FocusPane::Details),
            content_border: border_style(focus == FocusPane::Content),
            content_hint: hint_style(focus == FocusPane::Content),
            herder_log_border: border_style(focus == FocusPane::HerderLog),
            herder_log_hint: hint_style(focus == FocusPane::HerderLog),
        }
    }
}

fn border_style(is_focused: bool) -> Style {
    if is_focused {
        Style::default()
            .fg(Color::Green)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(Color::DarkGray)
    }
}

fn hint_style(is_focused: bool) -> Style {
    if is_focused {
        Style::default()
            .fg(Color::Green)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(Color::Gray)
    }
}

pub(super) fn build_app_bar_text(model: &AppModel) -> String {
    let pane = match model.focus {
        FocusPane::Sessions => "sessions",
        FocusPane::Herds => "herds",
        FocusPane::Details => "details",
        FocusPane::Content => "content",
        FocusPane::HerderLog => "herder_log",
    };
    let mode = match model.input_mode {
        InputMode::Command => "command",
        InputMode::Input => "input",
    };
    let selected_summary = model
        .selected_session()
        .map(|selected| {
            format!(
                "{} / {}:{} / pane {}",
                selected.session_name,
                selected.window_index,
                selected.window_name,
                selected.pane_index
            )
        })
        .unwrap_or_else(|| "none".to_string());
    let mut text = format!(
        " herd  |  pane: {}  |  mode: {}  |  selected: {} ",
        pane, mode, selected_summary
    );
    if model.input_mode == InputMode::Input {
        text.push_str("| input: ");
        text.push_str(model.input_buffer());
        text.push(' ');
    }
    text
}

pub(super) fn render_status_bar(
    frame: &mut Frame<'_>,
    model: &AppModel,
    area: Rect,
    app_bar_text: String,
) {
    let status_text = if let Some(message) = &model.status_message {
        format!("{app_bar_text} | {message}")
    } else {
        app_bar_text
    };
    let shortcuts = if model.is_herd_mode_prompt_editor_open() {
        "[rules] edit json  [enter] newline  [ctrl-s] save  [esc] cancel"
    } else if model.is_model_dropdown_open() {
        "[model list] [j/k] move [enter] select [type] custom model [esc] close"
    } else if model.is_settings_overlay_open() {
        "[settings] [j/k] select [i] edit [h/l] cycle  [enter] action  [r] refresh [s] save [esc] close"
    } else if model.input_mode == InputMode::Input {
        "[shift+enter/ctrl-s] send input  [enter] newline  [backspace] edit  [esc] command mode"
    } else if model.focus == FocusPane::HerderLog {
        "[herder log] [j/k] scroll [u/d] page [g/G] top/bottom [0-9] filter [a/-] all"
    } else {
        "[H/J/K/L] panes  [h/l] left/right  [i] input  [,] settings  [0-9] herd  [-] clear  [q] quit"
    };

    let shortcuts_width = shortcuts.len().min(u16::MAX as usize) as u16;
    let status_style = Style::default().fg(Color::Black).bg(Color::Green);

    if area.width > shortcuts_width + 1 {
        let bar_chunks = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Min(1), Constraint::Length(shortcuts_width)])
            .split(area);
        frame.render_widget(
            Paragraph::new(status_text).style(status_style),
            bar_chunks[0],
        );
        frame.render_widget(Paragraph::new(shortcuts).style(status_style), bar_chunks[1]);
    } else {
        frame.render_widget(Paragraph::new(shortcuts).style(status_style), area);
    }
}
