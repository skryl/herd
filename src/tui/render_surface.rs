use ratatui::backend::TestBackend;
use ratatui::layout::{Constraint, Direction, Layout};
use ratatui::{Frame, Terminal};

use super::render_left_panes::{render_details_pane, render_herds_pane, render_sessions_pane};
use super::render_right_panes::{render_content_pane, render_herder_log_pane};
use super::render_sections::{PaneStyles, build_app_bar_text, render_status_bar};
use super::settings_render::render_settings_overlay;
use super::{AppModel, now_unix};

pub(super) fn render_to_string(model: &AppModel, width: u16, height: u16) -> String {
    let backend = TestBackend::new(width, height);
    let mut terminal = Terminal::new(backend).expect("test terminal should construct");
    let mut preview = model.clone();
    terminal
        .draw(|frame| render(frame, &mut preview))
        .expect("test draw should succeed");
    let buffer = terminal.backend().buffer();
    buffer
        .content
        .iter()
        .map(|cell| cell.symbol())
        .collect::<Vec<_>>()
        .join("")
}

pub(super) fn render(frame: &mut Frame<'_>, model: &mut AppModel) {
    let root = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(1), Constraint::Length(1)])
        .split(frame.area());
    let body = root[0];
    let status_bar = root[1];

    let columns = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(35), Constraint::Percentage(65)])
        .split(body);

    let app_bar_text = build_app_bar_text(model);
    let styles = PaneStyles::from_focus(model.focus());
    let now_unix = now_unix();

    let left_chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Percentage(54),
            Constraint::Percentage(26),
            Constraint::Percentage(20),
        ])
        .split(columns[0]);

    render_sessions_pane(frame, model, left_chunks[0], now_unix, styles);
    render_herds_pane(frame, model, left_chunks[1], styles);
    render_details_pane(frame, model, left_chunks[2], now_unix, styles);

    let right_chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Percentage(70), Constraint::Percentage(30)])
        .split(columns[1]);
    render_content_pane(frame, model, right_chunks[0], styles);
    render_herder_log_pane(frame, model, right_chunks[1], styles);

    render_status_bar(frame, model, status_bar, app_bar_text);

    if model.is_settings_overlay_open() {
        render_settings_overlay(frame, model);
    }
}
