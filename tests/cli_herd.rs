use assert_cmd::cargo::cargo_bin_cmd;
use predicates::prelude::*;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn herd_cli_mark_unmark_and_list_persist_state() {
    let state = temp_file("herd_cli_state");

    let mut mark = cargo_bin_cmd!("herd");
    mark.args([
        "--state",
        state.to_str().expect("state path should be valid utf8"),
        "herd",
        "mark",
        "%9",
    ]);
    mark.assert()
        .success()
        .stdout(predicate::str::contains("marked %9 as herded"));

    let mut list = cargo_bin_cmd!("herd");
    list.args([
        "--state",
        state.to_str().expect("state path should be valid utf8"),
        "herd",
        "list",
    ]);
    list.assert()
        .success()
        .stdout(predicate::str::contains("%9\ttrue\t0\t-"));

    let mut unmark = cargo_bin_cmd!("herd");
    unmark.args([
        "--state",
        state.to_str().expect("state path should be valid utf8"),
        "herd",
        "unmark",
        "%9",
    ]);
    unmark
        .assert()
        .success()
        .stdout(predicate::str::contains("unmarked %9 as herded"));

    let mut list_again = cargo_bin_cmd!("herd");
    list_again.args([
        "--state",
        state.to_str().expect("state path should be valid utf8"),
        "herd",
        "list",
    ]);
    list_again
        .assert()
        .success()
        .stdout(predicate::str::contains("%9").not());

    let _ = fs::remove_file(state);
}

fn temp_file(prefix: &str) -> PathBuf {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be monotonic enough")
        .as_millis();
    std::env::temp_dir().join(format!("{prefix}_{suffix}.json"))
}
