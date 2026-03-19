use std::io::Read;
use std::process::{Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use crate::runtime;

const TMUX_CONFIG: &str = "/dev/null";
const TMUX_COMMAND_TIMEOUT: Duration = Duration::from_secs(2);

pub fn command() -> Command {
    let mut command = Command::new("tmux");
    command
        .env_remove("TMUX")
        .env_remove("TMUX_PANE")
        .args(["-f", TMUX_CONFIG, "-L", runtime::tmux_server_name()]);
    command
}

pub fn output(args: &[&str]) -> Result<Output, String> {
    let mut child = command();
    child
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = child
        .spawn()
        .map_err(|e| format!("tmux spawn failed: {e}"))?;

    let deadline = Instant::now() + TMUX_COMMAND_TIMEOUT;
    let command_line = format!(
        "tmux -f {TMUX_CONFIG} -L {} {}",
        runtime::tmux_server_name(),
        args.join(" "),
    );

    loop {
        match child.try_wait().map_err(|e| format!("tmux wait failed: {e}"))? {
            Some(status) => {
                let mut stdout = Vec::new();
                let mut stderr = Vec::new();

                if let Some(mut reader) = child.stdout.take() {
                    reader
                        .read_to_end(&mut stdout)
                        .map_err(|e| format!("tmux stdout read failed: {e}"))?;
                }
                if let Some(mut reader) = child.stderr.take() {
                    reader
                        .read_to_end(&mut stderr)
                        .map_err(|e| format!("tmux stderr read failed: {e}"))?;
                }

                return Ok(Output { status, stdout, stderr });
            }
            None if Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(10));
            }
            None => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "tmux command timed out after {}ms: {command_line}",
                    TMUX_COMMAND_TIMEOUT.as_millis()
                ));
            }
        }
    }
}

/// Check if the tmux server is already running.
pub fn is_running() -> bool {
    output(&["list-sessions"])
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Get the tmux server name.
pub fn server_name() -> &'static str {
    runtime::tmux_server_name()
}
