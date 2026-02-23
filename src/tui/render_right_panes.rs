use ratatui::Frame;
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{
    Block, BorderType, Borders, Paragraph, Scrollbar, ScrollbarOrientation, ScrollbarState, Wrap,
};
use tui_term::vt100::Parser as VtParser;
use tui_term::widget::PseudoTerminal;

use super::render_helpers::{
    format_unsent_input_preview_lines, herd_color, normalize_snapshot_newlines_for_vt,
    split_body_and_hint, split_body_and_hint_rows, unsent_input_hint_rows,
};
use super::render_sections::PaneStyles;
use super::{AppModel, FocusPane, InputMode};

pub(super) fn render_content_pane(
    frame: &mut Frame<'_>,
    model: &mut AppModel,
    area: Rect,
    styles: PaneStyles,
) {
    let content_title = if let Some(selected) = model.selected_session() {
        format!(
            "Content ({}/{}:{})",
            selected.session_name, selected.window_index, selected.window_name
        )
    } else {
        "Content".to_string()
    };
    let content = model
        .selected_session()
        .map(|session| session.content.clone())
        .unwrap_or_else(|| "No tmux sessions discovered".to_string());

    let content_block = Block::default()
        .title(format!(" {} ", content_title))
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(styles.content_border);
    let content_inner = content_block.inner(area);
    frame.render_widget(content_block, area);

    let content_hint_rows = if model.input_mode == InputMode::Input {
        unsent_input_hint_rows(model.input_buffer())
    } else {
        1
    };
    let (content_body, content_hint) = split_body_and_hint_rows(content_inner, content_hint_rows);
    let (content_text_area, content_scrollbar_area) = if content_body.width > 1 {
        let chunks = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Min(1), Constraint::Length(1)])
            .split(content_body);
        (chunks[0], chunks[1])
    } else {
        (content_body, content_body)
    };

    model.set_content_viewport_height(content_text_area.height);
    let rows = content_text_area.height.max(1);
    let cols = content_text_area.width.max(1);
    let scrollback_capacity = content
        .lines()
        .count()
        .saturating_add(usize::from(rows))
        .max(usize::from(rows));
    let mut parser = VtParser::new(rows, cols, scrollback_capacity);
    let normalized_content = normalize_snapshot_newlines_for_vt(&content);
    parser.process(&normalized_content);

    let max_scrollback = {
        let screen = parser.screen_mut();
        screen.set_scrollback(usize::MAX);
        screen.scrollback()
    };
    let model_max = usize::from(model.max_content_scroll());
    let model_scroll = usize::from(model.content_scroll()).min(model_max);
    let lines_from_bottom = model_max.saturating_sub(model_scroll);
    let target_scrollback = lines_from_bottom.min(max_scrollback);
    parser.screen_mut().set_scrollback(target_scrollback);

    let pseudo_terminal = PseudoTerminal::new(parser.screen());
    frame.render_widget(pseudo_terminal, content_text_area);

    let display_max_scroll = max_scrollback.min(u16::MAX as usize) as u16;
    let actual_scrollback = parser
        .screen()
        .scrollback()
        .min(usize::from(display_max_scroll));
    let content_length = usize::from(display_max_scroll) + 1;
    let scroll_position = usize::from(display_max_scroll) - actual_scrollback;
    let viewport_content_length = usize::from(content_text_area.height.max(1));
    let mut scrollbar_state = ScrollbarState::new(content_length)
        .position(scroll_position)
        .viewport_content_length(viewport_content_length);
    let scrollbar = Scrollbar::new(ScrollbarOrientation::VerticalRight)
        .track_symbol(Some("┆"))
        .thumb_symbol("█")
        .style(Style::default().fg(Color::DarkGray))
        .thumb_style(if model.focus == FocusPane::Content {
            Style::default().fg(Color::Green)
        } else {
            Style::default().fg(Color::Gray)
        });
    frame.render_stateful_widget(scrollbar, content_scrollbar_area, &mut scrollbar_state);

    if let Some(hint_area) = content_hint {
        if model.input_mode == InputMode::Input {
            let preview_lines = format_unsent_input_preview_lines(model.input_buffer());
            let max_preview_lines = usize::from(hint_area.height.saturating_sub(1)).max(1);
            let start = preview_lines.len().saturating_sub(max_preview_lines);
            let mut lines = Vec::with_capacity(max_preview_lines + 1);
            for (index, preview_line) in preview_lines.iter().enumerate().skip(start) {
                let prefix = if index == start {
                    if start == 0 { "unsent> " } else { "...> " }
                } else {
                    "        "
                };
                lines.push(Line::from(vec![
                    Span::styled(
                        prefix,
                        Style::default()
                            .fg(Color::Yellow)
                            .add_modifier(Modifier::BOLD),
                    ),
                    Span::styled(preview_line.clone(), Style::default().fg(Color::White)),
                ]));
            }
            lines.push(Line::from(Span::styled(
                "[shift+enter/ctrl-s] send to tmux  [enter] newline  [esc] command mode",
                styles.content_hint,
            )));
            frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), hint_area);
        } else {
            frame.render_widget(
                Paragraph::new(
                    "[i] input mode  [j/k] scroll  [u/d] page up/down  [g/G] top/bottom",
                )
                .style(styles.content_hint),
                hint_area,
            );
        }
    }
}

pub(super) fn render_herder_log_pane(
    frame: &mut Frame<'_>,
    model: &mut AppModel,
    area: Rect,
    styles: PaneStyles,
) {
    let herder_log_filter_label = model
        .herder_log_filter
        .map(|herd_id| format!("herd {herd_id}"))
        .unwrap_or_else(|| "all".to_string());
    let herder_log_block = Block::default()
        .title(format!(" Herder Log ({herder_log_filter_label}) "))
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(styles.herder_log_border);
    let herder_log_inner = herder_log_block.inner(area);
    frame.render_widget(herder_log_block, area);
    let (herder_log_body, herder_log_hint) = split_body_and_hint(herder_log_inner);
    let (herder_log_text_area, herder_log_scrollbar_area) = if herder_log_body.width > 1 {
        let chunks = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Min(1), Constraint::Length(1)])
            .split(herder_log_body);
        (chunks[0], chunks[1])
    } else {
        (herder_log_body, herder_log_body)
    };

    model.set_herder_log_viewport_height(herder_log_text_area.height);
    let log_scroll = model.effective_herder_log_scroll();
    let filtered_log_entries = model.filtered_herder_log_entries();
    let log_text = if filtered_log_entries.is_empty() {
        let empty = match model.herder_log_filter {
            Some(herd_id) => format!("No herder activity for herd {herd_id}"),
            None => "No herder activity yet".to_string(),
        };
        Text::from(Line::from(Span::styled(
            empty,
            Style::default().fg(Color::DarkGray),
        )))
    } else {
        Text::from(
            filtered_log_entries
                .iter()
                .map(|entry| {
                    let herd_style = entry
                        .herd_id
                        .map(|herd_id| Style::default().fg(herd_color(herd_id)))
                        .unwrap_or_else(|| Style::default().fg(Color::Gray));
                    let herd_prefix = entry
                        .herd_id
                        .map(|herd_id| herd_id.to_string())
                        .unwrap_or_else(|| "-".to_string());
                    let prefix = format!("[{herd_prefix}][{}] ", entry.timestamp);
                    Line::from(vec![
                        Span::styled(prefix, herd_style),
                        Span::styled(entry.message.clone(), herd_style),
                    ])
                })
                .collect::<Vec<_>>(),
        )
    };
    frame.render_widget(
        Paragraph::new(log_text).scroll((log_scroll, 0)),
        herder_log_text_area,
    );

    let log_content_length = usize::from(model.max_herder_log_scroll()) + 1;
    let log_viewport = usize::from(herder_log_text_area.height.max(1));
    let mut log_scroll_state = ScrollbarState::new(log_content_length)
        .position(usize::from(log_scroll))
        .viewport_content_length(log_viewport);
    let log_scrollbar = Scrollbar::new(ScrollbarOrientation::VerticalRight)
        .track_symbol(Some("┆"))
        .thumb_symbol("█")
        .style(Style::default().fg(Color::DarkGray))
        .thumb_style(if model.focus == FocusPane::HerderLog {
            Style::default().fg(Color::Green)
        } else {
            Style::default().fg(Color::Gray)
        });
    frame.render_stateful_widget(
        log_scrollbar,
        herder_log_scrollbar_area,
        &mut log_scroll_state,
    );

    if let Some(hint_area) = herder_log_hint {
        let filter_hint = model
            .herder_log_filter
            .map(|herd_id| format!("herd {herd_id}"))
            .unwrap_or_else(|| "all".to_string());
        frame.render_widget(
            Paragraph::new(format!(
                "[j/k] scroll  [u/d] page up/down  [g/G] top/bottom  [0-9] filter  [a/-] all  ({filter_hint})"
            ))
            .style(styles.herder_log_hint),
            hint_area,
        );
    }
}
