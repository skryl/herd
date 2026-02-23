use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use herd::config::{AppConfig, HerdModeDefinition, default_config_path, default_state_path};
use herd::tmux::{SystemTmuxAdapter, TmuxAdapter};
use herd::tui::AppModel;

#[test]
fn config_loads_defaults_when_missing_and_applies_partial_overrides() {
    let missing_path = temp_file("missing_config");
    let defaults = AppConfig::load_from_path(&missing_path).expect("missing should use defaults");
    assert_eq!(
        defaults.stall_threshold_secs,
        AppConfig::default().stall_threshold_secs
    );

    let override_path = temp_file("override_config");
    fs::write(
        &override_path,
        r#"{
  "stall_threshold_secs": 45,
  "nudge_message": "continue please",
  "herd_count": 6,
  "openai_api_key": "sk-test-openai",
  "anthropic_api_key": "sk-test-anthropic",
  "llm_provider": "anthropic",
  "llm_model": "claude-3-5-sonnet-latest"
}"#,
    )
    .expect("override file should write");

    let loaded = AppConfig::load_from_path(&override_path).expect("override config should parse");
    assert_eq!(loaded.stall_threshold_secs, 45);
    assert_eq!(loaded.nudge_message, "continue please");
    assert_eq!(loaded.herd_count, 6);
    assert_eq!(loaded.openai_api_key, "sk-test-openai");
    assert_eq!(loaded.anthropic_api_key, "sk-test-anthropic");
    assert_eq!(loaded.llm_provider, "anthropic");
    assert_eq!(loaded.llm_model, "claude-3-5-sonnet-latest");
    assert_eq!(
        loaded.marker_lookback_lines,
        AppConfig::default().marker_lookback_lines
    );
    assert_eq!(
        loaded.status_track_exact_commands,
        AppConfig::default().status_track_exact_commands
    );
    assert_eq!(
        loaded.agent_process_markers,
        AppConfig::default().agent_process_markers
    );
    assert_eq!(
        loaded.live_capture_line_multiplier,
        AppConfig::default().live_capture_line_multiplier
    );
    assert_eq!(
        loaded.live_capture_min_lines,
        AppConfig::default().live_capture_min_lines
    );
    assert_eq!(
        loaded.status_waiting_grace_secs,
        AppConfig::default().status_waiting_grace_secs
    );
    assert_eq!(
        loaded.status_transition_stability_secs,
        AppConfig::default().status_transition_stability_secs
    );
    assert_eq!(
        loaded.status_confidence_min_for_trigger,
        AppConfig::default().status_confidence_min_for_trigger
    );
    assert!(
        !loaded.herd_modes.is_empty(),
        "default herd modes should be retained when not provided"
    );

    let _ = fs::remove_file(override_path);
}

#[test]
fn config_round_trip_save_and_load_is_stable() {
    let path = temp_file("roundtrip_config");
    let config = AppConfig {
        refresh_interval_ms: 900,
        capture_lines: 120,
        stall_threshold_secs: 70,
        cooldown_secs: 80,
        max_nudges: 4,
        nudge_message: "nudge now".to_string(),
        finished_markers: vec!["finished".to_string(), "complete".to_string()],
        waiting_markers: vec!["waiting".to_string()],
        marker_lookback_lines: 12,
        status_track_exact_commands: vec!["tmux".to_string(), "zellij".to_string()],
        agent_process_markers: vec!["claude".to_string(), "codex".to_string()],
        status_waiting_grace_secs: 90,
        status_transition_stability_secs: 4,
        status_confidence_min_for_trigger: 65,
        live_capture_line_multiplier: 6,
        live_capture_min_lines: 350,
        herd_count: 7,
        openai_api_key: "openai-key".to_string(),
        anthropic_api_key: "anthropic-key".to_string(),
        llm_provider: "openai".to_string(),
        llm_model: "gpt-4.1-mini".to_string(),
        herd_modes: vec![HerdModeDefinition {
            name: "Fast".to_string(),
            rule_file: "herd_modes/fast.json".to_string(),
        }],
    };
    config
        .save_to_path(&path)
        .expect("config should save successfully");
    let loaded = AppConfig::load_from_path(&path).expect("config should load successfully");
    assert_eq!(loaded.refresh_interval_ms, 900);
    assert_eq!(loaded.capture_lines, 120);
    assert_eq!(loaded.max_nudges, 4);
    assert_eq!(loaded.nudge_message, "nudge now");
    assert_eq!(loaded.marker_lookback_lines, 12);
    assert_eq!(
        loaded.status_track_exact_commands,
        vec!["tmux".to_string(), "zellij".to_string()]
    );
    assert_eq!(
        loaded.agent_process_markers,
        vec!["claude".to_string(), "codex".to_string()]
    );
    assert_eq!(loaded.status_waiting_grace_secs, 90);
    assert_eq!(loaded.status_transition_stability_secs, 4);
    assert_eq!(loaded.status_confidence_min_for_trigger, 65);
    assert_eq!(loaded.live_capture_line_multiplier, 6);
    assert_eq!(loaded.live_capture_min_lines, 350);
    assert_eq!(loaded.herd_count, 7);
    assert_eq!(loaded.openai_api_key, "openai-key");
    assert_eq!(loaded.anthropic_api_key, "anthropic-key");
    assert_eq!(loaded.llm_provider, "openai");
    assert_eq!(loaded.llm_model, "gpt-4.1-mini");
    assert_eq!(loaded.herd_modes.len(), 1);
    assert_eq!(loaded.herd_modes[0].name, "Fast");
    assert_eq!(loaded.herd_modes[0].rule_file, "herd_modes/fast.json");

    let _ = fs::remove_file(path);
}

#[test]
fn default_paths_point_to_config_herd_directory() {
    let config = default_config_path();
    let state = default_state_path();

    assert!(
        config
            .to_string_lossy()
            .contains(".config/herd/settings.json")
    );
    assert!(state.to_string_lossy().contains(".config/herd/state.json"));
}

#[test]
fn missing_settings_file_is_created_on_first_load() {
    let path = temp_file("first_boot_settings");
    let _ = fs::remove_file(&path);

    let _ = AppConfig::load_from_path(&path).expect("missing settings should load defaults");
    assert!(
        path.exists(),
        "settings file should be created on first load"
    );

    let raw = fs::read_to_string(&path).expect("settings file should be readable");
    assert!(raw.contains("\"herd_count\""));
    assert!(raw.contains("\"llm_provider\""));
    assert!(raw.contains("\"herd_modes\""));
    assert!(raw.contains("\"status_track_exact_commands\""));
    assert!(raw.contains("\"agent_process_markers\""));

    let herd_modes_dir = path
        .parent()
        .expect("settings path should include parent")
        .join("herd_modes");
    assert!(herd_modes_dir.exists(), "herd mode directory should exist");
    assert!(
        herd_modes_dir.join("balanced.json").exists(),
        "default herd mode rule file should be created"
    );

    let _ = fs::remove_file(path);
}

#[test]
fn app_model_tracks_refresh_warning_and_clears_after_recovery() {
    let mut model = AppModel::new(vec![]);
    model.note_refresh_error("tmux disconnected");
    assert_eq!(model.status_message(), Some("tmux disconnected"));

    model.note_refresh_success();
    assert!(model.status_message().is_none());
}

#[test]
fn tmux_adapter_recovers_after_server_restart_on_same_socket() {
    let socket = format!("herd-config-resilience-{}", unique_suffix());
    let session = "config_resilience_recover";

    let setup_one = Command::new("tmux")
        .args([
            "-L",
            &socket,
            "-f",
            "/dev/null",
            "new-session",
            "-d",
            "-s",
            session,
        ])
        .status()
        .expect("tmux should start");
    assert!(setup_one.success());

    let adapter = SystemTmuxAdapter::new(Some(socket.clone()));
    let before = adapter.list_sessions().expect("first list should succeed");
    assert!(before.iter().any(|item| item.session_name == session));

    let kill = Command::new("tmux")
        .args(["-L", &socket, "kill-server"])
        .status()
        .expect("kill-server should run");
    assert!(kill.success());

    let during = adapter.list_sessions();
    assert!(during.is_err(), "list should error while server is down");

    let setup_two = Command::new("tmux")
        .args([
            "-L",
            &socket,
            "-f",
            "/dev/null",
            "new-session",
            "-d",
            "-s",
            session,
        ])
        .status()
        .expect("tmux should restart");
    assert!(setup_two.success());

    let after = adapter
        .list_sessions()
        .expect("list should recover after restart");
    assert!(after.iter().any(|item| item.session_name == session));

    let _ = Command::new("tmux")
        .args(["-L", &socket, "kill-server"])
        .status();
}

fn temp_file(prefix: &str) -> PathBuf {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be monotonic enough")
        .as_millis();
    let dir = std::env::temp_dir().join(format!("{prefix}_{suffix}"));
    let _ = fs::create_dir_all(&dir);
    dir.join("settings.json")
}

fn unique_suffix() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be monotonic enough")
        .as_millis()
}
