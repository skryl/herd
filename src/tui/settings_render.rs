use ratatui::Frame;
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Borders, Clear, List, ListItem, Paragraph};

use crate::config::normalize_provider;

use super::{AppModel, SettingsOverlay};

fn redact_secret(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return "(not set)".to_string();
    }
    if trimmed.len() <= 8 {
        return "********".to_string();
    }
    let start = &trimmed[..4];
    let end = &trimmed[trimmed.len() - 4..];
    format!("{start}...{end}")
}

fn centered_rect(percent_x: u16, percent_y: u16, area: Rect) -> Rect {
    let vertical = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Percentage((100 - percent_y) / 2),
            Constraint::Percentage(percent_y),
            Constraint::Percentage((100 - percent_y) / 2),
        ])
        .split(area);
    let horizontal = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage((100 - percent_x) / 2),
            Constraint::Percentage(percent_x),
            Constraint::Percentage((100 - percent_x) / 2),
        ])
        .split(vertical[1]);
    horizontal[1]
}

pub(super) fn render_settings_overlay(frame: &mut Frame<'_>, model: &AppModel) {
    let Some(overlay) = model.settings_overlay.as_ref() else {
        return;
    };

    let area = centered_rect(70, 70, frame.area());
    frame.render_widget(Clear, area);

    let block = Block::default()
        .title(" Settings ")
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(
            Style::default()
                .fg(Color::Green)
                .add_modifier(Modifier::BOLD),
        );
    let inner = block.inner(area);
    frame.render_widget(block, area);

    let provider = normalize_provider(&overlay.draft.llm_provider).to_string();
    let model_value = if overlay.draft.llm_model.trim().is_empty() {
        "(none)".to_string()
    } else {
        overlay.draft.llm_model.clone()
    };

    let selected_mode = overlay.draft.herd_modes.get(overlay.selected_herd_mode);
    let selected_mode_name = selected_mode
        .map(|mode| mode.name.clone())
        .unwrap_or_else(|| "(none)".to_string());
    let selected_mode_file = selected_mode
        .map(|mode| mode.rule_file.clone())
        .unwrap_or_else(|| "(none)".to_string());
    let selected_mode_title = if overlay.draft.herd_modes.is_empty() {
        "none".to_string()
    } else {
        format!(
            "{}/{} ({})",
            overlay.selected_herd_mode + 1,
            overlay.draft.herd_modes.len(),
            selected_mode_name
        )
    };

    let section_style = Style::default()
        .fg(Color::LightBlue)
        .add_modifier(Modifier::BOLD);
    let action_style = Style::default().fg(Color::Yellow);
    let mut lines = Vec::with_capacity(30);
    let push_row = |index: usize,
                    label: &str,
                    value: String,
                    default_style: Style,
                    lines: &mut Vec<Line<'static>>| {
        let is_selected = index == overlay.selected;
        let mut style = if is_selected {
            Style::default()
                .fg(Color::Green)
                .add_modifier(Modifier::BOLD)
        } else {
            default_style
        };
        let display_value = if overlay.editing && is_selected {
            style = style.fg(Color::Yellow);
            format!("{}  (editing)", overlay.edit_buffer)
        } else {
            value
        };
        lines.push(Line::from(Span::styled(
            format!(
                "{} {:<16} {}",
                if is_selected { "▸" } else { " " },
                label,
                display_value
            ),
            style,
        )));
    };

    lines.push(Line::from(Span::styled("General", section_style)));
    push_row(
        0,
        "Herd Count",
        overlay.draft.herd_count.to_string(),
        Style::default(),
        &mut lines,
    );
    lines.push(Line::from(""));

    lines.push(Line::from(Span::styled("Provider Keys", section_style)));
    push_row(
        1,
        "OpenAI Key",
        redact_secret(&overlay.draft.openai_api_key),
        Style::default(),
        &mut lines,
    );
    push_row(
        2,
        "Anthropic Key",
        redact_secret(&overlay.draft.anthropic_api_key),
        Style::default(),
        &mut lines,
    );
    lines.push(Line::from(""));

    lines.push(Line::from(Span::styled("Model Selection", section_style)));
    push_row(3, "Provider", provider, Style::default(), &mut lines);
    push_row(4, "Model", model_value, Style::default(), &mut lines);
    push_row(
        5,
        "Refresh Models",
        "press [r] or Enter".to_string(),
        action_style,
        &mut lines,
    );
    lines.push(Line::from(""));

    lines.push(Line::from(Span::styled("Herd Modes", section_style)));
    push_row(
        6,
        "Selected Mode",
        selected_mode_title,
        Style::default(),
        &mut lines,
    );
    push_row(
        7,
        "Mode Name",
        selected_mode_name,
        Style::default(),
        &mut lines,
    );
    push_row(
        8,
        "Rule File",
        selected_mode_file,
        Style::default().fg(Color::Gray),
        &mut lines,
    );
    push_row(
        9,
        "Edit Rules",
        "press Enter".to_string(),
        action_style,
        &mut lines,
    );
    push_row(
        10,
        "Add Mode",
        "press Enter".to_string(),
        action_style,
        &mut lines,
    );
    push_row(
        11,
        "Remove Mode",
        "press Enter".to_string(),
        action_style,
        &mut lines,
    );
    lines.push(Line::from(""));

    lines.push(Line::from(Span::styled("Persist", section_style)));
    push_row(
        12,
        "Save Settings",
        "press [s] or Enter".to_string(),
        action_style,
        &mut lines,
    );

    if let Some(status) = &overlay.fetch_status {
        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled(
            status.clone(),
            Style::default().fg(Color::LightCyan),
        )));
    }

    frame.render_widget(Paragraph::new(lines), inner);

    if overlay.model_dropdown_open {
        render_model_dropdown(frame, inner, overlay);
    }
    if overlay.herd_mode_prompt_editor_open {
        render_herd_mode_prompt_editor(frame, inner, overlay);
    }
}

fn render_model_dropdown(frame: &mut Frame<'_>, anchor: Rect, overlay: &SettingsOverlay) {
    let dropdown_area = centered_rect(86, 55, anchor);
    frame.render_widget(Clear, dropdown_area);

    let block = Block::default()
        .title(" Model List ")
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(Style::default().fg(Color::Yellow));
    let inner = block.inner(dropdown_area);
    frame.render_widget(block, dropdown_area);

    let mut items = Vec::with_capacity(overlay.available_models.len() + 1);
    items.push(ListItem::new("Custom model name...").style(Style::default().fg(Color::LightCyan)));
    items.extend(
        overlay
            .available_models
            .iter()
            .map(|model| ListItem::new(model.clone())),
    );

    let mut state = ratatui::widgets::ListState::default();
    state.select(Some(
        overlay
            .model_dropdown_selected
            .min(items.len().saturating_sub(1)),
    ));
    let list = List::new(items)
        .highlight_style(
            Style::default()
                .bg(Color::Rgb(45, 45, 20))
                .add_modifier(Modifier::BOLD),
        )
        .highlight_symbol("▸ ");
    frame.render_stateful_widget(list, inner, &mut state);
}

fn render_herd_mode_prompt_editor(frame: &mut Frame<'_>, anchor: Rect, overlay: &SettingsOverlay) {
    let selected_mode_name = overlay
        .draft
        .herd_modes
        .get(overlay.selected_herd_mode)
        .map(|mode| mode.name.as_str())
        .unwrap_or("mode");
    let editor_area = centered_rect(92, 72, anchor);
    frame.render_widget(Clear, editor_area);
    let block = Block::default()
        .title(format!(" Herd Mode Rules ({selected_mode_name}) "))
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(Style::default().fg(Color::LightCyan));
    let inner = block.inner(editor_area);
    frame.render_widget(block, editor_area);
    frame.render_widget(
        Paragraph::new(overlay.herd_mode_prompt_buffer.clone()),
        inner,
    );
}
