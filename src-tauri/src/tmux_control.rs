use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::fd::FromRawFd;
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter, Manager};

use crate::{runtime, tmux};

/// Thread-safe writer + id map for sending input without contending with the reader.
pub struct TmuxWriter {
    writer: Mutex<Box<dyn Write + Send>>,
}

impl TmuxWriter {
    /// Send raw bytes to a pane via send-keys -H through the -CC connection.
    pub fn send_input_by_id(&self, pane_id: &str, data: &[u8]) -> Result<(), String> {
        let hex: Vec<String> = data.iter().map(|b| format!("{:02x}", b)).collect();
        self.send_raw(&format!("send-keys -t {} -H {}\n", pane_id, hex.join(" ")))
    }

    /// Send a command through the -CC control connection.
    pub fn send_raw(&self, cmd: &str) -> Result<(), String> {
        let mut w = self.writer.lock().map_err(|e| e.to_string())?;
        w.write_all(cmd.as_bytes()).map_err(|e| format!("Write failed: {e}"))?;
        w.flush().map_err(|e| format!("Flush failed: {e}"))
    }
}

/// Thread-safe output buffers — separate from TmuxControl to avoid lock contention.
pub type OutputBuffers = Arc<Mutex<HashMap<String, Vec<u8>>>>;

/// Manages a tmux control mode (-CC) connection for per-pane I/O.
pub struct TmuxControl {
    child_pid: libc::pid_t,
    pub writer: Arc<TmuxWriter>,
    pub output_buffers: OutputBuffers,
}

const OUTPUT_BUFFER_CAP: usize = 65536;

impl TmuxControl {
    pub fn child_pid(&self) -> libc::pid_t {
        self.child_pid
    }

    pub fn terminate(&self) {
        unsafe {
            libc::kill(self.child_pid, libc::SIGTERM);
        }

        for _ in 0..20 {
            let wait_result = unsafe { libc::waitpid(self.child_pid, std::ptr::null_mut(), libc::WNOHANG) };
            if wait_result == self.child_pid {
                return;
            }
            thread::sleep(std::time::Duration::from_millis(10));
        }

        unsafe {
            libc::kill(self.child_pid, libc::SIGKILL);
            libc::waitpid(self.child_pid, std::ptr::null_mut(), libc::WNOHANG);
        }
    }

    /// Start a control mode connection to the given tmux session.
    /// Uses raw forkpty to create a PTY in raw mode — no echo, no line processing.
    /// This gives tmux the TTY it requires while keeping the -CC stream clean.
    pub fn start(
        session_name: &str,
        app_handle: AppHandle,
    ) -> Result<Arc<Mutex<Self>>, String> {
        let server = tmux::server_name();

        // Create a raw PTY pair via forkpty
        let mut master_fd: libc::c_int = 0;
        let mut ws: libc::winsize = unsafe { std::mem::zeroed() };
        ws.ws_row = 24;
        ws.ws_col = 80;

        let pid = unsafe {
            libc::forkpty(
                &mut master_fd as *mut libc::c_int,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut ws as *mut libc::winsize,
            )
        };

        if pid < 0 {
            return Err("forkpty failed".into());
        }

        if pid == 0 {
            // Child process: exec tmux -CC
            let tmux_env = std::ffi::CString::new("TMUX").unwrap();
            let tmux_pane_env = std::ffi::CString::new("TMUX_PANE").unwrap();
            unsafe {
                libc::unsetenv(tmux_env.as_ptr());
                libc::unsetenv(tmux_pane_env.as_ptr());
            }
            let c_tmux = std::ffi::CString::new("tmux").unwrap();
            let c_args: Vec<std::ffi::CString> = vec![
                std::ffi::CString::new("tmux").unwrap(),
                std::ffi::CString::new("-f").unwrap(),
                std::ffi::CString::new("/dev/null").unwrap(),
                std::ffi::CString::new("-L").unwrap(),
                std::ffi::CString::new(server).unwrap(),
                std::ffi::CString::new("-CC").unwrap(),
                std::ffi::CString::new("attach-session").unwrap(),
                std::ffi::CString::new("-t").unwrap(),
                std::ffi::CString::new(session_name).unwrap(),
            ];
            let c_argv: Vec<*const libc::c_char> = c_args.iter()
                .map(|s| s.as_ptr())
                .chain(std::iter::once(std::ptr::null()))
                .collect();

            unsafe { libc::execvp(c_tmux.as_ptr(), c_argv.as_ptr()) };
            // If we get here, exec failed
            unsafe { libc::_exit(1) };
        }

        // Parent process: set master to raw mode
        unsafe {
            let mut t: libc::termios = std::mem::zeroed();
            libc::tcgetattr(master_fd, &mut t);
            libc::cfmakeraw(&mut t);
            libc::tcsetattr(master_fd, libc::TCSANOW, &t);
        }

        // Create File handles from the master fd
        let reader = unsafe { std::fs::File::from_raw_fd(master_fd) };
        let writer: Box<dyn Write + Send> = Box::new(unsafe {
            std::fs::File::from_raw_fd(libc::dup(master_fd))
        });
        let child_pid = pid;

        let tmux_writer = Arc::new(TmuxWriter {
            writer: Mutex::new(writer),
        });

        let output_buffers: OutputBuffers = Arc::new(Mutex::new(HashMap::new()));

        let control = Arc::new(Mutex::new(TmuxControl {
            child_pid,
            writer: tmux_writer.clone(),
            output_buffers: output_buffers.clone(),
        }));

        // Reader thread: parse control mode output
        let bufs_clone = output_buffers.clone();
        let app = app_handle.clone();
        let refresh_pending = Arc::new(Mutex::new(false));
        thread::spawn(move || {
            // Open CC log file
            let cc_log: Arc<Mutex<Option<std::fs::File>>> = Arc::new(Mutex::new(
                std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(runtime::cc_log_path())
                    .ok()
            ));

            let reader = BufReader::new(reader);
            for line in reader.lines() {
                let line = match line {
                    Ok(l) => l.trim_end_matches('\r').to_string(),
                    Err(_) => break,
                };

                // Log all -CC lines to file
                if !line.is_empty() {
                    if let Ok(mut f) = cc_log.lock() {
                        if let Some(ref mut file) = *f {
                            use std::io::Write as _;
                            let now = chrono::Local::now().format("%H:%M:%S%.3f");
                            if line.starts_with("%output ") {
                                let s = &line[8..];
                                let mut end = s.len().min(120);
                                while end > 0 && !s.is_char_boundary(end) { end -= 1; }
                                let _ = writeln!(file, "[{now}] %output {}", &s[..end]);
                            } else {
                                let mut end = line.len().min(200);
                                while end > 0 && !line.is_char_boundary(end) { end -= 1; }
                                let _ = writeln!(file, "[{now}] {}", &line[..end]);
                            }
                        }
                    }
                }

                if line.starts_with("%output ") {
                    // %output %<pane_id> <escaped_data>
                    if let Some((pane_id, data)) = parse_output_line(&line) {
                        let decoded = decode_tmux_output(&data);

                        // Buffer for read_output API (separate lock, no contention)
                        if let Ok(mut bufs) = bufs_clone.lock() {
                            let buf = bufs.entry(pane_id.clone()).or_insert_with(Vec::new);
                            buf.extend_from_slice(&decoded);
                            if buf.len() > OUTPUT_BUFFER_CAP {
                                let drain = buf.len() - OUTPUT_BUFFER_CAP;
                                buf.drain(..drain);
                            }
                        }

                        let text = String::from_utf8_lossy(&decoded).to_string();
                        let payload = serde_json::json!({
                            "pane_id": pane_id,
                            "data": text,
                        });
                        let emit_result = app.emit("pty-output", &payload);

                        if let Ok(mut f) = cc_log.lock() {
                            if let Some(ref mut file) = *f {
                                let now = chrono::Local::now().format("%H:%M:%S%.3f");
                                let status = if emit_result.is_ok() { "OK" } else { "FAIL" };
                                let _ = writeln!(file, "[{now}] EMIT {status} {pane_id} ({} bytes)", text.len());
                            }
                        }
                    }
                } else if line.starts_with('%') {
                    if let Some(session_id) = parse_session_changed_id(&line) {
                        if let Some(state) = app.try_state::<crate::state::AppState>() {
                            state.set_last_active_session(Some(session_id));
                        }
                    }
                    if !should_refresh_snapshot(&line) {
                        continue;
                    }
                    let already_pending = {
                        let mut p = refresh_pending.lock().unwrap_or_else(|e| e.into_inner());
                        let was = *p;
                        *p = true;
                        was
                    };
                    if !already_pending {
                        let app2 = app.clone();
                        let pending2 = refresh_pending.clone();
                        thread::spawn(move || {
                            thread::sleep(std::time::Duration::from_millis(150));
                            let _ = crate::tmux_state::emit_snapshot(&app2);
                            *pending2.lock().unwrap_or_else(|e| e.into_inner()) = false;
                        });
                    }
                }
            }
            log::info!("tmux -CC reader thread exited, requesting reconnect");
            // Signal reconnect via Tauri event
            let _ = app.emit("tmux-cc-disconnected", child_pid);
        });

        thread::spawn(move || {
            thread::sleep(std::time::Duration::from_millis(250));
            kill_stale_control_clients(child_pid);
        });

        Ok(control)
    }

    pub fn inherit_state(&mut self, old: &TmuxControl) {
        // Copy output buffers
        if let (Ok(old_bufs), Ok(mut new_bufs)) = (old.output_buffers.lock(), self.output_buffers.lock()) {
            *new_bufs = old_bufs.clone();
        }
        log::info!("Inherited tmux output buffers from previous control");
    }

    /// Clear all tracked state (for restart).
    pub fn clear_all(&mut self) {
        if let Ok(mut bufs) = self.output_buffers.lock() { bufs.clear(); }
    }

    /// Create a new window with a shell in the session.
    pub fn create_window(&self) -> Result<(), String> {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        self.writer.send_raw(&format!(
            "new-window -e HERD_SOCK={} {}\n",
            runtime::socket_path(), shell
        ))
    }

    /// Kill a pane by pane ID.
    pub fn kill_pane_by_id(&mut self, pane_id: &str) -> Result<(), String> {
        if self.output_buffers.lock().map(|bufs| bufs.len()).unwrap_or(0) <= 1 {
            self.create_window()?;
            std::thread::sleep(std::time::Duration::from_millis(100));
        }

        if let Ok(mut bufs) = self.output_buffers.lock() {
            bufs.remove(pane_id);
        }
        self.writer.send_raw(&format!("kill-pane -t {}\n", pane_id))
    }

    /// Resize by pane ID.
    pub fn resize_by_id(&self, pane_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        self.writer.send_raw(&format!("resize-pane -t {} -x {} -y {}\n", pane_id, cols, rows))
    }

    /// Read buffered output for a pane. Drains the buffer.
    pub fn read_output(&self, pane_id: &str) -> Result<String, String> {
        let mut bufs = self.output_buffers.lock().map_err(|e| e.to_string())?;
        match bufs.get_mut(pane_id) {
            Some(b) => {
                let bytes: Vec<u8> = b.drain(..).collect();
                Ok(String::from_utf8_lossy(&bytes).to_string())
            }
            None => Ok(String::new()),
        }
    }
}

impl Drop for TmuxControl {
    fn drop(&mut self) {
        self.terminate();
    }
}

fn should_refresh_snapshot(line: &str) -> bool {
    [
        "%layout-change ",
        "%session-changed ",
        "%sessions-changed",
        "%window-add ",
        "%window-close ",
        "%window-renamed ",
        "%unlinked-window-add ",
        "%unlinked-window-close ",
        "%unlinked-window-renamed ",
        "%pane-mode-changed ",
        "%exit",
    ]
    .iter()
    .any(|prefix| line.starts_with(prefix))
}

fn parse_session_changed_id(line: &str) -> Option<String> {
    line.strip_prefix("%session-changed ")
        .and_then(|rest| rest.split_whitespace().next())
        .filter(|session_id| !session_id.is_empty())
        .map(ToString::to_string)
}

fn kill_stale_control_clients(current_pid: libc::pid_t) {
    let output = match tmux::output(&["list-clients", "-F", "#{client_pid}\t#{client_control_mode}"]) {
        Ok(output) if output.status.success() => output,
        _ => return,
    };

    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let mut parts = line.split('\t');
        let Some(pid_str) = parts.next() else {
            continue;
        };
        let Some(control_mode) = parts.next() else {
            continue;
        };
        if control_mode != "1" {
            continue;
        }
        let Ok(pid) = pid_str.parse::<libc::pid_t>() else {
            continue;
        };
        if pid == current_pid {
            continue;
        }
        unsafe {
            libc::kill(pid, libc::SIGKILL);
        }
        log::info!("Killed stale tmux -CC client pid {}", pid);
    }
}

/// Parse a %output line: "%output %<pane_id> <data>"
fn parse_output_line(line: &str) -> Option<(String, String)> {
    // Format: "%output %N <data>"
    let rest = line.strip_prefix("%output ")?;
    let space_idx = rest.find(' ')?;
    let pane_id = rest[..space_idx].to_string();
    let data = rest[space_idx + 1..].to_string();
    Some((pane_id, data))
}

/// Decode tmux control mode escaped output.
/// Tmux uses C-style octal escapes: \015 for CR, \012 for LF, \\ for backslash.
fn decode_tmux_output(data: &str) -> Vec<u8> {
    let mut result = Vec::with_capacity(data.len());
    let bytes = data.as_bytes();
    let mut i = 0;

    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 1 < bytes.len() {
            if bytes[i + 1] == b'\\' {
                result.push(b'\\');
                i += 2;
            } else if i + 3 < bytes.len()
                && bytes[i + 1].is_ascii_digit()
                && bytes[i + 2].is_ascii_digit()
                && bytes[i + 3].is_ascii_digit()
            {
                // Octal escape: \NNN
                let val = (bytes[i + 1] - b'0') as u8 * 64
                    + (bytes[i + 2] - b'0') as u8 * 8
                    + (bytes[i + 3] - b'0') as u8;
                result.push(val);
                i += 4;
            } else {
                result.push(bytes[i]);
                i += 1;
            }
        } else {
            result.push(bytes[i]);
            i += 1;
        }
    }

    result
}

#[cfg(test)]
mod tests {
    use super::parse_session_changed_id;

    #[test]
    fn parses_session_changed_events() {
        assert_eq!(
            parse_session_changed_id("%session-changed $1 tab"),
            Some("$1".to_string())
        );
        assert_eq!(
            parse_session_changed_id("%session-changed $1"),
            Some("$1".to_string())
        );
        assert_eq!(parse_session_changed_id("%layout-change @1 ..."), None);
    }
}
