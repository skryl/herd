use std::path::{Path, PathBuf};
use std::sync::OnceLock;

#[derive(Debug, Clone)]
pub struct RuntimeConfig {
    runtime_id: Option<String>,
    tmux_server_name: String,
    session_name: String,
    socket_path: String,
    socket_log_path: String,
    cc_log_path: String,
    state_path: String,
    dom_result_path: String,
    test_driver_enabled: bool,
}

static CONFIG: OnceLock<RuntimeConfig> = OnceLock::new();

fn sanitize_runtime_id(value: &str) -> Option<String> {
    let sanitized: String = value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
        .collect();

    if sanitized.is_empty() {
        None
    } else {
        Some(sanitized)
    }
}

fn build_runtime_config() -> RuntimeConfig {
    let runtime_id = std::env::var("HERD_RUNTIME_ID")
        .ok()
        .and_then(|value| sanitize_runtime_id(&value));
    let runtime_name = runtime_id
        .as_ref()
        .map(|value| format!("herd-{value}"))
        .unwrap_or_else(|| "herd".to_string());
    let project_tmp_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tmp");

    RuntimeConfig {
        runtime_id,
        tmux_server_name: runtime_name.clone(),
        session_name: runtime_name.clone(),
        socket_path: format!("/tmp/{runtime_name}.sock"),
        socket_log_path: project_tmp_dir
            .join(format!("{runtime_name}-socket.log"))
            .to_string_lossy()
            .to_string(),
        cc_log_path: project_tmp_dir
            .join(format!("{runtime_name}-cc.log"))
            .to_string_lossy()
            .to_string(),
        state_path: project_tmp_dir
            .join(format!("{runtime_name}-state.json"))
            .to_string_lossy()
            .to_string(),
        dom_result_path: format!("/tmp/{runtime_name}-dom-result.json"),
        test_driver_enabled: cfg!(debug_assertions)
            || matches!(std::env::var("HERD_ENABLE_TEST_DRIVER").ok().as_deref(), Some("1" | "true" | "yes")),
    }
}

pub fn config() -> &'static RuntimeConfig {
    CONFIG.get_or_init(build_runtime_config)
}

pub fn runtime_id() -> Option<&'static str> {
    config().runtime_id.as_deref()
}

pub fn tmux_server_name() -> &'static str {
    config().tmux_server_name.as_str()
}

pub fn session_name() -> &'static str {
    config().session_name.as_str()
}

pub fn socket_path() -> &'static str {
    config().socket_path.as_str()
}

pub fn socket_log_path() -> &'static str {
    config().socket_log_path.as_str()
}

pub fn cc_log_path() -> &'static str {
    config().cc_log_path.as_str()
}

pub fn state_path() -> &'static str {
    config().state_path.as_str()
}

pub fn dom_result_path() -> &'static str {
    config().dom_result_path.as_str()
}

pub fn project_tmp_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../tmp")
}

pub fn tmux_socket_file_path() -> PathBuf {
    let uid = unsafe { libc::geteuid() };
    PathBuf::from(format!("/private/tmp/tmux-{uid}/{}", tmux_server_name()))
}

pub fn test_driver_enabled() -> bool {
    config().test_driver_enabled
}
