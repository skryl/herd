#!/usr/bin/env bash
set -euo pipefail

socket="${1:-herd}"
shift || true

if ! command -v tmux >/dev/null 2>&1; then
  echo "error: tmux is not installed in this container" >&2
  exit 1
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "error: cargo is not installed in this container" >&2
  exit 1
fi

if ! command -v codex >/dev/null 2>&1; then
  echo "error: codex is not installed in this container" >&2
  exit 1
fi

resolve_codex_binary() {
  local npm_root candidate
  if command -v npm >/dev/null 2>&1; then
    npm_root="$(npm root -g 2>/dev/null || true)"
    if [ -n "$npm_root" ]; then
      candidate="$(find "$npm_root/@openai/codex/node_modules" -type f -path '*/vendor/*/codex/codex' 2>/dev/null | head -n 1 || true)"
      if [ -n "$candidate" ]; then
        printf '%s\n' "$candidate"
        return 0
      fi
    fi
  fi
  command -v codex
}

codex_binary="$(resolve_codex_binary)"
if [ ! -x "$codex_binary" ]; then
  echo "error: resolved codex binary is not executable: $codex_binary" >&2
  exit 1
fi
export HERD_CODEX_BIN="$codex_binary"

runtime_dir="${HERD_RUNTIME_DIR:-/workspace/tmp}"
mkdir -p "$runtime_dir"
export TMPDIR="$runtime_dir"
export TMP="$runtime_dir"
export TEMP="$runtime_dir"
cd "$runtime_dir"

tmux -L "$socket" kill-server >/dev/null 2>&1 || true

shell_cmd='env -u TMOUT bash --noprofile --norc -i'

send_shell_line() {
  local target="$1"
  local line="$2"
  tmux -L "$socket" send-keys -t "$target" -l "$line"
  tmux -L "$socket" send-keys -t "$target" Enter
}

start_codex_in_pane() {
  local target="$1"
  local prompt="$2"
  local cmd
  printf -v cmd '"%s" --no-alt-screen %q' "$HERD_CODEX_BIN" "$prompt"
  send_shell_line "$target" "echo [${target}] starting codex interactive session at \$(date -u +%H:%M:%S)"
  send_shell_line "$target" "$cmd"
}

tmux -L "$socket" new-session -d -s alpha -n plan "$shell_cmd"
tmux -L "$socket" set-option -s exit-empty off
tmux -L "$socket" set-option -s exit-unattached off
tmux -L "$socket" set-option -g destroy-unattached off
tmux -L "$socket" set-option -t alpha destroy-unattached off
tmux -L "$socket" new-window -t alpha -n build "$shell_cmd"
tmux -L "$socket" new-window -t alpha -n shell "$shell_cmd"

tmux -L "$socket" new-session -d -s beta -n review "$shell_cmd"
tmux -L "$socket" set-option -t beta destroy-unattached off
tmux -L "$socket" new-window -t beta -n test "$shell_cmd"
tmux -L "$socket" new-window -t beta -n logs "$shell_cmd"

tmux -L "$socket" new-session -d -s gamma -n exec "$shell_cmd"
tmux -L "$socket" set-option -t gamma destroy-unattached off
tmux -L "$socket" new-window -t gamma -n patch "$shell_cmd"
tmux -L "$socket" new-window -t gamma -n monitor "$shell_cmd"

start_codex_in_pane "alpha:build" "You are seed session alpha-build. Reply with READY and then wait for further instructions."
start_codex_in_pane "beta:review" "You are seed session beta-review. Reply with READY and then wait for further instructions."
start_codex_in_pane "gamma:patch" "You are seed session gamma-patch. Reply with READY and then wait for further instructions."

# Codex may ask for one-time workspace trust confirmation; accept it so seeded
# sessions immediately begin and produce real thread state.
sleep 2
tmux -L "$socket" send-keys -t alpha:build Enter
tmux -L "$socket" send-keys -t beta:review Enter
tmux -L "$socket" send-keys -t gamma:patch Enter

echo "Seeded tmux socket: $socket"
tmux -L "$socket" list-windows -a -F '#{session_name}:#{window_index} #{window_name} #{pane_current_command}'

if [ "$#" -eq 0 ]; then
  set -- tui
fi

exec cargo run --manifest-path /workspace/Cargo.toml -- --tmux-socket "$socket" "$@"
