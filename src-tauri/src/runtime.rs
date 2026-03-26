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
    database_path: String,
    dom_result_path: String,
    test_driver_enabled: bool,
    fixture_agents_enabled: bool,
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

fn fixture_agents_enabled_from_env(test_driver_enabled: bool, value: Option<&str>) -> bool {
    test_driver_enabled
        && matches!(
            value.map(str::trim).filter(|raw| !raw.is_empty()),
            Some("fixture")
        )
}

fn build_runtime_config() -> RuntimeConfig {
    let test_driver_enabled = cfg!(debug_assertions)
        || matches!(std::env::var("HERD_ENABLE_TEST_DRIVER").ok().as_deref(), Some("1" | "true" | "yes"));
    let runtime_id = std::env::var("HERD_RUNTIME_ID")
        .ok()
        .and_then(|value| sanitize_runtime_id(&value));
    let runtime_name = runtime_id
        .as_ref()
        .map(|value| format!("herd-{value}"))
        .unwrap_or_else(|| "herd".to_string());
    let project_tmp_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tmp");

    RuntimeConfig {
        runtime_id: runtime_id.clone(),
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
        database_path: project_tmp_dir
            .join(database_file_name(runtime_id.as_deref()))
            .to_string_lossy()
            .to_string(),
        dom_result_path: format!("/tmp/{runtime_name}-dom-result.json"),
        test_driver_enabled,
        fixture_agents_enabled: fixture_agents_enabled_from_env(
            test_driver_enabled,
            std::env::var("HERD_TEST_AGENT_MODE").ok().as_deref(),
        ),
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

pub fn database_path() -> &'static str {
    config().database_path.as_str()
}

pub fn dom_result_path() -> &'static str {
    config().dom_result_path.as_str()
}

pub fn project_tmp_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../tmp")
}

fn database_file_name(runtime_id: Option<&str>) -> String {
    runtime_id
        .map(|value| format!("herd-{value}.sqlite"))
        .unwrap_or_else(|| "herd.sqlite".to_string())
}

fn looks_like_project_root(path: &Path) -> bool {
    path.join(".mcp.json").is_file()
        && path.join("mcp-server").is_dir()
        && path.join("src-tauri").is_dir()
}

fn detect_project_root_from(start: &Path) -> Option<PathBuf> {
    let mut current = Some(start);
    while let Some(path) = current {
        if looks_like_project_root(path) {
            return Some(path.to_path_buf());
        }
        current = path.parent();
    }
    None
}

pub fn project_root_dir() -> PathBuf {
    let manifest_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).to_path_buf());
    if looks_like_project_root(&manifest_root) {
        return manifest_root;
    }

    if let Ok(current) = std::env::current_dir() {
        if let Some(root) = detect_project_root_from(&current) {
            return root;
        }
    }

    manifest_root
}

pub fn project_mcp_config_path() -> PathBuf {
    project_root_dir().join(".mcp.json")
}

pub fn tmux_socket_file_path() -> PathBuf {
    let uid = unsafe { libc::geteuid() };
    PathBuf::from(format!("/private/tmp/tmux-{uid}/{}", tmux_server_name()))
}

pub fn test_driver_enabled() -> bool {
    config().test_driver_enabled
}

pub fn fixture_agents_enabled() -> bool {
    config().fixture_agents_enabled
}

#[cfg(test)]
mod tests {
    use super::{database_file_name, detect_project_root_from, fixture_agents_enabled_from_env, looks_like_project_root};
    use std::fs;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!("herd-runtime-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        base
    }

    #[test]
    fn project_root_detection_walks_up_to_repo_markers() {
        let root = temp_dir("project-root");
        fs::write(root.join(".mcp.json"), "{}").unwrap();
        fs::create_dir_all(root.join("mcp-server")).unwrap();
        fs::create_dir_all(root.join("src-tauri")).unwrap();
        fs::create_dir_all(root.join("src-tauri/src")).unwrap();

        let nested = root.join("src-tauri/src");
        let detected = detect_project_root_from(&nested).unwrap();
        assert_eq!(detected, root);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn project_root_detection_requires_herd_layout() {
        let root = temp_dir("mcp-root");
        fs::write(root.join(".mcp.json"), "{}").unwrap();
        fs::create_dir_all(root.join("nested/deeper")).unwrap();

        assert!(detect_project_root_from(&root.join("nested/deeper")).is_none());
        assert!(!looks_like_project_root(&root));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn database_file_name_uses_runtime_suffix() {
        assert_eq!(database_file_name(None), "herd.sqlite");
        assert_eq!(database_file_name(Some("dev")), "herd-dev.sqlite");
    }

    #[test]
    fn fixture_agents_only_enable_in_test_driver_mode() {
        assert!(fixture_agents_enabled_from_env(true, Some("fixture")));
        assert!(!fixture_agents_enabled_from_env(false, Some("fixture")));
        assert!(!fixture_agents_enabled_from_env(true, Some("claude")));
        assert!(!fixture_agents_enabled_from_env(true, None));
    }
}
