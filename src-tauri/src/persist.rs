use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;

use crate::runtime;

/// Tile metadata that gets persisted across Herd restarts.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TileState {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Maps tmux pane ID -> tile state.
pub type HerdState = HashMap<String, TileState>;

fn state_path() -> String {
    runtime::state_path().to_string()
}

/// Load persisted state from disk.
pub fn load() -> HerdState {
    let path = state_path();
    match fs::read_to_string(&path) {
        Ok(data) => serde_json::from_str(&data).unwrap_or_default(),
        Err(_) => HashMap::new(),
    }
}

/// Save state to disk.
pub fn save(state: &HerdState) {
    let path = state_path();
    if let Some(parent) = Path::new(&path).parent() {
        let _ = fs::create_dir_all(parent);
    }
    match serde_json::to_string_pretty(state) {
        Ok(json) => {
            if let Err(e) = fs::write(&path, json) {
                log::warn!("Failed to save herd state: {e}");
            } else {
                log::info!("Saved herd state to {path}");
            }
        }
        Err(e) => log::warn!("Failed to serialize herd state: {e}"),
    }
}
