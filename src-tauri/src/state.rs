use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicU64, Ordering};
use crate::persist::{self, HerdState, TileState};
use crate::tmux_control::{TmuxControl, TmuxWriter, OutputBuffers};

#[derive(Clone)]
pub struct AppState {
    pub tmux_control: Arc<Mutex<Option<Arc<Mutex<TmuxControl>>>>>,
    pub tmux_writer: Arc<Mutex<Option<Arc<TmuxWriter>>>>,
    pub output_buffers: Arc<Mutex<Option<OutputBuffers>>>,
    pub tile_states: Arc<Mutex<HerdState>>,
    pub snapshot_version: Arc<AtomicU64>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            tmux_control: Arc::new(Mutex::new(None)),
            tmux_writer: Arc::new(Mutex::new(None)),
            output_buffers: Arc::new(Mutex::new(None)),
            tile_states: Arc::new(Mutex::new(persist::load())),
            snapshot_version: Arc::new(AtomicU64::new(0)),
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
}
