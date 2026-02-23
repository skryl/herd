use chrono::{Local, TimeZone};

use super::{AppModel, HERDER_LOG_MAX_LINES, HerderLogEntry, now_unix};

impl AppModel {
    pub fn push_herder_log(&mut self, message: impl Into<String>) {
        self.push_herder_log_for_herd(None, message);
    }

    pub fn push_herder_log_for_herd(&mut self, herd_id: Option<u8>, message: impl Into<String>) {
        let timestamp = match Local.timestamp_opt(now_unix(), 0).single() {
            Some(value) => value.format("%H:%M:%S").to_string(),
            None => "??:??:??".to_string(),
        };
        self.herder_log_entries.push(HerderLogEntry {
            timestamp,
            message: message.into(),
            herd_id,
        });
        if self.herder_log_entries.len() > HERDER_LOG_MAX_LINES {
            let remove_count = self.herder_log_entries.len() - HERDER_LOG_MAX_LINES;
            self.herder_log_entries.drain(0..remove_count);
            if let Some(scroll) = self.herder_log_scroll_override {
                self.herder_log_scroll_override = Some(scroll.saturating_sub(remove_count as u16));
            }
        }
        self.clamp_herder_log_scroll_override();
    }

    pub(super) fn set_herder_log_viewport_height(&mut self, height: u16) {
        self.herder_log_viewport_height = height.max(1);
        self.clamp_herder_log_scroll_override();
    }

    fn set_herder_log_filter(&mut self, filter: Option<u8>) {
        self.herder_log_filter = filter;
        self.clamp_herder_log_scroll_override();
    }

    pub(super) fn toggle_herder_log_filter(&mut self, herd_id: u8) {
        if self.herder_log_filter == Some(herd_id) {
            self.set_herder_log_filter(None);
        } else {
            self.set_herder_log_filter(Some(herd_id));
        }
    }

    pub(super) fn clear_herder_log_filter(&mut self) {
        self.set_herder_log_filter(None);
    }

    pub(super) fn filtered_herder_log_entries(&self) -> Vec<&HerderLogEntry> {
        self.herder_log_entries
            .iter()
            .filter(|entry| match self.herder_log_filter {
                Some(filter_id) => entry.herd_id == Some(filter_id),
                None => true,
            })
            .collect()
    }

    fn herder_log_line_count(&self) -> usize {
        self.filtered_herder_log_entries().len().max(1)
    }

    pub(super) fn max_herder_log_scroll(&self) -> u16 {
        let line_count = self.herder_log_line_count();
        let viewport = usize::from(self.herder_log_viewport_height.max(1));
        line_count.saturating_sub(viewport).min(u16::MAX as usize) as u16
    }

    pub(super) fn effective_herder_log_scroll(&self) -> u16 {
        let max = self.max_herder_log_scroll();
        self.herder_log_scroll_override.unwrap_or(max).min(max)
    }

    pub(super) fn set_herder_log_scroll_override(&mut self, scroll: u16) {
        let max = self.max_herder_log_scroll();
        let bounded = scroll.min(max);
        if bounded >= max {
            self.clear_herder_log_scroll_override();
        } else {
            self.herder_log_scroll_override = Some(bounded);
        }
    }

    pub(super) fn clear_herder_log_scroll_override(&mut self) {
        self.herder_log_scroll_override = None;
    }

    pub(super) fn clamp_herder_log_scroll_override(&mut self) {
        let max = self.max_herder_log_scroll();
        if let Some(saved) = self.herder_log_scroll_override
            && saved >= max
        {
            self.herder_log_scroll_override = None;
        }
    }

    pub fn set_status_message(&mut self, message: impl Into<String>) {
        self.status_message = Some(message.into());
    }

    pub fn clear_status_message(&mut self) {
        self.status_message = None;
    }

    pub fn status_message(&self) -> Option<&str> {
        self.status_message.as_deref()
    }

    pub fn set_tmux_server_online(&mut self) {
        self.tmux_server_status = super::TmuxServerStatus::Online;
    }

    pub fn set_tmux_server_offline(&mut self, reason: impl Into<String>) {
        self.tmux_server_status = super::TmuxServerStatus::Offline(reason.into());
    }

    pub fn note_refresh_error(&mut self, message: impl Into<String>) {
        self.set_status_message(message);
    }

    pub fn note_refresh_success(&mut self) {
        self.clear_status_message();
    }
}
