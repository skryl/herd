use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::Text;
use ratatui::widgets::{Block, BorderType, Borders, List, ListItem, Paragraph};

use super::AppModel;
use super::render_helpers::{
    build_left_rows, format_aligned_details, format_full_timestamp, format_relative_age,
    herd_color, split_body_and_hint, status_label, status_source_style, status_value_style,
};
use super::render_sections::PaneStyles;

pub(super) fn render_sessions_pane(
    frame: &mut Frame<'_>,
    model: &AppModel,
    area: Rect,
    now_unix: i64,
    styles: PaneStyles,
) {
    let sessions_block = Block::default()
        .title(" Sessions ")
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(styles.sessions_border);
    let sessions_inner = sessions_block.inner(area);
    frame.render_widget(sessions_block, area);
    let (sessions_body, sessions_hint) = split_body_and_hint(sessions_inner);

    let rows = build_left_rows(model, now_unix);
    let mut selected_row = None;
    let items: Vec<ListItem<'_>> = rows
        .iter()
        .enumerate()
        .map(|(row_index, row)| {
            if row.session_index == Some(model.selected) {
                selected_row = Some(row_index);
            }
            ListItem::new(row.line.clone())
        })
        .collect();
    let list = List::new(items)
        .highlight_style(
            Style::default()
                .bg(Color::Rgb(35, 60, 35))
                .add_modifier(Modifier::BOLD),
        )
        .highlight_symbol("▸ ");

    let mut list_state = ratatui::widgets::ListState::default();
    list_state.select(selected_row);
    frame.render_stateful_widget(list, sessions_body, &mut list_state);

    if let Some(hint_area) = sessions_hint {
        let herd_shortcuts = model.herd_shortcut_range_label();
        frame.render_widget(
            Paragraph::new(format!(
                "[j/k] move  [g/G] first/last  [{herd_shortcuts}] assign herd  [-] clear"
            ))
            .style(styles.sessions_hint),
            hint_area,
        );
    }
}

pub(super) fn render_herds_pane(
    frame: &mut Frame<'_>,
    model: &AppModel,
    area: Rect,
    styles: PaneStyles,
) {
    let herds_block = Block::default()
        .title(" Herds ")
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(styles.herds_border);
    let herds_inner = herds_block.inner(area);
    frame.render_widget(herds_block, area);
    let (herds_body, herds_hint) = split_body_and_hint(herds_inner);

    let herd_counts = model.herd_counts();
    let active_herd = model.active_herd();
    let herd_items: Vec<ListItem<'_>> = (0..model.herd_count())
        .map(|herd_id| {
            let count = herd_counts[usize::from(herd_id)];
            let mode = model.herd_mode(herd_id);
            let style = if count > 0 {
                Style::default().fg(herd_color(herd_id))
            } else {
                Style::default()
                    .fg(herd_color(herd_id))
                    .add_modifier(Modifier::DIM)
            };
            ListItem::new(format!("{herd_id}  {:<12}  {:>2} sessions", mode, count)).style(style)
        })
        .collect();
    let herd_list = List::new(herd_items)
        .highlight_style(
            Style::default()
                .bg(Color::Rgb(35, 60, 35))
                .add_modifier(Modifier::BOLD),
        )
        .highlight_symbol("▸ ");
    let mut herd_state = ratatui::widgets::ListState::default();
    herd_state.select(Some(usize::from(active_herd)));
    frame.render_stateful_widget(herd_list, herds_body, &mut herd_state);

    if let Some(hint_area) = herds_hint {
        frame.render_widget(
            Paragraph::new("[j/k] move  [g/G] first/last  [e] cycle mode").style(styles.herds_hint),
            hint_area,
        );
    }
}

pub(super) fn render_details_pane(
    frame: &mut Frame<'_>,
    model: &AppModel,
    area: Rect,
    now_unix: i64,
    styles: PaneStyles,
) {
    let details = if let Some(selected) = model.selected_session() {
        let last_update_full = format_full_timestamp(selected.last_update_unix);
        let last_update_age = format_relative_age(selected.last_update_unix, now_unix);
        format_aligned_details(&[
            (
                "process",
                selected.current_command.clone(),
                Style::default(),
            ),
            (
                "status",
                status_label(selected),
                status_value_style(selected.status, selected.status_tracked),
            ),
            (
                "source",
                selected.status_source.as_str().to_string(),
                status_source_style(selected.status_source),
            ),
            ("agent", selected.agent_name.clone(), Style::default()),
            (
                "herd",
                if let Some(herd_id) = selected.herd_id {
                    format!("{} ({})", herd_id, model.herd_mode(herd_id))
                } else if selected.herded {
                    "on".to_string()
                } else {
                    "off".to_string()
                },
                selected
                    .herd_id
                    .map(|herd_id| Style::default().fg(herd_color(herd_id)))
                    .unwrap_or_else(Style::default),
            ),
            ("session", selected.session_name.clone(), Style::default()),
            (
                "window",
                format!("{}:{}", selected.window_index, selected.window_name),
                Style::default(),
            ),
            (
                "pane",
                format!("{} {}", selected.pane_index, selected.pane_id),
                Style::default(),
            ),
            (
                "last update",
                format!("{} [{}]", last_update_full, last_update_age),
                Style::default(),
            ),
        ])
    } else {
        Text::from("No session selected".to_string())
    };

    let details_block = Block::default()
        .title(" Details ")
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(styles.details_border);
    let details_inner = details_block.inner(area);
    frame.render_widget(details_block, area);
    let (details_body, details_hint) = split_body_and_hint(details_inner);
    frame.render_widget(Paragraph::new(details), details_body);

    if let Some(hint_area) = details_hint {
        let herd_shortcuts = model.herd_shortcut_range_label();
        frame.render_widget(
            Paragraph::new(format!(
                "[enter/t] toggle herd  [y/n] herd on/off  [{herd_shortcuts}] assign  [-] clear"
            ))
            .style(styles.details_hint),
            hint_area,
        );
    }
}
