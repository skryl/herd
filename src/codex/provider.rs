use std::collections::{HashMap, HashSet};

use super::app_server::CodexAppServerClient;
use super::assessment::{CodexThreadState, parse_turn_status};

const DEFAULT_REFRESH_INTERVAL_SECS: i64 = 2;
const DEFAULT_RETRY_BACKOFF_SECS: i64 = 5;

#[derive(Debug)]
pub struct CodexSessionStateProvider {
    client: Option<CodexAppServerClient>,
    cache_by_cwd: HashMap<String, CodexThreadState>,
    last_refresh_unix: i64,
    refresh_interval_secs: i64,
    retry_after_unix: i64,
    last_error: Option<String>,
}

impl Default for CodexSessionStateProvider {
    fn default() -> Self {
        Self {
            client: None,
            cache_by_cwd: HashMap::new(),
            last_refresh_unix: 0,
            refresh_interval_secs: DEFAULT_REFRESH_INTERVAL_SECS,
            retry_after_unix: 0,
            last_error: None,
        }
    }
}

impl CodexSessionStateProvider {
    pub fn statuses_for_cwds(
        &mut self,
        cwds: &[String],
        now_unix: i64,
    ) -> HashMap<String, CodexThreadState> {
        let requested = normalize_cwds(cwds);
        if requested.is_empty() {
            return HashMap::new();
        }

        let should_refresh = now_unix >= self.retry_after_unix
            && (self.last_refresh_unix == 0
                || now_unix - self.last_refresh_unix >= self.refresh_interval_secs);
        if should_refresh {
            match self.refresh(&requested) {
                Ok(()) => {
                    self.last_refresh_unix = now_unix;
                    self.last_error = None;
                }
                Err(err) => {
                    self.last_error = Some(err);
                    self.retry_after_unix = now_unix + DEFAULT_RETRY_BACKOFF_SECS;
                    self.client = None;
                }
            }
        }

        requested
            .into_iter()
            .filter_map(|cwd| {
                self.cache_by_cwd
                    .get(&cwd)
                    .cloned()
                    .map(|state| (cwd, state))
            })
            .collect()
    }

    pub fn take_last_error(&mut self) -> Option<String> {
        self.last_error.take()
    }

    fn refresh(&mut self, requested: &HashSet<String>) -> Result<(), String> {
        let client = self.client.get_or_insert(CodexAppServerClient::start()?);
        client.ensure_initialized()?;

        for cwd in requested {
            let Some(summary) = client.thread_list_latest_for_cwd(cwd)? else {
                self.cache_by_cwd.remove(cwd);
                continue;
            };
            let thread = client.thread_read(&summary.id)?;
            let thread_updated_unix = summary.updated_at.max(thread.updated_at);
            let turn_status = thread
                .turns
                .last()
                .and_then(|turn| parse_turn_status(&turn.status));
            self.cache_by_cwd.insert(
                cwd.clone(),
                CodexThreadState {
                    thread_id: thread.id,
                    thread_updated_unix,
                    turn_status,
                },
            );
        }

        Ok(())
    }
}

fn normalize_cwds(cwds: &[String]) -> HashSet<String> {
    let mut out = HashSet::new();
    for cwd in cwds {
        let trimmed = cwd.trim();
        if trimmed.is_empty() {
            continue;
        }
        out.insert(trimmed.to_string());
    }
    out
}
