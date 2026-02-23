use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

use super::{AppEventResult, AppModel, FocusPane, InputMode};

impl AppModel {
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
}
