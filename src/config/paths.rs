use std::path::PathBuf;

pub fn default_config_path() -> PathBuf {
    config_root_dir().join("settings.json")
}

pub fn default_state_path() -> PathBuf {
    config_root_dir().join("state.json")
}

fn config_root_dir() -> PathBuf {
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home).join(".config").join("herd");
    }
    PathBuf::from(".config").join("herd")
}
