use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use herd::tmux::{SystemTmuxAdapter, TmuxAdapter, parse_list_panes_output};

#[test]
fn parse_list_panes_output_maps_tmux_fields_into_session_refs() {
    let fixture = "\
$1\tagent-a\t@4\t0\teditor\t%10\t0\t/Users/demo/project\tbash\t0\t1700000000
$2\tagent-b\t@8\t2\tlogs\t%11\t1\t/tmp\tzsh\t1\t1690000000";

    let parsed = parse_list_panes_output(fixture).expect("fixture should parse");

    assert_eq!(parsed.len(), 2);
    assert_eq!(parsed[0].session_name, "agent-a");
    assert_eq!(parsed[0].window_id, "@4");
    assert_eq!(parsed[0].window_index, 0);
    assert_eq!(parsed[0].window_name, "editor");
    assert_eq!(parsed[0].pane_id, "%10");
    assert_eq!(parsed[0].pane_index, 0);
    assert_eq!(parsed[0].pane_current_path, "/Users/demo/project");
    assert_eq!(parsed[0].pane_current_command, "bash");
    assert!(!parsed[0].pane_dead);
    assert_eq!(parsed[0].pane_last_activity_unix, 1_700_000_000);
    assert!(parsed[1].pane_dead);
}

#[test]
fn list_sessions_discovers_sessions_from_isolated_tmux_socket() {
    let socket = format!("herd-tmux-discovery-{}", unique_suffix());
    let target = "herd_tmux_discovery_test";

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

    let adapter = SystemTmuxAdapter::new(Some(socket.clone()));
    let sessions = adapter
        .list_sessions()
        .expect("list_sessions should work against isolated socket");

    let _ = Command::new("tmux")
        .args(["-L", &socket, "kill-server"])
        .status();

    assert!(
        sessions
            .iter()
            .any(|s| s.session_name == target && s.window_index >= 0),
        "expected discovered session named {target}"
    );
}

#[test]
fn capture_pane_joins_soft_wrapped_tmux_lines_for_local_reflow() {
    let socket = format!("herd-tmux-wrap-{}", unique_suffix());
    let target = "herd_tmux_wrap_test";
    let marker = "HERD_WRAP_MARKER_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";

    let setup_status = Command::new("tmux")
        .args([
            "-L",
            &socket,
            "-f",
            "/dev/null",
            "new-session",
            "-d",
            "-x",
            "20",
            "-y",
            "8",
            "-s",
            target,
        ])
        .status()
        .expect("tmux should launch");
    assert!(setup_status.success(), "expected tmux setup to succeed");

    let pane_id = Command::new("tmux")
        .args([
            "-L",
            &socket,
            "list-panes",
            "-t",
            target,
            "-F",
            "#{pane_id}",
        ])
        .output()
        .expect("list-panes should succeed");
    assert!(pane_id.status.success(), "expected pane lookup to succeed");
    let pane_id = String::from_utf8_lossy(&pane_id.stdout).trim().to_string();
    assert!(!pane_id.is_empty(), "expected non-empty pane id");

    let print_status = Command::new("tmux")
        .args([
            "-L",
            &socket,
            "send-keys",
            "-t",
            &pane_id,
            &format!("printf '%s\\n' '{marker}'"),
            "Enter",
        ])
        .status()
        .expect("send-keys should succeed");
    assert!(print_status.success(), "expected send-keys to succeed");
    std::thread::sleep(std::time::Duration::from_millis(200));

    let adapter = SystemTmuxAdapter::new(Some(socket.clone()));
    let snapshot = adapter
        .capture_pane(&pane_id, 40)
        .expect("capture_pane should succeed");

    let _ = Command::new("tmux")
        .args(["-L", &socket, "kill-server"])
        .status();

    assert!(
        snapshot.content.contains(marker),
        "expected capture to include unwrapped marker, got:\n{}",
        snapshot.content
    );
}

fn unique_suffix() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be monotonic enough")
        .as_millis()
}
