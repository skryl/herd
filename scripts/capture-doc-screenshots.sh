#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"

manifest_path="${HERD_MANIFEST_PATH:-$repo_root/Cargo.toml}"
raw_dir="${HERD_DOC_SCREENSHOT_DIR:-$repo_root/docs/screenshots/raw}"
output_dir="${HERD_DOC_SCREENSHOT_OUT:-$repo_root/docs/screenshots}"
run_snapshot_tests=1

while [ "$#" -gt 0 ]; do
  case "$1" in
    --skip-tests)
      run_snapshot_tests=0
      shift
      ;;
    *)
      echo "error: unsupported arg '$1'" >&2
      exit 1
      ;;
  esac
done

mkdir -p "$raw_dir"
mkdir -p "$output_dir"

if [ "$run_snapshot_tests" -eq 1 ]; then
  HERD_DOC_SCREENSHOT_DIR="$raw_dir" \
    cargo test --manifest-path "$manifest_path" --test docs_screenshots -- --ignored
fi

python3 "$repo_root/scripts/render-doc-screenshots.py" \
  --input "$raw_dir" \
  --output "$output_dir"
