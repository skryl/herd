use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::collections::HashMap;
use std::sync::mpsc::Sender;

use serde_json::Value;

use crate::persist::{self, HerdState, TileState};
use crate::tmux_control::{TmuxControl, TmuxWriter, OutputBuffers};

type PendingTestDriverRequests = HashMap<String, Sender<Result<Value, String>>>;

#[derive(Clone)]
pub struct AppState {
    pub tmux_control: Arc<Mutex<Option<Arc<Mutex<TmuxControl>>>>>,
    pub tmux_writer: Arc<Mutex<Option<Arc<TmuxWriter>>>>,
    pub output_buffers: Arc<Mutex<Option<OutputBuffers>>>,
    pub tile_states: Arc<Mutex<HerdState>>,
    pub snapshot_version: Arc<AtomicU64>,
    pub last_active_session: Arc<Mutex<Option<String>>>,
    pub window_parents: Arc<Mutex<HashMap<String, String>>>,
    pub test_driver_frontend_ready: Arc<AtomicBool>,
    pub test_driver_bootstrap_complete: Arc<AtomicBool>,
    pub pending_test_driver_requests: Arc<Mutex<PendingTestDriverRequests>>,
    pub test_driver_request_counter: Arc<AtomicU64>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            tmux_control: Arc::new(Mutex::new(None)),
            tmux_writer: Arc::new(Mutex::new(None)),
            output_buffers: Arc::new(Mutex::new(None)),
            tile_states: Arc::new(Mutex::new(persist::load())),
            snapshot_version: Arc::new(AtomicU64::new(0)),
            last_active_session: Arc::new(Mutex::new(None)),
            window_parents: Arc::new(Mutex::new(HashMap::new())),
            test_driver_frontend_ready: Arc::new(AtomicBool::new(false)),
            test_driver_bootstrap_complete: Arc::new(AtomicBool::new(false)),
            pending_test_driver_requests: Arc::new(Mutex::new(HashMap::new())),
            test_driver_request_counter: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn set_control(&self, control: Arc<Mutex<TmuxControl>>) {
        let old = self.tmux_control.lock()
            .ok()
            .and_then(|mut guard| guard.take());

        if let Some(ref old_control) = old {
            if let (Ok(mut new_ctrl), Ok(old_ctrl)) = (control.lock(), old_control.lock()) {
                new_ctrl.inherit_state(&old_ctrl);
            }
        }

        if let Ok(ctrl) = control.lock() {
            if let Ok(mut w) = self.tmux_writer.lock() {
                *w = Some(ctrl.writer.clone());
            }
            if let Ok(mut b) = self.output_buffers.lock() {
                *b = Some(ctrl.output_buffers.clone());
            }
        }
        if let Ok(mut c) = self.tmux_control.lock() {
            *c = Some(control);
        }

        if let Some(old_control) = old {
            if let Ok(old_ctrl) = old_control.lock() {
                old_ctrl.terminate();
            }
        }
    }

    pub fn current_control_pid(&self) -> Option<libc::pid_t> {
        let guard = self.tmux_control.lock().ok()?;
        let control = guard.as_ref()?;
        let ctrl = control.lock().ok()?;
        Some(ctrl.child_pid())
    }

    pub fn read_output(&self, session_id: &str) -> Result<String, String> {
        let guard = self.output_buffers.lock().map_err(|e| e.to_string())?;
        let bufs_arc = guard.as_ref().ok_or("output buffers not initialized")?;
        let mut bufs = bufs_arc.lock().map_err(|e| e.to_string())?;
        match bufs.get_mut(session_id) {
            Some(b) => {
                let bytes: Vec<u8> = b.drain(..).collect();
                Ok(String::from_utf8_lossy(&bytes).to_string())
            }
            None => Ok(String::new()),
        }
    }

    pub fn with_control<F, R>(&self, f: F) -> Result<R, String>
    where
        F: FnOnce(&mut TmuxControl) -> Result<R, String>,
    {
        let guard = self.tmux_control.lock().map_err(|e| e.to_string())?;
        let control = guard.as_ref().ok_or("tmux control not initialized")?;
        let mut ctrl = control.lock().map_err(|e| e.to_string())?;
        f(&mut ctrl)
    }

    pub fn set_tile_state(&self, pane_id: &str, tile: TileState) {
        if let Ok(mut states) = self.tile_states.lock() {
            states.insert(pane_id.to_string(), tile);
        }
    }

    pub fn get_tile_state(&self, pane_id: &str) -> Option<TileState> {
        if let Ok(states) = self.tile_states.lock() {
            states.get(pane_id).cloned()
        } else {
            None
        }
    }

    pub fn remove_tile_state(&self, pane_id: &str) {
        if let Ok(mut states) = self.tile_states.lock() {
            states.remove(pane_id);
        }
    }

    pub fn save(&self) {
        if let Ok(states) = self.tile_states.lock() {
            persist::save(&states);
        }
    }

    pub fn next_snapshot_version(&self) -> u64 {
        self.snapshot_version.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn set_last_active_session(&self, session_id: Option<String>) {
        if let Ok(mut active) = self.last_active_session.lock() {
            *active = session_id.filter(|value| !value.trim().is_empty());
        }
    }

    pub fn last_active_session(&self) -> Option<String> {
        self.last_active_session
            .lock()
            .ok()
            .and_then(|active| active.clone())
    }

    pub fn set_window_parent(&self, child_window_id: &str, parent_window_id: Option<String>) {
        if let Ok(mut parents) = self.window_parents.lock() {
            let resolved_parent = parent_window_id
                .and_then(|parent| resolve_root_parent_from_map(&parents, &parent).or(Some(parent)))
                .filter(|parent| parent != child_window_id);
            match resolved_parent {
                Some(parent_window_id) => {
                    parents.insert(child_window_id.to_string(), parent_window_id);
                }
                None => {
                    parents.remove(child_window_id);
                }
            }
        }
    }

    pub fn window_parents_snapshot(&self) -> HashMap<String, String> {
        self.window_parents
            .lock()
            .map(|parents| {
                parents
                    .keys()
                    .filter_map(|child| {
                        resolve_root_parent_from_map(&parents, child)
                            .map(|parent| (child.clone(), parent))
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn resolve_root_window_parent(&self, window_id: &str) -> Option<String> {
        self.window_parents
            .lock()
            .ok()
            .and_then(|parents| resolve_root_parent_from_map(&parents, window_id))
    }

    pub fn retain_window_parents<F>(&self, mut keep: F)
    where
        F: FnMut(&str, &str) -> bool,
    {
        if let Ok(mut parents) = self.window_parents.lock() {
            parents.retain(|child, parent| keep(child, parent));
        }
    }

    pub fn set_test_driver_frontend_ready(&self, ready: bool) {
        self.test_driver_frontend_ready.store(ready, Ordering::SeqCst);
    }

    pub fn test_driver_frontend_ready(&self) -> bool {
        self.test_driver_frontend_ready.load(Ordering::SeqCst)
    }

    pub fn set_test_driver_bootstrap_complete(&self, complete: bool) {
        self.test_driver_bootstrap_complete.store(complete, Ordering::SeqCst);
    }

    pub fn test_driver_bootstrap_complete(&self) -> bool {
        self.test_driver_bootstrap_complete.load(Ordering::SeqCst)
    }

    pub fn next_test_driver_request_id(&self) -> String {
        let value = self.test_driver_request_counter.fetch_add(1, Ordering::SeqCst) + 1;
        format!("test-driver-{value}")
    }

    pub fn register_test_driver_request(
        &self,
        request_id: &str,
        sender: Sender<Result<Value, String>>,
    ) -> Result<(), String> {
        let mut pending = self.pending_test_driver_requests.lock().map_err(|e| e.to_string())?;
        pending.insert(request_id.to_string(), sender);
        Ok(())
    }

    pub fn cancel_test_driver_request(&self, request_id: &str) {
        if let Ok(mut pending) = self.pending_test_driver_requests.lock() {
            pending.remove(request_id);
        }
    }

    pub fn resolve_test_driver_request(
        &self,
        request_id: &str,
        result: Result<Value, String>,
    ) -> Result<bool, String> {
        let sender = self
            .pending_test_driver_requests
            .lock()
            .map_err(|e| e.to_string())?
            .remove(request_id);

        if let Some(sender) = sender {
            let _ = sender.send(result);
            return Ok(true);
        }

        Ok(false)
    }
}

fn resolve_root_parent_from_map(
    parents: &HashMap<String, String>,
    window_id: &str,
) -> Option<String> {
    let mut current = parents.get(window_id)?.clone();
    let mut seen = std::collections::HashSet::from([window_id.to_string()]);

    loop {
      if !seen.insert(current.clone()) {
          return None;
      }
      match parents.get(&current).cloned() {
          Some(next) => current = next,
          None => return Some(current),
      }
    }
}
