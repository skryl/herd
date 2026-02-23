use crate::domain::{PaneSnapshot, SessionRef};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use super::{LIST_PANES_DELIM, TmuxAdapter, parser::parse_list_panes_output};

#[derive(Clone, Debug, Default)]
pub struct SystemTmuxAdapter {
    socket_name: Option<String>,
}

impl SystemTmuxAdapter {
    pub fn new(socket_name: Option<String>) -> Self {
        Self { socket_name }
    }

    pub fn enable_extended_keys_passthrough(&self) {
        let xterm_keys_args = vec![
            "set-option".to_string(),
            "-g".to_string(),
            "xterm-keys".to_string(),
            "on".to_string(),
        ];
        let _ = self.run_tmux(&xterm_keys_args);

        let extended_keys_args = vec![
            "set-option".to_string(),
            "-s".to_string(),
            "extended-keys".to_string(),
            "always".to_string(),
        ];
        let _ = self.run_tmux(&extended_keys_args);

        let extended_keys_format_args = vec![
            "set-option".to_string(),
            "-s".to_string(),
            "extended-keys-format".to_string(),
            "csi-u".to_string(),
        ];
        let _ = self.run_tmux(&extended_keys_format_args);

        // Keep the server alive even if all sessions exit, so Herd can recover
        // without immediately losing tmux server connectivity.
        let exit_empty_args = vec![
            "set-option".to_string(),
            "-s".to_string(),
            "exit-empty".to_string(),
            "off".to_string(),
        ];
        let _ = self.run_tmux(&exit_empty_args);

        let exit_unattached_args = vec![
            "set-option".to_string(),
            "-s".to_string(),
            "exit-unattached".to_string(),
            "off".to_string(),
        ];
        let _ = self.run_tmux(&exit_unattached_args);

        // Guard against environments where session auto-destruction is enabled.
        let destroy_unattached_args = vec![
            "set-option".to_string(),
            "-g".to_string(),
            "destroy-unattached".to_string(),
            "off".to_string(),
        ];
        let _ = self.run_tmux(&destroy_unattached_args);

        let list_sessions_args = vec![
            "list-sessions".to_string(),
            "-F".to_string(),
            "#{session_name}".to_string(),
        ];
        if let Ok(stdout) = self.run_tmux(&list_sessions_args) {
            for session_name in stdout
                .lines()
                .map(str::trim)
                .filter(|name| !name.is_empty())
            {
                self.set_destroy_unattached_off_for_session(session_name);
            }
        }
    }

    fn run_tmux(&self, args: &[String]) -> Result<String, String> {
        run_tmux_with_socket(self.socket_name.as_deref(), args)
    }

    pub fn send_literal_keys(&mut self, pane_id: &str, text: &str) -> Result<(), String> {
        if text.is_empty() {
            return Ok(());
        }
        let args = vec![
            "send-keys".to_string(),
            "-t".to_string(),
            pane_id.to_string(),
            "-l".to_string(),
            text.to_string(),
        ];
        let _ = self.run_tmux(&args)?;
        Ok(())
    }

    pub fn send_key_token(&mut self, pane_id: &str, token: &str) -> Result<(), String> {
        if token.is_empty() {
            return Ok(());
        }
        let args = vec![
            "send-keys".to_string(),
            "-t".to_string(),
            pane_id.to_string(),
            token.to_string(),
        ];
        let _ = self.run_tmux(&args)?;
        Ok(())
    }

    fn set_destroy_unattached_off_for_session(&self, session_name: &str) {
        set_destroy_unattached_off_for_session(self.socket_name.as_deref(), session_name);
    }
}

fn run_tmux_with_socket(socket_name: Option<&str>, args: &[String]) -> Result<String, String> {
    let mut command = Command::new("tmux");
    if let Some(socket) = socket_name {
        command.args(["-L", socket]);
    }
    command.args(args);

    let output = command
        .output()
        .map_err(|err| format!("failed to run tmux {:?}: {err}", args))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("tmux {:?} failed: {}", args, stderr.trim()));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

pub(super) fn set_destroy_unattached_off_for_session(
    socket_name: Option<&str>,
    session_name: &str,
) {
    let args = vec![
        "set-option".to_string(),
        "-t".to_string(),
        session_name.to_string(),
        "destroy-unattached".to_string(),
        "off".to_string(),
    ];
    let _ = run_tmux_with_socket(socket_name, &args);
}

impl TmuxAdapter for SystemTmuxAdapter {
    fn list_sessions(&self) -> Result<Vec<SessionRef>, String> {
        let fields = format!(
            "#{{session_id}}{d}#{{session_name}}{d}#{{window_id}}{d}#{{window_index}}{d}#{{window_name}}{d}#{{pane_id}}{d}#{{pane_index}}{d}#{{pane_current_path}}{d}#{{pane_current_command}}{d}#{{pane_dead}}{d}#{{pane_last}}",
            d = LIST_PANES_DELIM
        );
        let args = vec![
            "list-panes".to_string(),
            "-a".to_string(),
            "-F".to_string(),
            fields,
        ];
        let stdout = match self.run_tmux(&args) {
            Ok(stdout) => stdout,
            Err(err) => {
                if is_tmux_empty_target_error(&err) {
                    return Ok(Vec::new());
                }
                return Err(err);
            }
        };
        let mut sessions = parse_list_panes_output(&stdout)?;
        // Dead panes represent exited shells/processes and should not remain
        // in the active session list surfaced to the CLI/TUI.
        sessions.retain(|session| !session.pane_dead);
        Ok(sessions)
    }

    fn capture_pane(&self, pane_id: &str, lines: usize) -> Result<PaneSnapshot, String> {
        let start = format!("-{}", lines);
        let args = vec![
            "capture-pane".to_string(),
            "-p".to_string(),
            "-e".to_string(),
            "-N".to_string(),
            "-J".to_string(),
            "-t".to_string(),
            pane_id.to_string(),
            "-S".to_string(),
            start,
        ];
        let stdout = self.run_tmux(&args)?;
        Ok(PaneSnapshot {
            pane_id: pane_id.to_string(),
            content: stdout,
            captured_at_unix: now_unix(),
            last_activity_unix: 0,
        })
    }

    fn pane_height(&self, pane_id: &str) -> Result<usize, String> {
        let args = vec![
            "display-message".to_string(),
            "-p".to_string(),
            "-t".to_string(),
            pane_id.to_string(),
            "#{pane_height}".to_string(),
        ];
        let stdout = self.run_tmux(&args)?;
        let trimmed = stdout.trim();
        trimmed
            .parse::<usize>()
            .map(|height| height.max(1))
            .map_err(|err| format!("invalid pane_height '{trimmed}' for {pane_id}: {err}"))
    }

    fn send_keys(&mut self, pane_id: &str, message: &str) -> Result<(), String> {
        self.send_literal_keys(pane_id, message)?;
        self.send_key_token(pane_id, "Enter")?;
        Ok(())
    }
}

pub(super) fn now_unix() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_secs() as i64,
        Err(_) => 0,
    }
}

pub(super) fn is_tmux_empty_target_error(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    normalized.contains("no current target")
        || normalized.contains("can't find session")
        || normalized.contains("no sessions")
}
