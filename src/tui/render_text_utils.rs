use chrono::{Local, TimeZone};
use ratatui::style::{Color, Style};
use ratatui::text::{Line, Span, Text};

use crate::agent::AgentStatus;

use super::{StatusSource, UiSession};

pub(super) fn pane_label(session: &UiSession) -> String {
    let pane_target = {
        let raw = session.pane_id.trim_start_matches('%');
        if raw.is_empty() {
            session.pane_index.to_string()
        } else {
            raw.to_string()
        }
    };
    format!("{}:{}", session.window_index, pane_target)
}

pub(super) fn status_label(session: &UiSession) -> String {
    if session.status_tracked {
        session.status.as_str().to_string()
    } else {
        "n/a".to_string()
    }
}

pub(super) fn herd_label(session: &UiSession) -> String {
    session
        .herd_id
        .map(|herd_id| herd_id.to_string())
        .unwrap_or_else(|| "-".to_string())
}

pub(super) fn status_value_style(status: AgentStatus, tracked: bool) -> Style {
    if !tracked {
        return Style::default().fg(Color::DarkGray);
    }
    match status {
        AgentStatus::Running => Style::default().fg(Color::Green),
        AgentStatus::Waiting => Style::default().fg(Color::Yellow),
        AgentStatus::Finished => Style::default().fg(Color::LightBlue),
        AgentStatus::Stalled => Style::default().fg(Color::Red),
        AgentStatus::Unknown => Style::default().fg(Color::Gray),
    }
}

pub(super) fn status_source_style(source: StatusSource) -> Style {
    match source {
        StatusSource::CodexAppServer => Style::default().fg(Color::LightCyan),
        StatusSource::TmuxFallback => Style::default().fg(Color::Yellow),
        StatusSource::TmuxHeuristic => Style::default().fg(Color::Gray),
        StatusSource::NotTracked => Style::default().fg(Color::DarkGray),
    }
}

pub(super) fn herd_color(herd_id: u8) -> Color {
    match herd_id % 10 {
        0 => Color::LightCyan,
        1 => Color::LightGreen,
        2 => Color::LightYellow,
        3 => Color::LightMagenta,
        4 => Color::LightBlue,
        5 => Color::Cyan,
        6 => Color::Green,
        7 => Color::Yellow,
        8 => Color::Magenta,
        _ => Color::Blue,
    }
}

pub(super) fn format_relative_age(timestamp_unix: i64, now_unix: i64) -> String {
    if timestamp_unix <= 0 {
        return "unknown".to_string();
    }

    let delta = now_unix.saturating_sub(timestamp_unix);
    if delta < 3_600 {
        format!("{} min ago", delta / 60)
    } else if delta < 86_400 {
        format!("{} hr ago", delta / 3_600)
    } else {
        format!("{} day ago", delta / 86_400)
    }
}

pub(super) fn format_full_timestamp(timestamp_unix: i64) -> String {
    if timestamp_unix <= 0 {
        return "unknown".to_string();
    }

    match Local.timestamp_opt(timestamp_unix, 0).single() {
        Some(ts) => ts.format("%Y-%m-%d %H:%M:%S %Z").to_string(),
        None => "unknown".to_string(),
    }
}

pub(super) fn format_aligned_details(rows: &[(&str, String, Style)]) -> Text<'static> {
    let width = rows
        .iter()
        .map(|(label, _, _)| label.len())
        .max()
        .unwrap_or(0);
    rows.iter()
        .map(|(label, value, style)| {
            Line::from(vec![
                Span::raw(format!("{:<width$} ", label, width = width)),
                Span::styled(value.clone(), *style),
            ])
        })
        .collect::<Vec<_>>()
        .into()
}

pub(super) fn unsent_input_hint_rows(input: &str) -> u16 {
    let preview_lines = format_unsent_input_preview_lines(input).len() as u16;
    preview_lines.saturating_add(1).clamp(2, 6)
}

pub(super) fn format_unsent_input_preview_lines(input: &str) -> Vec<String> {
    if input.is_empty() {
        return vec!["(empty)".to_string()];
    }
    let visible = input
        .chars()
        .map(|ch| if ch == '\t' { '⇥' } else { ch })
        .collect::<String>();
    let mut lines = Vec::new();
    let mut current = String::new();
    for ch in visible.chars() {
        if ch == '\n' {
            lines.push(std::mem::take(&mut current));
        } else {
            current.push(ch);
        }
    }
    lines.push(current);
    lines
}

pub(super) fn normalize_snapshot_newlines_for_vt(content: &str) -> Vec<u8> {
    let bytes = content.as_bytes();
    let mut normalized = Vec::with_capacity(bytes.len().saturating_add(bytes.len() / 8));
    let mut previous_was_cr = false;
    for &byte in bytes {
        if byte == b'\n' && !previous_was_cr {
            normalized.push(b'\r');
        }
        normalized.push(byte);
        previous_was_cr = byte == b'\r';
    }
    normalized
}
