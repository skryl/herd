#[path = "helpers/codex_stub.rs"]
mod codex_stub;

use assert_cmd::cargo::cargo_bin_cmd;
use codex_stub::{
    prepend_to_path, resolve_codex_binary, shell_single_quote, temp_dir,
    write_fake_codex_app_server_bin,
};
use predicates::prelude::*;
use std::fs;
use std::process::Command;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use herd::config::AppConfig;

#[test]
fn sessions_command_prints_status_summary_and_is_stable_across_refreshes() {
    let socket = format!("herd-cli-sessions-{}", unique_suffix());
    let target = "cli_sessions_status_test";

    let setup_status = Command::new("tmux")
        .args([
            "-L",
            &socket,
            "-f",
            "/dev/null",
            "new-session",
            "-d",
            "-s",
            target,
        ])
        .status()
        .expect("tmux should launch");
    assert!(setup_status.success(), "expected tmux setup to succeed");

    let send_status = Command::new("tmux")
        .args([
            "-L",
            &socket,
            "send-keys",
            "-t",
            target,
            "echo Finished successfully",
            "C-m",
        ])
        .status()
        .expect("tmux send-keys should launch");
    assert!(send_status.success(), "expected send-keys to succeed");
    thread::sleep(Duration::from_millis(150));

    let mut first = cargo_bin_cmd!("herd");
    first.args(["sessions"]);
    first.env("HERD_TMUX_SOCKET", &socket);
    first.assert().success().stdout(
        predicate::str::contains(format!("session {target}"))
            .and(predicate::str::contains("window 0:"))
            .and(predicate::str::contains("pane 0 "))
            .and(predicate::str::contains("run="))
            .and(predicate::str::contains("status=").not()),
    );

    let mut second = cargo_bin_cmd!("herd");
    second.args(["sessions"]);
    second.env("HERD_TMUX_SOCKET", &socket);
    second
        .assert()
        .success()
        .stdout(predicate::str::contains(format!("session {target}")));

    let _ = Command::new("tmux")
        .args(["-L", &socket, "kill-server"])
        .status();
}

#[test]
fn sessions_command_reports_waiting_status_for_tracked_shell_command() {
    let socket = format!("herd-cli-sessions-tracked-{}", unique_suffix());
    let target = "cli_sessions_tracked_waiting";
    let config_dir = temp_dir("herd-cli-sessions-tracked");
    let config_path = config_dir.join("settings.json");

    let mut config = AppConfig::default();
    config.status_track_exact_commands = vec!["bash".to_string()];
    config
        .save_to_path(&config_path)
        .expect("tracked sessions config should save");

    let setup_status = Command::new("tmux")
        .args([
            "-L",
            &socket,
            "-f",
            "/dev/null",
            "new-session",
            "-d",
            "-s",
            target,
            "bash --noprofile --norc -i",
        ])
        .status()
        .expect("tmux should launch");
    assert!(setup_status.success(), "expected tmux setup to succeed");

    let send_status = Command::new("tmux")
        .args([
            "-L",
            &socket,
            "send-keys",
            "-t",
            target,
            "echo waiting for input",
            "C-m",
        ])
        .status()
        .expect("tmux send-keys should launch");
    assert!(send_status.success(), "expected send-keys to succeed");
    thread::sleep(Duration::from_millis(200));

    let mut cmd = cargo_bin_cmd!("herd");
    cmd.args(["sessions"]);
    cmd.env("HERD_TMUX_SOCKET", &socket);
    cmd.env("HERD_CONFIG", config_path.to_string_lossy().to_string());
    cmd.assert().success().stdout(
        predicate::str::contains(format!("session {target}"))
            .and(predicate::str::contains("run=bash"))
            .and(predicate::str::contains("status=waiting")),
    );

    let _ = Command::new("tmux")
        .args(["-L", &socket, "kill-server"])
        .status();
    let _ = fs::remove_dir_all(config_dir);
}

#[test]
fn sessions_command_uses_codex_app_server_state_for_codex_panes() {
    let Some(real_codex) = resolve_codex_binary() else {
        eprintln!("skipping codex sessions integration: codex binary unavailable");
        return;
    };

    let socket = format!("herd-cli-sessions-codex-{}", unique_suffix());
    let target = "cli_sessions_codex";
    let codex_stub_dir = temp_dir("herd-cli-codex-stub");
    write_fake_codex_app_server_bin(codex_stub_dir.as_path(), "failed");
    let path_env = prepend_to_path(codex_stub_dir.as_path());

    let setup_status = Command::new("tmux")
        .args([
            "-L",
            &socket,
            "-f",
            "/dev/null",
            "new-session",
            "-d",
            "-s",
            target,
            &format!(
                "{} app-server --listen stdio://",
                shell_single_quote(&real_codex)
            ),
        ])
        .status()
        .expect("tmux should launch");
    assert!(setup_status.success(), "expected tmux setup to succeed");

    thread::sleep(Duration::from_millis(250));
    let mut cmd = cargo_bin_cmd!("herd");
    cmd.args(["sessions"]);
    cmd.env("HERD_TMUX_SOCKET", &socket);
    cmd.env("PATH", path_env);
    cmd.assert().success().stdout(
        predicate::str::contains(format!("session {target}"))
            .and(predicate::str::contains("run=codex"))
            .and(predicate::str::contains("status=stalled")),
    );

    let _ = Command::new("tmux")
        .args(["-L", &socket, "kill-server"])
        .status();
    let _ = fs::remove_dir_all(codex_stub_dir);
}

fn unique_suffix() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be monotonic enough")
        .as_millis()
}
