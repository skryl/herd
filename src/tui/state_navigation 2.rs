use std::collections::{HashMap, HashSet};

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

use crate::config::MAX_HERDS;
use crate::herd::DEFAULT_HERD_MODE_NAME;

use super::{AppEventResult, AppModel, FocusPane, InputMode, UiSession};

impl AppModel {
    pub fn set_content_viewport_height(&mut self, height: u16) {
        self.content_viewport_height = height.max(1);
        self.clamp_selected_scroll_override();
    }

    pub(super) fn set_herd_count(&mut self, herd_count: u8) {
        self.herd_count = herd_count.clamp(1, MAX_HERDS);
        self.selected_herd = self.selected_herd.min(self.max_herd_id());
        self.normalize_session_herd_assignments();
    }

    fn normalize_session_herd_assignments(&mut self) {
        let max = self.max_herd_id();
        for session in &mut self.sessions {
            if let Some(herd_id) = session.herd_id
                && herd_id > max
            {
                session.herd_id = None;
                session.herded = false;
            }
        }
    }

    pub fn handle_key(&mut self, key: KeyEvent) -> AppEventResult {
        if self.is_settings_overlay_open() {
            self.handle_settings_key(key);
            return AppEventResult::Continue;
        }

        if self.input_mode == InputMode::Input {
            match key.code {
                KeyCode::Esc => {
                    self.input_mode = InputMode::Command;
                    self.input_buffer.clear();
                    self.submitted_input = None;
                }
                KeyCode::Enter if key.modifiers.contains(KeyModifiers::SHIFT) => {
                    self.submitted_input = Some(std::mem::take(&mut self.input_buffer));
                }
                KeyCode::Char('s') | KeyCode::Char('S')
                    if key.modifiers.contains(KeyModifiers::CONTROL) =>
                {
                    self.submitted_input = Some(std::mem::take(&mut self.input_buffer));
                }
                // Some terminals encode Ctrl+S as ASCII DC3 without explicit CONTROL modifier.
                KeyCode::Char('\u{13}') => {
                    self.submitted_input = Some(std::mem::take(&mut self.input_buffer));
                }
                KeyCode::Enter => {
                    self.input_buffer.push('\n');
                }
                KeyCode::Backspace => {
                    self.input_buffer.pop();
                }
                KeyCode::Tab => {
                    self.input_buffer.push('\t');
                }
                KeyCode::Char(c)
                    if !key
                        .modifiers
                        .intersects(KeyModifiers::ALT | KeyModifiers::CONTROL) =>
                {
                    self.input_buffer.push(c);
                }
                _ => {}
            }
            return AppEventResult::Continue;
        }

        match key.code {
            KeyCode::Char('q') => AppEventResult::Quit,
            KeyCode::Char(',') => {
                self.open_settings_overlay();
                AppEventResult::Continue
            }
            KeyCode::Char('i') if self.focus == FocusPane::Content => {
                self.input_mode = InputMode::Input;
                self.input_buffer.clear();
                self.submitted_input = None;
                AppEventResult::Continue
            }
            KeyCode::Char('-') => {
                if self.focus == FocusPane::HerderLog {
                    self.clear_herder_log_filter();
                } else {
                    self.clear_selected_herd();
                }
                AppEventResult::Continue
            }
            KeyCode::Char(c) if c.is_ascii_digit() => {
                let herd_id = c.to_digit(10).unwrap_or(0) as u8;
                if self.focus == FocusPane::HerderLog {
                    self.toggle_herder_log_filter(herd_id);
                } else if herd_id <= self.max_herd_id() {
                    self.assign_selected_to_herd(herd_id);
                }
                AppEventResult::Continue
            }
            KeyCode::Char('H') => {
                self.focus = FocusPane::Sessions;
                AppEventResult::Continue
            }
            KeyCode::Char('h') if key.modifiers.contains(KeyModifiers::SHIFT) => {
                self.focus = FocusPane::Sessions;
                AppEventResult::Continue
            }
            KeyCode::Char('J') => {
                self.focus = match self.focus {
                    FocusPane::Sessions => FocusPane::Herds,
                    FocusPane::Herds => FocusPane::Details,
                    FocusPane::Details => FocusPane::Content,
                    FocusPane::Content => FocusPane::HerderLog,
                    FocusPane::HerderLog => FocusPane::HerderLog,
                };
                AppEventResult::Continue
            }
            KeyCode::Char('j') if key.modifiers.contains(KeyModifiers::SHIFT) => {
                self.focus = match self.focus {
                    FocusPane::Sessions => FocusPane::Herds,
                    FocusPane::Herds => FocusPane::Details,
                    FocusPane::Details => FocusPane::Content,
                    FocusPane::Content => FocusPane::HerderLog,
                    FocusPane::HerderLog => FocusPane::HerderLog,
                };
                AppEventResult::Continue
            }
            KeyCode::Char('K') => {
                self.focus = match self.focus {
                    FocusPane::Sessions => FocusPane::Sessions,
                    FocusPane::Herds => FocusPane::Sessions,
                    FocusPane::Details => FocusPane::Herds,
                    FocusPane::Content => FocusPane::Details,
                    FocusPane::HerderLog => FocusPane::Content,
                };
                AppEventResult::Continue
            }
            KeyCode::Char('k') if key.modifiers.contains(KeyModifiers::SHIFT) => {
                self.focus = match self.focus {
                    FocusPane::Sessions => FocusPane::Sessions,
                    FocusPane::Herds => FocusPane::Sessions,
                    FocusPane::Details => FocusPane::Herds,
                    FocusPane::Content => FocusPane::Details,
                    FocusPane::HerderLog => FocusPane::Content,
                };
                AppEventResult::Continue
            }
            KeyCode::Char('L') => {
                self.focus = FocusPane::Content;
                AppEventResult::Continue
            }
            KeyCode::Char('l') if key.modifiers.contains(KeyModifiers::SHIFT) => {
                self.focus = FocusPane::Content;
                AppEventResult::Continue
            }
            KeyCode::Char('h') => {
                self.focus = FocusPane::Sessions;
                AppEventResult::Continue
            }
            KeyCode::Char('l') => {
                self.focus = FocusPane::Content;
                AppEventResult::Continue
            }
            code => {
                match self.focus {
                    FocusPane::Sessions => self.handle_sessions_key(code),
                    FocusPane::Herds => self.handle_herds_key(code),
                    FocusPane::Details => self.handle_details_key(code),
                    FocusPane::Content => self.handle_content_key(code),
                    FocusPane::HerderLog => self.handle_herder_log_key(code),
                }
                AppEventResult::Continue
            }
        }
    }

    pub fn set_sessions(&mut self, mut sessions: Vec<UiSession>) {
        let previous_by_pane: HashMap<String, (bool, Option<u8>, String, i64)> = self
            .sessions
            .iter()
            .map(|session| {
                (
                    session.pane_id.clone(),
                    (
                        session.herded,
                        session.herd_id,
                        session.content.clone(),
                        session.last_update_unix,
                    ),
                )
            })
            .collect();

        for session in &mut sessions {
            if let Some((herded, herd_id, previous_content, previous_last_update)) =
                previous_by_pane.get(&session.pane_id)
            {
                session.herded = *herded;
                session.herd_id = *herd_id;
                if session.content == *previous_content {
                    session.last_update_unix = *previous_last_update;
                }
            }
        }

        self.sessions = sessions;
        if self.sessions.is_empty() {
            self.selected = 0;
            self.input_mode = InputMode::Command;
            self.input_buffer.clear();
            self.submitted_input = None;
        } else if self.selected >= self.sessions.len() {
            self.selected = self.sessions.len() - 1;
        }
        let active_panes: HashSet<&str> = self
            .sessions
            .iter()
            .map(|session| session.pane_id.as_str())
            .collect();
        self.content_scroll_overrides
            .retain(|pane_id, _| active_panes.contains(pane_id.as_str()));
        self.normalize_session_herd_assignments();
        self.sync_selected_herd_with_selection();
        self.clamp_selected_scroll_override();
    }

    fn handle_sessions_key(&mut self, code: KeyCode) {
        match code {
            KeyCode::Char('j') | KeyCode::Down => self.select_next(),
            KeyCode::Char('k') | KeyCode::Up => self.select_prev(),
            KeyCode::Char('g') | KeyCode::Home => self.jump_to_first(),
            KeyCode::Char('G') | KeyCode::End => self.jump_to_last(),
            _ => {}
        }
    }

    fn handle_content_key(&mut self, code: KeyCode) {
        match code {
            KeyCode::Char('j') | KeyCode::Down => self.scroll_content_lines(1),
            KeyCode::Char('k') | KeyCode::Up => self.scroll_content_lines(-1),
            KeyCode::Char('u') | KeyCode::Char('U') | KeyCode::PageUp => {
                self.scroll_content_page(-1)
            }
            KeyCode::Char('d') | KeyCode::Char('D') | KeyCode::PageDown => {
                self.scroll_content_page(1)
            }
            KeyCode::Char('g') | KeyCode::Home => self.set_scroll_override_for_selected(0),
            KeyCode::Char('G') | KeyCode::End => self.clear_scroll_override_for_selected(),
            _ => {}
        }
    }

    fn handle_herder_log_key(&mut self, code: KeyCode) {
        match code {
            KeyCode::Char('j') | KeyCode::Down => self.scroll_herder_log_lines(1),
            KeyCode::Char('k') | KeyCode::Up => self.scroll_herder_log_lines(-1),
            KeyCode::Char('u') | KeyCode::Char('U') | KeyCode::PageUp => {
                self.scroll_herder_log_page(-1)
            }
            KeyCode::Char('d') | KeyCode::Char('D') | KeyCode::PageDown => {
                self.scroll_herder_log_page(1)
            }
            KeyCode::Char('g') | KeyCode::Home => self.set_herder_log_scroll_override(0),
            KeyCode::Char('G') | KeyCode::End => self.clear_herder_log_scroll_override(),
            KeyCode::Char('a') | KeyCode::Char('A') => self.clear_herder_log_filter(),
            _ => {}
        }
    }

    fn handle_herds_key(&mut self, code: KeyCode) {
        match code {
            KeyCode::Char('j') | KeyCode::Down => self.select_next_herd(),
            KeyCode::Char('k') | KeyCode::Up => self.select_prev_herd(),
            KeyCode::Char('g') | KeyCode::Home => self.jump_to_first_herd(),
            KeyCode::Char('G') | KeyCode::End => self.jump_to_last_herd(),
            KeyCode::Char('e') => self.cycle_selected_herd_mode(),
            _ => {}
        }
    }

    fn handle_details_key(&mut self, code: KeyCode) {
        match code {
            KeyCode::Enter | KeyCode::Char(' ') | KeyCode::Char('t') => {
                self.toggle_herd_selected();
            }
            KeyCode::Char('y') => self.set_herd_selected(true),
            KeyCode::Char('n') => self.set_herd_selected(false),
            _ => {}
        }
    }

    fn toggle_herd_selected(&mut self) {
        let selected_herd = self.selected_herd;
        let max_herd_id = self.max_herd_id();
        if let Some(session) = self.sessions.get_mut(self.selected) {
            session.herded = !session.herded;
            if session.herded {
                session.herd_id = Some(session.herd_id.unwrap_or(selected_herd).min(max_herd_id));
            } else {
                session.herd_id = None;
            }
        }
    }

    fn set_herd_selected(&mut self, herded: bool) {
        let selected_herd = self.selected_herd;
        let max_herd_id = self.max_herd_id();
        if let Some(session) = self.sessions.get_mut(self.selected) {
            session.herded = herded;
            if herded {
                session.herd_id = Some(session.herd_id.unwrap_or(selected_herd).min(max_herd_id));
            } else {
                session.herd_id = None;
            }
        }
    }

    fn clear_selected_herd(&mut self) {
        if let Some(session) = self.sessions.get_mut(self.selected) {
            session.herded = false;
            session.herd_id = None;
        }
    }

    fn assign_selected_to_herd(&mut self, herd_id: u8) {
        let herd_id = herd_id.min(self.max_herd_id());
        self.selected_herd = herd_id;
        if let Some(session) = self.sessions.get_mut(self.selected) {
            session.herded = true;
            session.herd_id = Some(herd_id);
        }
    }

    fn cycle_selected_herd_mode(&mut self) {
        let mode_names = self.available_herd_mode_names();
        let slot = &mut self.herd_modes[usize::from(self.selected_herd)];
        let current_index = mode_names
            .iter()
            .position(|mode| mode.eq_ignore_ascii_case(slot))
            .unwrap_or(0);
        let next_index = (current_index + 1) % mode_names.len();
        *slot = mode_names[next_index].clone();
    }

    fn jump_to_first(&mut self) {
        self.selected = 0;
        self.sync_selected_herd_with_selection();
        self.clamp_selected_scroll_override();
    }

    fn jump_to_last(&mut self) {
        if self.sessions.is_empty() {
            return;
        }
        self.selected = self.sessions.len() - 1;
        self.sync_selected_herd_with_selection();
        self.clamp_selected_scroll_override();
    }

    fn scroll_content_lines(&mut self, delta: i32) {
        let max = i32::from(self.max_content_scroll());
        let current = i32::from(self.effective_content_scroll());
        let next = (current + delta).clamp(0, max);
        let next_scroll = next as u16;
        if next_scroll >= self.max_content_scroll() {
            self.clear_scroll_override_for_selected();
        } else {
            self.set_scroll_override_for_selected(next_scroll);
        }
    }

    fn scroll_content_page(&mut self, direction: i32) {
        let page = self.content_viewport_height.max(1) as i32;
        self.scroll_content_lines(page * direction);
    }

    fn scroll_herder_log_lines(&mut self, delta: i32) {
        let max = i32::from(self.max_herder_log_scroll());
        let current = i32::from(self.effective_herder_log_scroll());
        let next = (current + delta).clamp(0, max);
        self.set_herder_log_scroll_override(next as u16);
    }

    fn scroll_herder_log_page(&mut self, direction: i32) {
        let page = self.herder_log_viewport_height.max(1) as i32;
        self.scroll_herder_log_lines(page * direction);
    }

    fn selected_content_line_count(&self) -> usize {
        self.selected_session()
            .map(|session| session.content.lines().count().max(1))
            .unwrap_or(1)
    }

    pub(super) fn max_content_scroll(&self) -> u16 {
        let content_lines = self.selected_content_line_count();
        let viewport = usize::from(self.content_viewport_height.max(1));
        let max = content_lines.saturating_sub(viewport);
        max.min(u16::MAX as usize) as u16
    }

    pub(super) fn selected_pane_id(&self) -> Option<&str> {
        self.selected_session()
            .map(|session| session.pane_id.as_str())
    }

    pub(super) fn effective_content_scroll(&self) -> u16 {
        let max = self.max_content_scroll();
        match self
            .selected_pane_id()
            .and_then(|pane_id| self.content_scroll_overrides.get(pane_id))
            .copied()
        {
            Some(saved) => saved.min(max),
            None => max,
        }
    }

    fn set_scroll_override_for_selected(&mut self, scroll: u16) {
        let max = self.max_content_scroll();
        let bounded = scroll.min(max);
        if bounded >= max {
            self.clear_scroll_override_for_selected();
            return;
        }

        if let Some(pane_id) = self.selected_pane_id() {
            self.content_scroll_overrides
                .insert(pane_id.to_string(), bounded);
        }
    }

    fn clear_scroll_override_for_selected(&mut self) {
        if let Some(pane_id) = self.selected_pane_id().map(ToString::to_string) {
            self.content_scroll_overrides.remove(&pane_id);
        }
    }

    fn clamp_selected_scroll_override(&mut self) {
        let max = self.max_content_scroll();
        if let Some(pane_id) = self.selected_pane_id().map(ToString::to_string)
            && let Some(saved) = self.content_scroll_overrides.get(&pane_id).copied()
            && saved >= max
        {
            self.content_scroll_overrides.remove(&pane_id);
        }
    }

    fn select_next(&mut self) {
        if self.sessions.is_empty() {
            return;
        }
        if self.selected + 1 < self.sessions.len() {
            self.selected += 1;
            self.sync_selected_herd_with_selection();
            self.clamp_selected_scroll_override();
        }
    }

    fn select_prev(&mut self) {
        if self.selected > 0 {
            self.selected -= 1;
            self.sync_selected_herd_with_selection();
            self.clamp_selected_scroll_override();
        }
    }

    fn select_next_herd(&mut self) {
        self.selected_herd = (self.selected_herd + 1).min(self.max_herd_id());
    }

    fn select_prev_herd(&mut self) {
        self.selected_herd = self.selected_herd.saturating_sub(1);
    }

    fn jump_to_first_herd(&mut self) {
        self.selected_herd = 0;
    }

    fn jump_to_last_herd(&mut self) {
        self.selected_herd = self.max_herd_id();
    }

    fn sync_selected_herd_with_selection(&mut self) {
        if let Some(herd_id) = self.selected_session().and_then(|session| session.herd_id) {
            self.selected_herd = herd_id.min(self.max_herd_id());
        }
    }

    fn available_herd_mode_names(&self) -> Vec<String> {
        let names = self
            .settings
            .herd_modes
            .iter()
            .map(|mode| mode.name.trim().to_string())
            .filter(|name| !name.is_empty())
            .collect::<Vec<_>>();
        if names.is_empty() {
            vec![DEFAULT_HERD_MODE_NAME.to_string()]
        } else {
            names
        }
    }

    pub(super) fn normalize_herd_mode_assignments(&mut self) {
        let names = self.available_herd_mode_names();
        let default_name = names
            .first()
            .cloned()
            .unwrap_or_else(|| DEFAULT_HERD_MODE_NAME.to_string());
        for slot in &mut self.herd_modes {
            if !names.iter().any(|name| name.eq_ignore_ascii_case(slot)) {
                *slot = default_name.clone();
            }
        }
    }
}
