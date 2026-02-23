#!/usr/bin/env bash
set -euo pipefail

if ! command -v tmux >/dev/null 2>&1; then
  echo "error: tmux is not installed in this environment" >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
manifest_path="${HERD_MANIFEST_PATH:-$repo_root/Cargo.toml}"
if [ ! -f "$manifest_path" ] && [ -f "/workspace/Cargo.toml" ]; then
  manifest_path="/workspace/Cargo.toml"
fi

runtime_dir="${HERD_RUNTIME_DIR:-$repo_root/tmp}"
mkdir -p "$runtime_dir"
export TMPDIR="$runtime_dir"
export TMP="$runtime_dir"
export TEMP="$runtime_dir"
cd "$runtime_dir"

tier="${HERD_TEST_TIER:-full}"
declare -a cargo_args=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --tier)
      if [ "$#" -lt 2 ]; then
        echo "error: --tier requires a value (fast|full)" >&2
        exit 1
      fi
      tier="$2"
      shift 2
      ;;
    --tier=*)
      tier="${1#--tier=}"
      shift
      ;;
    *)
      cargo_args+=("$1")
      shift
      ;;
  esac
done

if [ "${#cargo_args[@]}" -gt 0 ]; then
  exec cargo test --manifest-path "$manifest_path" "${cargo_args[@]}"
fi

if [ "$tier" = "full" ]; then
  exec cargo test --manifest-path "$manifest_path" --tests
fi

if [ "$tier" = "fast" ]; then
  declare -a fast_targets=(
    "cli_root"
    "contracts_core"
    "tmux_discovery"
    "agent_classifier"
    "cli_sessions"
    "tui_app"
    "herd_monitor"
    "config_settings_resilience"
    "cli_herd"
    "integration_fixtures_runtime"
  )
  for target in "${fast_targets[@]}"; do
    echo "running integration target: $target"
    cargo test --manifest-path "$manifest_path" --test "$target"
  done
  exit 0
fi

echo "error: unsupported tier '$tier' (expected fast or full)" >&2
exit 1
