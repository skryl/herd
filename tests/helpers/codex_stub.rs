#![allow(dead_code)]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn temp_dir(prefix: &str) -> PathBuf {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be monotonic enough")
        .as_millis();
    let dir = std::env::temp_dir().join(format!("{prefix}-{suffix}"));
    fs::create_dir_all(&dir).expect("temp directory should be creatable");
    dir
}

pub fn prepend_to_path(dir: &Path) -> String {
    let existing = std::env::var("PATH").unwrap_or_default();
    format!("{}:{existing}", dir.display())
}

pub fn resolve_codex_binary() -> Option<String> {
    if let Ok(path) = std::env::var("HERD_CODEX_BIN")
        && !path.trim().is_empty()
    {
        return Some(path);
    }
    let output = Command::new("which").arg("codex").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!path.is_empty()).then_some(path)
}

pub fn shell_single_quote(raw: &str) -> String {
    format!("'{}'", raw.replace('\'', "'\"'\"'"))
}

pub fn write_fake_codex_app_server_bin(dir: &Path, turn_status: &str) {
    let script_path = dir.join("codex");
    let script = format!(
        r#"#!/usr/bin/env bash
set -euo pipefail

if [[ "${{1:-}}" != "app-server" ]]; then
  echo "mock codex only supports app-server mode" >&2
  exit 1
fi

while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  id="$(printf '%s\n' "$line" | sed -n 's/.*"id":[[:space:]]*\([0-9][0-9]*\).*/\1/p')"
  method="$(printf '%s\n' "$line" | sed -n 's/.*"method":[[:space:]]*"\([^"]*\)".*/\1/p')"
  [[ -z "$id" ]] && continue

  case "$method" in
    initialize)
      printf '{{"jsonrpc":"2.0","id":%s,"result":{{"capabilities":{{}}}}}}\n' "$id"
      ;;
    thread/list)
      printf '{{"jsonrpc":"2.0","id":%s,"result":{{"data":[{{"id":"thread-herd","updatedAt":2000000000}}]}}}}\n' "$id"
      ;;
    thread/read)
      printf '{{"jsonrpc":"2.0","id":%s,"result":{{"thread":{{"id":"thread-herd","updatedAt":2000000000,"turns":[{{"status":"{turn_status}"}}]}}}}}}\n' "$id"
      ;;
    *)
      printf '{{"jsonrpc":"2.0","id":%s,"result":{{}}}}\n' "$id"
      ;;
  esac
done
"#
    );
    fs::write(&script_path, script).expect("codex app-server stub script should write");
    let chmod = Command::new("chmod")
        .args(["+x", script_path.to_string_lossy().as_ref()])
        .status()
        .expect("chmod should execute for codex stub");
    assert!(chmod.success(), "codex stub chmod should succeed");
}
