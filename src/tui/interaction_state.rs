use crate::herd::DEFAULT_HERD_MODE_NAME;

use super::AppModel;

impl AppModel {
    pub(super) fn toggle_herd_selected(&mut self) {
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

    pub(super) fn set_herd_selected(&mut self, herded: bool) {
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

    pub(super) fn clear_selected_herd(&mut self) {
        if let Some(session) = self.sessions.get_mut(self.selected) {
            session.herded = false;
            session.herd_id = None;
        }
    }

    pub(super) fn assign_selected_to_herd(&mut self, herd_id: u8) {
        let herd_id = herd_id.min(self.max_herd_id());
        self.selected_herd = herd_id;
        if let Some(session) = self.sessions.get_mut(self.selected) {
            session.herded = true;
            session.herd_id = Some(herd_id);
        }
    }

    pub(super) fn cycle_selected_herd_mode(&mut self) {
        let mode_names = self.available_herd_mode_names();
        let slot = &mut self.herd_modes[usize::from(self.selected_herd)];
        let current_index = mode_names
            .iter()
            .position(|mode| mode.eq_ignore_ascii_case(slot))
            .unwrap_or(0);
        let next_index = (current_index + 1) % mode_names.len();
        *slot = mode_names[next_index].clone();
    }

    pub(super) fn jump_to_first(&mut self) {
        self.selected = 0;
        self.sync_selected_herd_with_selection();
        self.clamp_selected_scroll_override();
    }

    pub(super) fn jump_to_last(&mut self) {
        if self.sessions.is_empty() {
            return;
        }
        self.selected = self.sessions.len() - 1;
        self.sync_selected_herd_with_selection();
        self.clamp_selected_scroll_override();
    }

    pub(super) fn scroll_content_lines(&mut self, delta: i32) {
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

    pub(super) fn scroll_content_page(&mut self, direction: i32) {
        let page = self.content_viewport_height.max(1) as i32;
        self.scroll_content_lines(page * direction);
    }

    pub(super) fn scroll_herder_log_lines(&mut self, delta: i32) {
        let max = i32::from(self.max_herder_log_scroll());
        let current = i32::from(self.effective_herder_log_scroll());
        let next = (current + delta).clamp(0, max);
        self.set_herder_log_scroll_override(next as u16);
    }

    pub(super) fn scroll_herder_log_page(&mut self, direction: i32) {
        let page = self.herder_log_viewport_height.max(1) as i32;
        self.scroll_herder_log_lines(page * direction);
    }

    pub(super) fn set_scroll_override_for_selected(&mut self, scroll: u16) {
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

    pub(super) fn clear_scroll_override_for_selected(&mut self) {
        if let Some(pane_id) = self.selected_pane_id().map(ToString::to_string) {
            self.content_scroll_overrides.remove(&pane_id);
        }
    }

    pub(super) fn clamp_selected_scroll_override(&mut self) {
        let max = self.max_content_scroll();
        if let Some(pane_id) = self.selected_pane_id().map(ToString::to_string)
            && let Some(saved) = self.content_scroll_overrides.get(&pane_id).copied()
            && saved >= max
        {
            self.content_scroll_overrides.remove(&pane_id);
        }
    }

    pub(super) fn select_next(&mut self) {
        if self.sessions.is_empty() {
            return;
        }
        if self.selected + 1 < self.sessions.len() {
            self.selected += 1;
            self.sync_selected_herd_with_selection();
            self.clamp_selected_scroll_override();
        }
    }

    pub(super) fn select_prev(&mut self) {
        if self.selected > 0 {
            self.selected -= 1;
            self.sync_selected_herd_with_selection();
            self.clamp_selected_scroll_override();
        }
    }

    pub(super) fn select_next_herd(&mut self) {
        self.selected_herd = (self.selected_herd + 1).min(self.max_herd_id());
    }

    pub(super) fn select_prev_herd(&mut self) {
        self.selected_herd = self.selected_herd.saturating_sub(1);
    }

    pub(super) fn jump_to_first_herd(&mut self) {
        self.selected_herd = 0;
    }

    pub(super) fn jump_to_last_herd(&mut self) {
        self.selected_herd = self.max_herd_id();
    }

    pub(super) fn sync_selected_herd_with_selection(&mut self) {
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
