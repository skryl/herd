use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::os::fd::FromRawFd;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter};

use crate::tmux;

/// Thread-safe writer + id map for sending input without contending with the reader.
pub struct TmuxWriter {
    writer: Mutex<Box<dyn Write + Send>>,
    id_map: Mutex<HashMap<String, String>>,
}

impl TmuxWriter {
    /// Send raw bytes to a pane via send-keys -H through the -CC connection.
    pub fn send_input_by_id(&self, session_id: &str, data: &[u8]) -> Result<(), String> {
        let pane_id = {
            let map = self.id_map.lock().map_err(|e| e.to_string())?;
            map.get(session_id)
                .ok_or_else(|| format!("No pane for session {session_id}"))?
                .clone()
        };
        let hex: Vec<String> = data.iter().map(|b| format!("{:02x}", b)).collect();
        self.send_raw(&format!("send-keys -t {} -H {}\n", pane_id, hex.join(" ")))
    }

    /// Send a command through the -CC control connection.
    pub fn send_raw(&self, cmd: &str) -> Result<(), String> {
        let mut w = self.writer.lock().map_err(|e| e.to_string())?;
        w.write_all(cmd.as_bytes()).map_err(|e| format!("Write failed: {e}"))?;
        w.flush().map_err(|e| format!("Flush failed: {e}"))
    }

    pub fn register_pane(&self, pane_id: &str, session_id: &str) {
        if let Ok(mut map) = self.id_map.lock() {
            map.insert(session_id.to_string(), pane_id.to_string());
        }
    }

    pub fn unregister_id(&self, session_id: &str) {
        if let Ok(mut map) = self.id_map.lock() {
            map.remove(session_id);
        }
    }

    pub fn pane_id_for(&self, session_id: &str) -> Option<String> {
        self.id_map.lock().ok()?.get(session_id).cloned()
    }
}

/// Thread-safe output buffers — separate from TmuxControl to avoid lock contention.
pub type OutputBuffers = Arc<Mutex<HashMap<String, Vec<u8>>>>;

/// Manages a tmux control mode (-CC) connection for per-pane I/O.
pub struct TmuxControl {
    child_pid: libc::pid_t,
    pub writer: Arc<TmuxWriter>,
    pub output_buffers: OutputBuffers,
    session_name: String,
    /// Maps pane_id (%N) → herd session_id
    pane_map: HashMap<String, String>,
    /// Known pane IDs (for detecting new panes)
    known_panes: HashSet<String>,
}

const OUTPUT_BUFFER_CAP: usize = 65536;

impl TmuxControl {
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
            let c_tmux = std::ffi::CString::new("tmux").unwrap();
            let c_args: Vec<std::ffi::CString> = vec![
                std::ffi::CString::new("tmux").unwrap(),
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
            id_map: Mutex::new(HashMap::new()),
        });

        let output_buffers: OutputBuffers = Arc::new(Mutex::new(HashMap::new()));

        let control = Arc::new(Mutex::new(TmuxControl {
            child_pid,
            writer: tmux_writer.clone(),
            output_buffers: output_buffers.clone(),
            session_name: session_name.to_string(),
            pane_map: HashMap::new(),
            known_panes: HashSet::new(),
        }));

        // Reader thread: parse control mode output
        let control_clone = control.clone();
        let bufs_clone = output_buffers.clone();
        let app = app_handle.clone();
        let detect_pending = Arc::new(Mutex::new(false));
        thread::spawn(move || {
            // Open CC log file
            let cc_log_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tmp");
            let cc_log: Arc<Mutex<Option<std::fs::File>>> = Arc::new(Mutex::new(
                if cc_log_path.is_dir() {
                    std::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(cc_log_path.join("herd-cc.log"))
                        .ok()
                } else {
                    None
                }
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

                        // Map pane_id to herd session_id for the event name
                        let event_id = if let Ok(ctrl) = control_clone.lock() {
                            ctrl.pane_map.get(&pane_id).cloned()
                                .unwrap_or_else(|| pane_id.clone())
                        } else {
                            pane_id.clone()
                        };

                        let text = String::from_utf8_lossy(&decoded).to_string();
                        // Use a single global event with structured payload
                        let payload = serde_json::json!({
                            "sid": event_id,
                            "pane": pane_id,
                            "data": text,
                        });
                        let emit_result = app.emit("pty-output", &payload);

                        // Log to CC log: pane_id -> event_id mapping
                        if let Ok(mut f) = cc_log.lock() {
                            if let Some(ref mut file) = *f {
                                let now = chrono::Local::now().format("%H:%M:%S%.3f");
                                let status = if emit_result.is_ok() { "OK" } else { "FAIL" };
                                let _ = writeln!(file, "[{now}] EMIT {status} {pane_id} -> {event_id} ({} bytes)", text.len());
                            }
                        }
                    }
                } else if line.starts_with("%unlinked-window-close ") || line.starts_with("%window-close ") {
                    // A window/pane was destroyed — run detection to clean up
                    let ctrl_clone2 = control_clone.clone();
                    let app2 = app.clone();
                    thread::spawn(move || {
                        thread::sleep(std::time::Duration::from_millis(100));
                        detect_new_panes(ctrl_clone2, app2);
                    });
                } else if line.starts_with("%layout-change ") || line.starts_with("%window-add ") {
                    // Pane structure may have changed — debounce detection
                    let already_pending = {
                        let mut p = detect_pending.lock().unwrap_or_else(|e| e.into_inner());
                        let was = *p;
                        *p = true;
                        was
                    };
                    if !already_pending {
                        let ctrl_clone2 = control_clone.clone();
                        let app2 = app.clone();
                        let pending2 = detect_pending.clone();
                        thread::spawn(move || {
                            thread::sleep(std::time::Duration::from_millis(200));
                            detect_new_panes(ctrl_clone2, app2);
                            *pending2.lock().unwrap_or_else(|e| e.into_inner()) = false;
                        });
                    }
                }
            }
            log::info!("tmux -CC reader thread exited, requesting reconnect");
            // Signal reconnect via Tauri event
            let _ = app.emit("tmux-cc-disconnected", ());
        });

        // Initial pane discovery — finds panes that existed before -CC connected
        {
            let ctrl = control.clone();
            let app = app_handle.clone();
            thread::spawn(move || {
                thread::sleep(std::time::Duration::from_secs(3));
                detect_new_panes(ctrl, app);
            });
        }

        Ok(control)
    }

    /// Copy known_panes and pane_map from an old control instance.
    /// Prevents re-detecting existing panes as new on reconnect.
    pub fn inherit_state(&mut self, old: &TmuxControl) {
        self.known_panes = old.known_panes.clone();
        self.pane_map = old.pane_map.clone();
        if let Ok(old_map) = old.writer.id_map.lock() {
            if let Ok(mut new_map) = self.writer.id_map.lock() {
                *new_map = old_map.clone();
            }
        }
        // Copy output buffers
        if let (Ok(old_bufs), Ok(mut new_bufs)) = (old.output_buffers.lock(), self.output_buffers.lock()) {
            *new_bufs = old_bufs.clone();
        }
        log::info!("Inherited {} known panes from previous control", self.known_panes.len());
    }

    /// Clear all tracked state (for restart).
    pub fn clear_all(&mut self) {
        self.pane_map.clear();
        self.known_panes.clear();
        if let Ok(mut map) = self.writer.id_map.lock() { map.clear(); }
        if let Ok(mut bufs) = self.output_buffers.lock() { bufs.clear(); }
    }

    /// Create a new window with a shell in the session.
    pub fn create_window(&self) -> Result<(), String> {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        self.writer.send_raw(&format!(
            "new-window -t {} -e HERD_SOCK={} {}\n",
            self.session_name, crate::socket::SOCKET_PATH, shell
        ))
    }

    /// Kill a pane by herd session_id.
    pub fn kill_pane_by_id(&mut self, session_id: &str) -> Result<(), String> {
        let pane_id = self.writer.pane_id_for(session_id)
            .ok_or_else(|| format!("No pane for session {session_id}"))?;

        if self.known_panes.len() <= 1 {
            self.create_window()?;
            std::thread::sleep(std::time::Duration::from_millis(100));
        }

        self.pane_map.remove(&pane_id);
        self.writer.unregister_id(session_id);
        self.known_panes.remove(&pane_id);
        if let Ok(mut bufs) = self.output_buffers.lock() {
            bufs.remove(&pane_id);
        }
        self.writer.send_raw(&format!("kill-pane -t {}\n", pane_id))
    }

    /// Resize by herd session_id.
    pub fn resize_by_id(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let pane_id = self.writer.pane_id_for(session_id)
            .ok_or_else(|| format!("No pane for session {session_id}"))?;
        self.writer.send_raw(&format!("resize-pane -t {} -x {} -y {}\n", pane_id, cols, rows))
    }

    /// Read buffered output for a pane (by herd session_id). Drains the buffer.
    pub fn read_output(&self, session_id: &str) -> Result<String, String> {
        let pane_id = self.writer.pane_id_for(session_id)
            .ok_or_else(|| format!("No pane for session {session_id}"))?;
        let mut bufs = self.output_buffers.lock().map_err(|e| e.to_string())?;
        match bufs.get_mut(&pane_id) {
            Some(b) => {
                let bytes: Vec<u8> = b.drain(..).collect();
                Ok(String::from_utf8_lossy(&bytes).to_string())
            }
            None => Ok(String::new()),
        }
    }

    /// Register a pane_id ↔ herd session_id mapping.
    pub fn register_pane(&mut self, pane_id: &str, session_id: &str) {
        self.pane_map.insert(pane_id.to_string(), session_id.to_string());
        self.writer.register_pane(pane_id, session_id);
        self.known_panes.insert(pane_id.to_string());
    }

    /// List all registered panes.
    pub fn list_panes(&self) -> Vec<(String, String)> {
        self.pane_map.iter()
            .map(|(pane, sid)| (pane.clone(), sid.clone()))
            .collect()
    }
}

impl Drop for TmuxControl {
    fn drop(&mut self) {
        unsafe {
            libc::kill(self.child_pid, libc::SIGTERM);
            libc::waitpid(self.child_pid, std::ptr::null_mut(), libc::WNOHANG);
        }
    }
}

/// Detect new panes by comparing tmux list-panes output with known panes.
fn detect_new_panes(control: Arc<Mutex<TmuxControl>>, app: AppHandle) {
    let server = tmux::server_name();
    let session_name = {
        let ctrl = match control.lock() {
            Ok(c) => c,
            Err(_) => return,
        };
        ctrl.session_name.clone()
    };

    let output = Command::new("tmux")
        .args(["-L", server, "list-panes", "-s", "-t", &session_name,
               "-F", "#{pane_id}\t#{pane_current_command}\t#{pane_pid}\t#{window_index}\t#{window_panes}"])
        .output();

    let output = match output {
        Ok(o) if o.status.success() => o,
        _ => return,
    };

    let text = String::from_utf8_lossy(&output.stdout);
    // (pane_id, command, pid, window_index, panes_in_window)
    let current_panes: Vec<(String, String, String, String, usize)> = text.lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() >= 5 {
                let panes_in_win = parts[4].parse().unwrap_or(1);
                Some((parts[0].to_string(), parts[1].to_string(), parts[2].to_string(),
                      parts[3].to_string(), panes_in_win))
            } else {
                None
            }
        })
        .collect();

    let mut ctrl = match control.lock() {
        Ok(c) => c,
        Err(_) => return,
    };

    // Collect panes that need breaking out AFTER we finish detection
    let mut panes_to_break: Vec<String> = Vec::new();

    for (pane_id, cmd, _pid, win_idx, panes_in_win) in &current_panes {
        if !ctrl.known_panes.contains(pane_id) {
            // New pane detected!

            let session_id = uuid::Uuid::new_v4().to_string();
            ctrl.register_pane(pane_id, &session_id);

            // Find parent: a known pane in the same window is the parent
            let parent_session_id = if *panes_in_win > 1 {
                current_panes.iter()
                    .find(|(pid, _, _, widx, _)| widx == win_idx && pid != pane_id && ctrl.known_panes.contains(pid))
                    .and_then(|(pid, _, _, _, _)| ctrl.pane_map.get(pid).cloned())
            } else {
                None
            };

            log::info!("New pane detected: {} ({}), assigned {}, parent={:?}",
                       pane_id, cmd, session_id, parent_session_id);

            // Mark for break-pane if it shares a window with other panes
            if *panes_in_win > 1 {
                panes_to_break.push(pane_id.clone());
            }

            let payload = serde_json::json!({
                "session_id": session_id,
                "pane_id": pane_id,
                "command": cmd,
                "x": 100.0 + (rand_offset() * 400.0),
                "y": 100.0 + (rand_offset() * 300.0),
                "width": 640.0,
                "height": 400.0,
                "parent_session_id": parent_session_id,
            });
            let _ = app.emit("shell-spawned", payload);

            // Set title based on command
            let title = if cmd == "zsh" || cmd == "bash" || cmd == "sh" {
                "shell".to_string()
            } else {
                cmd.clone()
            };
            if title != "shell" {
                let title_payload = serde_json::json!({
                    "session_id": session_id,
                    "title": title,
                });
                let _ = app.emit("shell-title-changed", title_payload);
            }
        }
    }

    // Detect removed panes
    let current_ids: HashSet<String> = current_panes.iter().map(|(id, _, _, _, _)| id.clone()).collect();
    let removed: Vec<String> = ctrl.known_panes.iter()
        .filter(|id| !current_ids.contains(*id))
        .cloned()
        .collect();

    for pane_id in removed {
        if let Some(session_id) = ctrl.pane_map.remove(&pane_id) {
            ctrl.writer.unregister_id(&session_id);
            if let Ok(mut bufs) = ctrl.output_buffers.lock() { bufs.remove(&pane_id); }
            let _ = app.emit("shell-destroyed", &session_id);
            log::info!("Pane removed: {} ({})", pane_id, session_id);
        }
        ctrl.known_panes.remove(&pane_id);
    }

    // Drop the lock before break-pane (which triggers layout-change events)
    drop(ctrl);

    // Break split panes into their own windows so they get full dimensions.
    // This runs AFTER registration so pane_map is already set for %output routing.
    for pane_id in panes_to_break {
        log::info!("Breaking pane {} out of shared window", pane_id);
        let _ = Command::new("tmux")
            .args(["-L", server, "break-pane", "-d", "-s", &pane_id])
            .status();
    }
}

fn rand_offset() -> f64 {
    use std::time::SystemTime;
    let t = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos();
    (t as f64 % 1000.0) / 1000.0
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
