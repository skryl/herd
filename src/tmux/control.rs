use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::Sender;
use std::thread;

use super::ControlOutputEvent;
use super::parser::parse_control_output_line;
use super::system::{now_unix, set_destroy_unattached_off_for_session};

#[derive(Debug)]
pub(super) struct ControlSessionClient {
    child: Child,
}

impl ControlSessionClient {
    pub(super) fn stop(mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }

    pub(super) fn is_exited(&mut self) -> bool {
        match self.child.try_wait() {
            Ok(Some(_)) => true,
            Ok(None) => false,
            Err(_) => true,
        }
    }
}

pub(super) fn spawn_control_session_client(
    socket_name: Option<&str>,
    session_name: &str,
    sender: Sender<ControlOutputEvent>,
) -> Result<ControlSessionClient, String> {
    set_destroy_unattached_off_for_session(socket_name, session_name);

    let mut command = Command::new("tmux");
    if let Some(socket) = socket_name {
        command.args(["-L", socket]);
    }
    command
        .args([
            "-C",
            "attach-session",
            "-t",
            session_name,
            "-f",
            "read-only,ignore-size,active-pane",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|err| format!("failed to spawn tmux control client for {session_name}: {err}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("tmux control client for {session_name} missing stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| format!("tmux control client for {session_name} missing stderr"))?;

    let stdout_sender = sender.clone();
    let session = session_name.to_string();
    thread::Builder::new()
        .name(format!("tmux-ctl-out-{session}"))
        .spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                if let Some((pane_id, bytes)) = parse_control_output_line(&line) {
                    let event = ControlOutputEvent {
                        pane_id,
                        content: String::from_utf8_lossy(&bytes).to_string(),
                        captured_at_unix: now_unix(),
                    };
                    let _ = stdout_sender.send(event);
                }
            }
        })
        .map_err(|err| format!("failed to spawn stdout reader for {session_name}: {err}"))?;

    let session = session_name.to_string();
    thread::Builder::new()
        .name(format!("tmux-ctl-err-{session}"))
        .spawn(move || {
            let reader = BufReader::new(stderr);
            for _ in reader.lines() {}
        })
        .map_err(|err| format!("failed to spawn stderr reader for {session_name}: {err}"))?;

    Ok(ControlSessionClient { child })
}
