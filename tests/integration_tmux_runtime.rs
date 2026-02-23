#[path = "helpers/codex_stub.rs"]
mod codex_stub;

use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::process::{Command, Output};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use codex_stub::{
    prepend_to_path, resolve_codex_binary, shell_single_quote, write_fake_codex_app_server_bin,
};
use herd::config::{AppConfig, HerdModeDefinition};
use herd::tmux::{ControlModeMultiplexer, SystemTmuxAdapter, TmuxAdapter};
use serde_json::json;

struct TmuxSocketGuard {
    socket: String,
}

impl Drop for TmuxSocketGuard {
    fn drop(&mut self) {
        let _ = Command::new("tmux")
            .args(["-L", &self.socket, "kill-server"])
            .status();
    }
}

#[test]
fn send_keys_repeatedly_delivers_commands_to_target_pane() {
    let socket = unique_socket("herd-tmux-runtime-send");
    let _guard = TmuxSocketGuard {
        socket: socket.clone(),
    };
    let session = "herd_tmux_runtime_send";
    start_tmux_session(&socket, session, "bash --noprofile --norc");

    let pane_id = first_pane_id(&socket, session);
    let mut adapter = SystemTmuxAdapter::new(Some(socket.clone()));

    adapter
        .send_keys(&pane_id, "echo HERD_SEND_1")
        .expect("first send should succeed");
    adapter
        .send_keys(&pane_id, "echo HERD_SEND_2")
        .expect("second send should succeed");
    adapter
        .send_keys(&pane_id, "echo HERD_SEND_3")
        .expect("third send should succeed");

    let deadline = Instant::now() + Duration::from_secs(3);
    let mut content = String::new();
    while Instant::now() < deadline {
        content = adapter
            .capture_pane(&pane_id, 120)
            .expect("capture should succeed")
            .content;
        if content.contains("HERD_SEND_1")
            && content.contains("HERD_SEND_2")
            && content.contains("HERD_SEND_3")
        {
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }

    assert!(
        content.contains("HERD_SEND_1")
            && content.contains("HERD_SEND_2")
            && content.contains("HERD_SEND_3"),
        "expected all send markers in pane content, got:\n{content}"
    );
}

#[test]
fn list_sessions_returns_empty_when_tmux_has_no_current_target() {
    let socket = unique_socket("herd-tmux-runtime-empty");
    let _guard = TmuxSocketGuard {
        socket: socket.clone(),
    };
    let session = "herd_tmux_runtime_empty";
    start_tmux_session(&socket, session, "sleep 1");

    let set_status = Command::new("tmux")
        .args(["-L", &socket, "set-option", "-s", "exit-empty", "off"])
        .status()
        .expect("set-option should execute");
    assert!(
        set_status.success(),
        "expected set-option exit-empty off to succeed"
    );

    wait_until(Duration::from_secs(4), || {
        let output = tmux_output(&socket, &["list-sessions"]);
        output.status.success() && String::from_utf8_lossy(&output.stdout).trim().is_empty()
    });

    let adapter = SystemTmuxAdapter::new(Some(socket));
    let sessions = adapter
        .list_sessions()
        .expect("list_sessions should return empty, not an error");
    assert!(
        sessions.is_empty(),
        "expected no sessions, got {}",
        sessions.len()
    );
}

#[test]
fn enabling_adapter_passthrough_keeps_server_available_after_last_session_exits() {
    let socket = unique_socket("herd-tmux-runtime-keepalive");
    let _guard = TmuxSocketGuard {
        socket: socket.clone(),
    };
    let session = "herd_tmux_runtime_keepalive";
    start_tmux_session(&socket, session, "sleep 1");

    let adapter = SystemTmuxAdapter::new(Some(socket.clone()));
    adapter.enable_extended_keys_passthrough();
    let destroy_unattached = tmux_output(&socket, &["show-options", "-g", "destroy-unattached"]);
    assert!(
        destroy_unattached.status.success(),
        "expected show-options destroy-unattached to succeed"
    );
    assert!(
        String::from_utf8_lossy(&destroy_unattached.stdout).contains("destroy-unattached off"),
        "expected adapter to disable destroy-unattached, got {}",
        String::from_utf8_lossy(&destroy_unattached.stdout)
    );

    wait_until(Duration::from_secs(4), || {
        let output = tmux_output(&socket, &["list-sessions"]);
        output.status.success() && String::from_utf8_lossy(&output.stdout).trim().is_empty()
    });

    let probe = tmux_output(&socket, &["list-sessions"]);
    assert!(
        probe.status.success(),
        "expected tmux server to stay available, stderr={}",
        String::from_utf8_lossy(&probe.stderr)
    );

    let sessions = adapter
        .list_sessions()
        .expect("list_sessions should succeed against live server");
    assert!(sessions.is_empty(), "expected no active panes");
}

#[test]
fn list_sessions_omits_dead_panes_when_windows_remain_open() {
    let socket = unique_socket("herd-tmux-runtime-dead-pane");
    let _guard = TmuxSocketGuard {
        socket: socket.clone(),
    };
    let session = "herd_tmux_runtime_dead_pane";
    start_tmux_session(&socket, session, "bash --noprofile --norc");

    let set_remain = Command::new("tmux")
        .args([
            "-L",
            &socket,
            "set-window-option",
            "-t",
            &format!("{session}:0"),
            "remain-on-exit",
            "on",
        ])
        .status()
        .expect("set-window-option should execute");
    assert!(
        set_remain.success(),
        "expected remain-on-exit to be set for test session"
    );

    let pane_id = first_pane_id(&socket, session);
    let exit_status = Command::new("tmux")
        .args(["-L", &socket, "send-keys", "-t", &pane_id, "exit", "Enter"])
        .status()
        .expect("send-keys exit should execute");
    assert!(
        exit_status.success(),
        "expected pane exit command to succeed for {pane_id}"
    );

    wait_until(Duration::from_secs(3), || {
        let output = tmux_output(
            &socket,
            &["list-panes", "-t", session, "-F", "#{pane_dead}"],
        );
        output.status.success()
            && String::from_utf8_lossy(&output.stdout)
                .lines()
                .any(|value| value.trim() == "1")
    });

    let adapter = SystemTmuxAdapter::new(Some(socket.clone()));
    let sessions = adapter
        .list_sessions()
        .expect("list_sessions should succeed against dead pane scenario");
    assert!(
        sessions
            .iter()
            .all(|session_ref| session_ref.pane_id != pane_id),
        "dead pane should be omitted from active list"
    );
}

#[test]
fn list_sessions_updates_when_windows_and_sessions_disconnect() {
    let socket = unique_socket("herd-tmux-runtime-disconnect");
    let _guard = TmuxSocketGuard {
        socket: socket.clone(),
    };
    let session = "herd_tmux_runtime_disconnect";
    start_tmux_session(&socket, session, "bash --noprofile --norc");

    let add_window = Command::new("tmux")
        .args([
            "-L",
            &socket,
            "new-window",
            "-t",
            session,
            "-n",
            "extra",
            "bash --noprofile --norc",
        ])
        .status()
        .expect("new-window should execute");
    assert!(add_window.success(), "expected second window to be created");

    let adapter = SystemTmuxAdapter::new(Some(socket.clone()));
    adapter.enable_extended_keys_passthrough();
    let initial = adapter
        .list_sessions()
        .expect("initial list should succeed after creating second window");
    assert!(
        initial
            .iter()
            .any(|session_ref| session_ref.window_index == 1),
        "expected window index 1 in initial list"
    );

    let kill_window = Command::new("tmux")
        .args(["-L", &socket, "kill-window", "-t", &format!("{session}:1")])
        .status()
        .expect("kill-window should execute");
    assert!(kill_window.success(), "expected window kill to succeed");

    wait_until(Duration::from_secs(3), || match adapter.list_sessions() {
        Ok(sessions) => sessions
            .iter()
            .all(|session_ref| session_ref.window_index != 1),
        Err(_) => false,
    });

    let kill_session = Command::new("tmux")
        .args(["-L", &socket, "kill-session", "-t", session])
        .status()
        .expect("kill-session should execute");
    assert!(kill_session.success(), "expected session kill to succeed");

    wait_until(Duration::from_secs(3), || match adapter.list_sessions() {
        Ok(sessions) => sessions.is_empty(),
        Err(_) => false,
    });
}

#[test]
fn adapter_passthrough_clears_session_destroy_unattached_override() {
    let socket = unique_socket("herd-tmux-runtime-destroy-override");
    let _guard = TmuxSocketGuard {
        socket: socket.clone(),
    };
    let session = "herd_tmux_runtime_destroy_override";
    start_tmux_session(&socket, session, "bash --noprofile --norc");

    let set_override = Command::new("tmux")
        .args([
            "-L",
            &socket,
            "set-option",
            "-t",
            session,
            "destroy-unattached",
            "keep-last",
        ])
        .status()
        .expect("set-option override should execute");
    assert!(
        set_override.success(),
        "expected session destroy-unattached override to be set"
    );
    assert!(
        show_session_destroy_unattached(&socket, session).contains("keep-last"),
        "expected precondition destroy-unattached keep-last"
    );

    let adapter = SystemTmuxAdapter::new(Some(socket.clone()));
    adapter.enable_extended_keys_passthrough();

    assert!(
        show_session_destroy_unattached(&socket, session).contains("off"),
        "expected adapter passthrough setup to force destroy-unattached off"
    );
}

#[test]
fn control_mode_sync_clears_session_destroy_unattached_override() {
    let socket = unique_socket("herd-tmux-runtime-control-destroy");
    let _guard = TmuxSocketGuard {
        socket: socket.clone(),
    };
    let session = "herd_tmux_runtime_control_destroy";
    start_tmux_session(&socket, session, "bash --noprofile --norc");

    let set_override = Command::new("tmux")
        .args([
            "-L",
            &socket,
            "set-option",
            "-t",
            session,
            "destroy-unattached",
            "keep-last",
        ])
        .status()
        .expect("set-option override should execute");
    assert!(
        set_override.success(),
        "expected session destroy-unattached override to be set"
    );
    assert!(
        show_session_destroy_unattached(&socket, session).contains("keep-last"),
        "expected precondition destroy-unattached keep-last"
    );

    let mut multiplexer = ControlModeMultiplexer::new(Some(socket.clone()));
    let names = HashSet::from([session.to_string()]);
    multiplexer
        .sync_sessions(&names)
        .expect("control sync should succeed");

    assert!(
        show_session_destroy_unattached(&socket, session).contains("off"),
        "expected control sync to force destroy-unattached off for attached sessions"
    );
}

#[test]
fn control_mode_multiplexer_syncs_and_reconciles_session_sets() {
    let socket = unique_socket("herd-tmux-runtime-control");
    let _guard = TmuxSocketGuard {
        socket: socket.clone(),
    };
    let session_one = "herd_tmux_runtime_control_1";
    let session_two = "herd_tmux_runtime_control_2";
    start_tmux_session(&socket, session_one, "bash --noprofile --norc");
    start_tmux_session(&socket, session_two, "bash --noprofile --norc");

    let mut multiplexer = ControlModeMultiplexer::new(Some(socket.clone()));
    let names = HashSet::from([session_one.to_string()]);
    multiplexer
        .sync_sessions(&names)
        .expect("initial control sync should succeed");
    let _ = multiplexer.drain_events();

    let names = HashSet::from([session_one.to_string(), session_two.to_string()]);
    multiplexer
        .sync_sessions(&names)
        .expect("expanding session set should succeed");
    let _ = multiplexer.drain_events();

    let names = HashSet::from([session_two.to_string()]);
    multiplexer
        .sync_sessions(&names)
        .expect("shrinking session set should succeed");
    let _ = multiplexer.drain_events();
}

#[test]
fn herd_tui_input_interacts_with_multiple_shells_without_tmux_server_drop() {
    let socket = unique_socket("herd-tmux-runtime-live-input");
    let _guard = TmuxSocketGuard {
        socket: socket.clone(),
    };
    let worker_sessions = ["aa_live", "bb_live", "cc_live"];
    for session in worker_sessions {
        start_tmux_session(&socket, session, "env -u TMOUT bash --noprofile --norc -i");
        set_session_destroy_unattached_off(&socket, session);
    }
    set_server_keepalive_options(&socket);

    let config_dir = unique_temp_dir("herd-tmux-runtime-live-input");
    let config_path = config_dir.join("settings.json");
    let state_path = config_dir.join("state.json");
    let herd_bin = herd_binary_path();

    let aa_pane = first_pane_id(&socket, "aa_live");
    let bb_pane = first_pane_id(&socket, "bb_live");
    let cc_pane = first_pane_id(&socket, "cc_live");
    let scenarios = [
        (
            "aa_live",
            aa_pane.as_str(),
            "echo HERD_LIVE_AA",
            "HERD_LIVE_AA",
        ),
        (
            "bb_live",
            bb_pane.as_str(),
            "echo HERD_LIVE_BB",
            "HERD_LIVE_BB",
        ),
        (
            "cc_live",
            cc_pane.as_str(),
            "echo HERD_LIVE_CC",
            "HERD_LIVE_CC",
        ),
    ];
    for (index, (session_name, pane_id, command, marker)) in scenarios.iter().enumerate() {
        start_herd_ui_session(
            &socket,
            &herd_bin,
            config_path.as_path(),
            state_path.as_path(),
        );
        wait_for_herd_ui_online(&socket);
        thread::sleep(Duration::from_secs(2));

        match index {
            0 => assert_server_online_with_sessions(
                &socket,
                &["aa_live", "bb_live", "cc_live", "herd_ui"],
            ),
            1 => assert_server_online_with_sessions(&socket, &["bb_live", "cc_live", "herd_ui"]),
            _ => assert_server_online_with_sessions(&socket, &["cc_live", "herd_ui"]),
        }

        focus_first_session(&socket, "herd_ui:0");
        let _ = send_command_via_herd_ui(&socket, "herd_ui:0", command, 0);
        wait_for_pane_marker(&socket, "herd_ui:0", pane_id, marker, session_name);
        assert_server_online_with_sessions(&socket, &[*session_name, "herd_ui"]);

        kill_session_and_wait_absent(&socket, "herd_ui");
        if index < scenarios.len() - 1 {
            kill_session_and_wait_absent(&socket, session_name);
        }
    }

    thread::sleep(Duration::from_secs(2));
    assert_server_online_with_sessions(&socket, &["cc_live"]);

    let _ = fs::remove_file(config_path);
    let _ = fs::remove_file(state_path);
    let _ = fs::remove_dir_all(config_dir);
}

#[test]
fn herd_tui_input_ls_updates_target_shell_output() {
    let socket = unique_socket("herd-tmux-runtime-ls-output");
    let _guard = TmuxSocketGuard {
        socket: socket.clone(),
    };
    let worker_session = "ls_live";
    start_tmux_session(
        &socket,
        worker_session,
        "env -u TMOUT bash --noprofile --norc -i",
    );
    set_session_destroy_unattached_off(&socket, worker_session);
    set_server_keepalive_options(&socket);

    let fixture_dir = unique_temp_dir("herd-ls-fixture");
    fs::write(fixture_dir.join("alpha.txt"), "a").expect("alpha fixture should write");
    fs::write(fixture_dir.join("beta.log"), "b").expect("beta fixture should write");

    let worker_pane = first_pane_id(&socket, worker_session);
    tmux_send_shell_line(
        &socket,
        &worker_pane,
        &format!(
            "cd {}",
            shell_single_quote(&fixture_dir.display().to_string())
        ),
    );
    tmux_send_shell_line(&socket, &worker_pane, "pwd");
    wait_until(Duration::from_secs(4), || {
        pane_contains(
            &socket,
            &worker_pane,
            fixture_dir.to_string_lossy().as_ref(),
        )
    });

    let config_dir = unique_temp_dir("herd-ls-config");
    let config_path = config_dir.join("settings.json");
    let state_path = config_dir.join("state.json");
    let herd_bin = herd_binary_path();

    start_herd_ui_session(
        &socket,
        &herd_bin,
        config_path.as_path(),
        state_path.as_path(),
    );
    wait_for_herd_ui_online(&socket);
    focus_first_session(&socket, "herd_ui:0");
    let _ = send_command_via_herd_ui(&socket, "herd_ui:0", "ls", 0);

    wait_until(Duration::from_secs(6), || {
        let pane = capture_pane_text(&socket, &worker_pane, 200);
        pane.contains("alpha.txt") && pane.contains("beta.log")
    });
    let pane_text = capture_pane_text(&socket, &worker_pane, 220);
    assert!(
        pane_text.contains("alpha.txt") && pane_text.contains("beta.log"),
        "expected ls output in worker pane; got:\n{pane_text}"
    );
    assert_server_online_with_sessions(&socket, &[worker_session, "herd_ui"]);

    kill_session_and_wait_absent(&socket, "herd_ui");

    let _ = fs::remove_file(config_path);
    let _ = fs::remove_file(state_path);
    let _ = fs::remove_dir_all(config_dir);
    let _ = fs::remove_dir_all(fixture_dir);
}

#[test]
fn settings_save_persists_and_reloads_herd_count_in_live_tui() {
    let socket = unique_socket("herd-tmux-runtime-settings-save");
    let _guard = TmuxSocketGuard {
        socket: socket.clone(),
    };
    let worker_session = "settings_live";
    start_tmux_session(
        &socket,
        worker_session,
        "env -u TMOUT bash --noprofile --norc -i",
    );
    set_session_destroy_unattached_off(&socket, worker_session);
    set_server_keepalive_options(&socket);

    let config_dir = unique_temp_dir("herd-settings-save");
    let config_path = config_dir.join("settings.json");
    let state_path = config_dir.join("state.json");
    let herd_bin = herd_binary_path();

    start_herd_ui_session(
        &socket,
        &herd_bin,
        config_path.as_path(),
        state_path.as_path(),
    );
    wait_for_herd_ui_online(&socket);

    open_settings_overlay(&socket, "herd_ui:0");
    tmux_send_key(&socket, "herd_ui:0", "Enter");
    tmux_send_key(&socket, "herd_ui:0", "BSpace");
    tmux_send_literal(&socket, "herd_ui:0", "7");
    tmux_send_key(&socket, "herd_ui:0", "Enter");
    tmux_send_key(&socket, "herd_ui:0", "s");

    wait_until(Duration::from_secs(4), || {
        json_u64_field(&config_path, "herd_count") == Some(7)
    });

    kill_session_and_wait_absent(&socket, "herd_ui");
    start_herd_ui_session(
        &socket,
        &herd_bin,
        config_path.as_path(),
        state_path.as_path(),
    );
    wait_for_herd_ui_online(&socket);
    open_settings_overlay(&socket, "herd_ui:0");

    let pane = capture_pane_text(&socket, "herd_ui:0", 260);
    let herd_count_line = pane
        .lines()
        .find(|line| line.contains("Herd Count"))
        .unwrap_or_default()
        .to_string();
    assert!(
        herd_count_line.contains("7"),
        "expected persisted herd count in settings row; row={herd_count_line:?}\npane:\n{pane}"
    );

    kill_session_and_wait_absent(&socket, "herd_ui");
    let _ = fs::remove_file(config_path);
    let _ = fs::remove_file(state_path);
    let _ = fs::remove_dir_all(config_dir);
}

#[test]
fn settings_model_refresh_populates_dropdown_and_selected_model_is_saved() {
    let socket = unique_socket("herd-tmux-runtime-settings-models");
    let _guard = TmuxSocketGuard {
        socket: socket.clone(),
    };
    let worker_session = "models_live";
    start_tmux_session(
        &socket,
        worker_session,
        "env -u TMOUT bash --noprofile --norc -i",
    );
    set_session_destroy_unattached_off(&socket, worker_session);
    set_server_keepalive_options(&socket);

    let config_dir = unique_temp_dir("herd-settings-models");
    let config_path = config_dir.join("settings.json");
    let state_path = config_dir.join("state.json");
    let herd_bin = herd_binary_path();

    let mut config = AppConfig::default();
    config.openai_api_key = "sk-test-openai".to_string();
    config
        .save_to_path(&config_path)
        .expect("model test config should persist");

    start_herd_ui_session_with_env(
        &socket,
        &herd_bin,
        config_path.as_path(),
        state_path.as_path(),
        &[(
            "HERD_MODEL_FETCH_FIXTURE",
            "gpt-4.1,gpt-4.1-mini".to_string(),
        )],
    );
    wait_for_herd_ui_online(&socket);
    open_settings_overlay(&socket, "herd_ui:0");
    tmux_send_key(&socket, "herd_ui:0", "r");
    assert!(
        wait_for(Duration::from_secs(6), || {
            capture_pane_text(&socket, "herd_ui:0", 320).contains("Model list updated")
        }),
        "expected model list refresh status in settings pane:\n{}",
        capture_pane_text(&socket, "herd_ui:0", 320)
    );

    tmux_send_key(&socket, "herd_ui:0", "j");
    tmux_send_key(&socket, "herd_ui:0", "j");
    tmux_send_key(&socket, "herd_ui:0", "j");
    tmux_send_key(&socket, "herd_ui:0", "j");
    tmux_send_key(&socket, "herd_ui:0", "Enter");
    assert!(
        wait_for(Duration::from_secs(4), || {
            let pane = capture_pane_text(&socket, "herd_ui:0", 260);
            pane.contains("Model List") && pane.contains("gpt-4.1-mini")
        }),
        "expected model dropdown with fixture models:\n{}",
        capture_pane_text(&socket, "herd_ui:0", 320)
    );

    tmux_send_key(&socket, "herd_ui:0", "j");
    tmux_send_key(&socket, "herd_ui:0", "Enter");
    tmux_send_key(&socket, "herd_ui:0", "s");

    wait_until(Duration::from_secs(4), || {
        json_string_field(&config_path, "llm_model").as_deref() == Some("gpt-4.1-mini")
    });

    kill_session_and_wait_absent(&socket, "herd_ui");
    let _ = fs::remove_file(config_path);
    let _ = fs::remove_file(state_path);
    let _ = fs::remove_dir_all(config_dir);
}

#[test]
fn codex_app_server_source_is_rendered_in_live_tui_details() {
    let Some(real_codex) = resolve_codex_binary() else {
        eprintln!("skipping codex source integration: codex binary unavailable");
        return;
    };

    let socket = unique_socket("herd-tmux-runtime-codex-source");
    let _guard = TmuxSocketGuard {
        socket: socket.clone(),
    };
    let worker_session = "codex_live";
    start_tmux_session(
        &socket,
        worker_session,
        &format!(
            "{} app-server --listen stdio://",
            shell_single_quote(&real_codex)
        ),
    );
    set_session_destroy_unattached_off(&socket, worker_session);
    set_server_keepalive_options(&socket);

    let codex_stub_dir = unique_temp_dir("herd-codex-appserver-stub");
    write_fake_codex_app_server_bin(codex_stub_dir.as_path(), "inProgress");
    let path_env = prepend_to_path(codex_stub_dir.as_path());

    let config_dir = unique_temp_dir("herd-codex-source-config");
    let config_path = config_dir.join("settings.json");
    let state_path = config_dir.join("state.json");
    let herd_bin = herd_binary_path();

    start_herd_ui_session_with_env(
        &socket,
        &herd_bin,
        config_path.as_path(),
        state_path.as_path(),
        &[("PATH", path_env)],
    );
    wait_for_herd_ui_online(&socket);
    focus_first_session(&socket, "herd_ui:0");

    assert!(
        wait_for(Duration::from_secs(10), || {
            let pane = capture_pane_text(&socket, "herd_ui:0", 280);
            pane.contains("source") && pane.contains("codex app-server")
        }),
        "expected codex app-server source in details pane:\n{}",
        capture_pane_text(&socket, "herd_ui:0", 340)
    );
    let pane = capture_pane_text(&socket, "herd_ui:0", 280);
    assert!(
        pane.contains("source") && pane.contains("codex app-server"),
        "expected codex app-server source in details pane:\n{pane}"
    );

    kill_session_and_wait_absent(&socket, "herd_ui");
    kill_session_and_wait_absent(&socket, worker_session);
    let _ = fs::remove_file(config_path);
    let _ = fs::remove_file(state_path);
    let _ = fs::remove_dir_all(config_dir);
    let _ = fs::remove_dir_all(codex_stub_dir);
}

#[test]
fn rule_engine_dispatches_configured_command_in_live_tui_loop() {
    let socket = unique_socket("herd-tmux-runtime-rule-loop");
    let _guard = TmuxSocketGuard {
        socket: socket.clone(),
    };
    let worker_session = "rule_live";
    start_tmux_session(
        &socket,
        worker_session,
        "env -u TMOUT bash --noprofile --norc -i",
    );
    set_session_destroy_unattached_off(&socket, worker_session);
    set_server_keepalive_options(&socket);

    let worker_pane = first_pane_id(&socket, worker_session);
    tmux_send_shell_line(&socket, &worker_pane, "echo waiting for input");
    tmux_send_shell_line(&socket, &worker_pane, "echo NEED_RULE_DISPATCH");

    let config_dir = unique_temp_dir("herd-rule-loop-config");
    let config_path = config_dir.join("settings.json");
    let state_path = config_dir.join("state.json");
    let herd_bin = herd_binary_path();
    let now = now_unix();

    let mut config = AppConfig::default();
    config.status_track_exact_commands = vec!["bash".to_string(), "tmux".to_string()];
    config.cooldown_secs = 0;
    config.max_nudges = 1;
    config.herd_modes = vec![HerdModeDefinition {
        name: "Balanced".to_string(),
        rule_file: "herd_modes/balanced.json".to_string(),
    }];
    config
        .save_to_path(&config_path)
        .expect("rule loop config should persist");

    let rule_path = config_dir.join("herd_modes").join("balanced.json");
    fs::write(
        &rule_path,
        json!({
            "version": 1,
            "rules": [
                {
                    "id": "dispatch_match",
                    "type": "regex",
                    "enabled": true,
                    "input_scope": "full_buffer",
                    "pattern": "(?s).*NEED_RULE_DISPATCH.*",
                    "command_template": "echo RULE_DISPATCH_OK"
                }
            ]
        })
        .to_string(),
    )
    .expect("rule file should write");

    fs::write(
        &state_path,
        json!({
            "herds": { "0": "Balanced" },
            "sessions": {
                worker_pane.clone(): {
                    "herded": true,
                    "herd_id": 0,
                    "nudge_count": 0,
                    "last_nudge_unix": null,
                    "last_assessment_state": "waiting",
                    "state_entered_unix": now - 600,
                    "last_assessment_unix": now - 600,
                    "last_reasons": ["waiting_marker"]
                }
            }
        })
        .to_string(),
    )
    .expect("rule loop state should write");

    start_herd_ui_session(
        &socket,
        &herd_bin,
        config_path.as_path(),
        state_path.as_path(),
    );
    wait_for_herd_ui_online(&socket);
    focus_first_session(&socket, "herd_ui:0");

    wait_until(Duration::from_secs(8), || {
        pane_contains(&socket, &worker_pane, "RULE_DISPATCH_OK")
    });
    assert!(
        pane_contains(&socket, &worker_pane, "RULE_DISPATCH_OK"),
        "expected rule dispatch output in worker pane:\n{}",
        capture_pane_text(&socket, &worker_pane, 180)
    );

    wait_until(Duration::from_secs(4), || {
        capture_pane_text(&socket, "herd_ui:0", 320).contains("dispatch_ok pane=")
    });
    let ui_pane = capture_pane_text(&socket, "herd_ui:0", 320);
    assert!(
        ui_pane.contains("dispatch_ok pane="),
        "expected herder log dispatch marker in ui pane:\n{ui_pane}"
    );

    kill_session_and_wait_absent(&socket, "herd_ui");
    let _ = fs::remove_file(config_path);
    let _ = fs::remove_file(state_path);
    let _ = fs::remove_dir_all(config_dir);
}

fn start_tmux_session(socket: &str, session: &str, command: &str) {
    let status = Command::new("tmux")
        .args([
            "-L",
            socket,
            "-f",
            "/dev/null",
            "new-session",
            "-d",
            "-s",
            session,
            command,
        ])
        .status()
        .expect("tmux new-session should execute");
    assert!(
        status.success(),
        "expected tmux new-session to succeed for session {session}"
    );
}

fn first_pane_id(socket: &str, session: &str) -> String {
    let output = tmux_output(socket, &["list-panes", "-t", session, "-F", "#{pane_id}"]);
    assert!(
        output.status.success(),
        "expected list-panes to succeed for session {session}, stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
    let pane_id = String::from_utf8_lossy(&output.stdout).trim().to_string();
    assert!(!pane_id.is_empty(), "expected non-empty pane id");
    pane_id
}

fn tmux_output(socket: &str, args: &[&str]) -> Output {
    Command::new("tmux")
        .args(["-L", socket])
        .args(args)
        .output()
        .expect("tmux command should execute")
}

fn unique_socket(prefix: &str) -> String {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should advance")
        .as_millis();
    format!("{prefix}-{suffix}")
}

fn wait_until(timeout: Duration, mut predicate: impl FnMut() -> bool) {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if predicate() {
            return;
        }
        thread::sleep(Duration::from_millis(100));
    }
    assert!(
        predicate(),
        "condition did not become true within {timeout:?}"
    );
}

fn show_session_destroy_unattached(socket: &str, session: &str) -> String {
    let output = tmux_output(
        socket,
        &["show-options", "-t", session, "destroy-unattached"],
    );
    assert!(
        output.status.success(),
        "expected show-options destroy-unattached for session {session}, stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn herd_binary_path() -> String {
    std::env::var("CARGO_BIN_EXE_herd")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "target/debug/herd".to_string())
}

fn unique_temp_dir(prefix: &str) -> std::path::PathBuf {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should advance")
        .as_millis();
    let dir = std::env::temp_dir().join(format!("{prefix}-{suffix}"));
    fs::create_dir_all(&dir).expect("temp test directory should be creatable");
    dir
}

fn set_server_keepalive_options(socket: &str) {
    for args in [
        ["set-option", "-s", "exit-empty", "off"],
        ["set-option", "-s", "exit-unattached", "off"],
        ["set-option", "-g", "destroy-unattached", "off"],
    ] {
        let status = Command::new("tmux")
            .args(["-L", socket])
            .args(args)
            .status()
            .expect("tmux set-option should execute");
        assert!(
            status.success(),
            "expected tmux {:?} to succeed for socket {}",
            args,
            socket
        );
    }
}

fn set_session_destroy_unattached_off(socket: &str, session: &str) {
    let status = Command::new("tmux")
        .args([
            "-L",
            socket,
            "set-option",
            "-t",
            session,
            "destroy-unattached",
            "off",
        ])
        .status()
        .expect("tmux set-option -t should execute");
    assert!(
        status.success(),
        "expected tmux destroy-unattached off for session {}",
        session
    );
}

fn send_command_via_herd_ui(
    socket: &str,
    herd_ui_target: &str,
    command: &str,
    previous_ok_count: usize,
) -> usize {
    tmux_send_key(socket, herd_ui_target, "l");
    tmux_send_key(socket, herd_ui_target, "i");
    wait_until(Duration::from_secs(2), || {
        capture_pane_text(socket, herd_ui_target, 220).contains("send input")
    });

    tmux_send_literal(socket, herd_ui_target, command);

    let submitted = (0..6).any(|_| {
        tmux_submit_input(socket, herd_ui_target);
        wait_for(Duration::from_millis(900), || {
            input_send_ok_count(socket, herd_ui_target) > previous_ok_count
        })
    });
    if !submitted {
        panic!(
            "failed to submit input via herd ui; command={command:?}\npane dump:\n{}",
            capture_pane_text(socket, herd_ui_target, 200)
        );
    }

    tmux_send_key(socket, herd_ui_target, "Esc");
    tmux_send_key(socket, herd_ui_target, "H");
    input_send_ok_count(socket, herd_ui_target)
}

fn focus_first_session(socket: &str, herd_ui_target: &str) {
    tmux_send_key(socket, herd_ui_target, "Esc");
    tmux_send_key(socket, herd_ui_target, "H");
    tmux_send_key(socket, herd_ui_target, "g");
}

fn start_herd_ui_session(
    socket: &str,
    herd_bin: &str,
    config_path: &std::path::Path,
    state_path: &std::path::Path,
) {
    start_herd_ui_session_with_env(socket, herd_bin, config_path, state_path, &[]);
}

fn start_herd_ui_session_with_env(
    socket: &str,
    herd_bin: &str,
    config_path: &std::path::Path,
    state_path: &std::path::Path,
    extra_env: &[(&str, String)],
) {
    let mut command = Command::new("tmux");
    command
        .args([
            "-L",
            socket,
            "new-session",
            "-d",
            "-x",
            "220",
            "-y",
            "60",
            "-s",
            "herd_ui",
            "-n",
            "ui",
        ])
        .arg("env")
        .arg(format!("HERD_CONFIG={}", config_path.display()))
        .arg(format!("HERD_STATE={}", state_path.display()));
    for (key, value) in extra_env {
        command.arg(format!("{key}={value}"));
    }
    let status = command
        .arg(herd_bin)
        .args(["--tmux-socket", socket, "tui"])
        .status()
        .expect("tmux new-session herd_ui should execute");
    assert!(status.success(), "expected herd_ui session to start");
    set_session_destroy_unattached_off(socket, "herd_ui");
}

fn wait_for_herd_ui_online(socket: &str) {
    wait_until(Duration::from_secs(5), || {
        let output = tmux_output(
            socket,
            &["capture-pane", "-t", "herd_ui:0", "-p", "-S", "-120"],
        );
        output.status.success()
            && String::from_utf8_lossy(&output.stdout).contains("server (online)")
    });
}

fn open_settings_overlay(socket: &str, herd_ui_target: &str) {
    tmux_send_key(socket, herd_ui_target, ",");
    wait_until(Duration::from_secs(3), || {
        capture_pane_text(socket, herd_ui_target, 240).contains("Settings")
    });
}

fn tmux_send_key(socket: &str, target: &str, key: &str) {
    let status = Command::new("tmux")
        .args(["-L", socket, "send-keys", "-t", target, key])
        .status()
        .expect("tmux send-keys should execute");
    assert!(
        status.success(),
        "expected tmux send-keys key={} target={}",
        key,
        target
    );
    thread::sleep(Duration::from_millis(80));
}

fn tmux_send_literal(socket: &str, target: &str, text: &str) {
    let status = Command::new("tmux")
        .args(["-L", socket, "send-keys", "-t", target, "-l", text])
        .status()
        .expect("tmux send-keys -l should execute");
    assert!(
        status.success(),
        "expected tmux send-keys literal target={}",
        target
    );
    thread::sleep(Duration::from_millis(80));
}

fn tmux_send_shell_line(socket: &str, target: &str, line: &str) {
    tmux_send_literal(socket, target, line);
    tmux_send_key(socket, target, "Enter");
}

fn tmux_submit_input(socket: &str, target: &str) {
    let status = Command::new("tmux")
        .args(["-L", socket, "send-keys", "-t", target, "-l"])
        // Enter+Shift encoded as CSI-u; Herd maps this to submit in input mode.
        .arg("\u{1b}[13;2u")
        .status()
        .expect("tmux send-keys submit sequence should execute");
    assert!(
        status.success(),
        "expected tmux send-keys submit sequence target={}",
        target
    );
    thread::sleep(Duration::from_millis(120));
}

fn pane_contains(socket: &str, pane_id: &str, needle: &str) -> bool {
    capture_pane_text(socket, pane_id, 120).contains(needle)
}

fn assert_server_online_with_sessions(socket: &str, expected_sessions: &[&str]) {
    let output = tmux_output(socket, &["list-sessions"]);
    assert!(
        output.status.success(),
        "expected tmux server to be online, stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    for session in expected_sessions {
        assert!(
            stdout.contains(&format!("{session}:")),
            "expected session {} in list-sessions output:\n{}",
            session,
            stdout
        );
    }
}

fn capture_pane_text(socket: &str, target: &str, lines: usize) -> String {
    let start = format!("-{lines}");
    let output = tmux_output(socket, &["capture-pane", "-t", target, "-p", "-S", &start]);
    if !output.status.success() {
        return String::new();
    }
    String::from_utf8_lossy(&output.stdout).to_string()
}

fn input_send_ok_count(socket: &str, herd_ui_target: &str) -> usize {
    capture_pane_text(socket, herd_ui_target, 240)
        .matches("input_send ok pane=")
        .count()
}

fn wait_for(timeout: Duration, mut predicate: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if predicate() {
            return true;
        }
        thread::sleep(Duration::from_millis(100));
    }
    predicate()
}

fn wait_for_pane_marker(
    socket: &str,
    herd_ui_target: &str,
    pane_id: &str,
    marker: &str,
    session_name: &str,
) {
    if wait_for(Duration::from_secs(6), || {
        pane_contains(socket, pane_id, marker)
    }) {
        return;
    }
    panic!(
        "marker {} did not reach session {} pane {}.\nherd ui:\n{}\nworker pane:\n{}",
        marker,
        session_name,
        pane_id,
        capture_pane_text(socket, herd_ui_target, 260),
        capture_pane_text(socket, pane_id, 160)
    );
}

fn json_u64_field(path: &Path, field: &str) -> Option<u64> {
    let raw = fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    value.get(field).and_then(serde_json::Value::as_u64)
}

fn json_string_field(path: &Path, field: &str) -> Option<String> {
    let raw = fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    value
        .get(field)
        .and_then(serde_json::Value::as_str)
        .map(ToString::to_string)
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should advance")
        .as_secs() as i64
}

fn kill_session_and_wait_absent(socket: &str, session_name: &str) {
    let status = Command::new("tmux")
        .args(["-L", socket, "kill-session", "-t", session_name])
        .status()
        .expect("tmux kill-session should execute");
    assert!(
        status.success(),
        "expected kill-session to succeed for {}",
        session_name
    );
    wait_until(Duration::from_secs(4), || {
        let output = tmux_output(socket, &["list-sessions"]);
        output.status.success()
            && !String::from_utf8_lossy(&output.stdout).contains(&format!("{session_name}:"))
    });
}
