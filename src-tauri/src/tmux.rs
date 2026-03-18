use std::process::Command;

const TMUX_SERVER: &str = "herd";

/// Check if the tmux server is already running.
pub fn is_running() -> bool {
    Command::new("tmux")
        .args(["-L", TMUX_SERVER, "list-sessions"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Get the tmux server name.
pub fn server_name() -> &'static str {
    TMUX_SERVER
}
