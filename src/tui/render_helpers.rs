use std::collections::HashSet;

use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};

use super::{AppModel, TmuxServerStatus, UiSession};

pub(super) use super::render_text_utils::{
    format_aligned_details, format_full_timestamp, format_relative_age,
    format_unsent_input_preview_lines, herd_color, herd_label, normalize_snapshot_newlines_for_vt,
    pane_label, status_label, status_source_style, status_value_style, unsent_input_hint_rows,
};

pub(super) struct LeftRow {
    pub(super) line: Line<'static>,
    pub(super) session_index: Option<usize>,
}

#[derive(Default)]
struct PaneColumnWidths {
    pane: usize,
    agent: usize,
    status: usize,
    herd: usize,
}

fn herd_value_style(session: &UiSession) -> Style {
    if let Some(herd_id) = session.herd_id {
        Style::default().fg(herd_color(herd_id))
    } else {
        Style::default().fg(Color::DarkGray)
    }
}

pub(super) fn build_left_rows(model: &AppModel, now_unix: i64) -> Vec<LeftRow> {
    let mut rows = Vec::new();
    let mut current_session: Option<String> = None;
    let mut current_window: Option<(i64, String)> = None;
    let (server_status_text, server_style) = match &model.tmux_server_status {
        TmuxServerStatus::Online => (
            "online".to_string(),
            Style::default()
                .fg(Color::Green)
                .add_modifier(Modifier::BOLD),
        ),
        TmuxServerStatus::Offline(reason) => (
            format!("offline: {}", summarize_tmux_server_error(reason)),
            Style::default().fg(Color::Red).add_modifier(Modifier::BOLD),
        ),
    };
    rows.push(LeftRow {
        line: Line::from(vec![
            Span::styled(
                "server ",
                Style::default()
                    .fg(Color::Yellow)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(format!("({server_status_text})"), server_style),
        ]),
        session_index: None,
    });
    let mut column_widths = PaneColumnWidths::default();
    for session in &model.sessions {
        column_widths.pane = column_widths.pane.max(pane_label(session).len());
        column_widths.agent = column_widths.agent.max(session.agent_name.len());
        column_widths.status = column_widths.status.max(status_label(session).len());
        column_widths.herd = column_widths.herd.max(herd_label(session).len());
    }
    let highlighted_windows: HashSet<String> = model
        .sessions
        .iter()
        .filter(|session| session.highlighted)
        .map(|session| {
            format!(
                "{}::{}::{}",
                session.session_name, session.window_index, session.window_name
            )
        })
        .collect();
    let highlighted_sessions: HashSet<String> = model
        .sessions
        .iter()
        .filter(|session| session.highlighted)
        .map(|session| session.session_name.clone())
        .collect();

    for (index, session) in model.sessions.iter().enumerate() {
        if current_session.as_deref() != Some(session.session_name.as_str()) {
            current_session = Some(session.session_name.clone());
            current_window = None;
            let session_style = if highlighted_sessions.contains(&session.session_name) {
                Style::default()
                    .fg(Color::Green)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default()
                    .fg(Color::Yellow)
                    .add_modifier(Modifier::BOLD)
            };
            rows.push(LeftRow {
                line: Line::from(Span::styled(
                    format!("  session: {}", session.session_name),
                    session_style,
                )),
                session_index: None,
            });
        }

        if current_window
            .as_ref()
            .map(|(index, name)| (*index, name.as_str()))
            != Some((session.window_index, session.window_name.as_str()))
        {
            current_window = Some((session.window_index, session.window_name.clone()));
            let window_key = format!(
                "{}::{}::{}",
                session.session_name, session.window_index, session.window_name
            );
            let window_style = if highlighted_windows.contains(&window_key) {
                Style::default()
                    .fg(Color::Green)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default()
                    .fg(Color::LightBlue)
                    .add_modifier(Modifier::BOLD)
            };
            rows.push(LeftRow {
                line: Line::from(Span::styled(
                    format!(
                        "    window {}:{}",
                        session.window_index, session.window_name
                    ),
                    window_style,
                )),
                session_index: None,
            });
        }

        let highlighted = session.highlighted;
        let herd_tint = session.herd_id.map(herd_color);
        let pane_style = if let Some(color) = herd_tint {
            let mut style = Style::default().fg(color);
            if highlighted {
                style = style.add_modifier(Modifier::BOLD);
            }
            style
        } else if highlighted {
            Style::default().fg(Color::Green)
        } else {
            Style::default()
        };
        let status_text = status_label(session);
        let pane_text = pane_label(session);
        let agent_text = session.agent_name.clone();
        let age_text = format_relative_age(session.last_update_unix, now_unix);
        let status_style = herd_tint
            .map(|color| Style::default().fg(color))
            .unwrap_or_else(|| status_value_style(session.status, session.status_tracked));
        let herd_text = herd_label(session);
        let herd_style = herd_value_style(session);
        let age_style = herd_tint
            .map(|color| Style::default().fg(color).add_modifier(Modifier::DIM))
            .unwrap_or_else(|| Style::default().fg(Color::DarkGray));
        let line = Line::from(vec![
            Span::styled(
                format!(
                    "      {:<pane_width$}  ",
                    pane_text,
                    pane_width = column_widths.pane
                ),
                pane_style,
            ),
            Span::styled(
                format!(
                    "{:<agent_width$}",
                    agent_text,
                    agent_width = column_widths.agent
                ),
                pane_style,
            ),
            Span::raw("  ("),
            Span::styled(
                format!(
                    "{:<status_width$}",
                    status_text,
                    status_width = column_widths.status
                ),
                status_style,
            ),
            Span::raw(")  h:"),
            Span::styled(
                format!(
                    "{:<herd_width$}",
                    herd_text,
                    herd_width = column_widths.herd
                ),
                herd_style,
            ),
            Span::raw("  ["),
            Span::styled(age_text, age_style),
            Span::raw("]"),
        ]);
        rows.push(LeftRow {
            line,
            session_index: Some(index),
        });
    }

    rows
}

fn summarize_tmux_server_error(error: &str) -> String {
    let trimmed = error.trim();
    if trimmed.is_empty() {
        return "error".to_string();
    }
    if trimmed.contains("no server running") {
        return "no server running".to_string();
    }
    let first_line = trimmed.lines().next().unwrap_or(trimmed);
    if first_line.len() <= 64 {
        first_line.to_string()
    } else {
        format!("{}...", &first_line[..61])
    }
}

pub(super) fn split_body_and_hint(area: Rect) -> (Rect, Option<Rect>) {
    if area.height <= 1 {
        (area, None)
    } else {
        let sections = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Min(1), Constraint::Length(1)])
            .split(area);
        (sections[0], Some(sections[1]))
    }
}

pub(super) fn split_body_and_hint_rows(area: Rect, hint_rows: u16) -> (Rect, Option<Rect>) {
    let rows = hint_rows.max(1);
    if area.height <= rows {
        (area, None)
    } else {
        let sections = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Min(1), Constraint::Length(rows)])
            .split(area);
        (sections[0], Some(sections[1]))
    }
}
