use std::collections::{HashMap, HashSet};

use crate::config::MAX_HERDS;

use super::{AppModel, InputMode, UiSession};

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
}
