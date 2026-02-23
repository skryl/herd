use assert_cmd::cargo::cargo_bin_cmd;
use predicates::prelude::*;

#[test]
fn root_help_lists_expected_subcommands() {
    let mut cmd = cargo_bin_cmd!("herd");
    cmd.arg("--help");

    cmd.assert().success().stdout(
        predicate::str::contains("tui")
            .and(predicate::str::contains("sessions"))
            .and(predicate::str::contains("herd")),
    );
}

#[test]
fn invalid_subcommand_returns_non_zero() {
    let mut cmd = cargo_bin_cmd!("herd");
    cmd.arg("not-a-real-subcommand");

    cmd.assert()
        .failure()
        .stderr(predicate::str::contains("error").or(predicate::str::contains("unrecognized")));
}
