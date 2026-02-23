# herd

`herd` is a Rust CLI/TUI for monitoring and steering Claude Code/Codex agent sessions running in tmux.

## Features

- Split-pane TUI (`ratatui`) with:
- Left pane: hierarchical tmux tree grouped by `server(status) -> session -> window -> pane`, with real tmux names and indexes.
- Left pane rows show status only (`status=<...>`), with `n/a` for non-agent windows.
- Bottom half of the left pane shows selected-session details (`process`, `agent`, `status`, `herd`, etc).
- Status is computed only when the pane process is `claude*`, `codex*`, or `tmux`.
- `claude`/`codex` panes are visually highlighted in the left list.
- Right pane top: selected session content.
- Right pane bottom: always-visible Herder Log (verbose rule-engine/runtime events).
- Herder Log entries are prefixed as `[herd][timestamp]` and tinted by herd color.
- Content view defaults to tail-follow; manual scroll is remembered per pane until you scroll back to end.
- Vim navigation: `j/k`, `g/G`, `h/l`, `enter`, `q`.
- Herd mode:
- Mark sessions as herded.
- Process status uses a stateful assessment (`running`, `waiting`, `waiting_long`, `stalled`, `finished`) with evidence and confidence.
- For `codex*` panes, Herd attempts Codex app-server thread/turn status enrichment and falls back to tmux heuristics when unavailable.
- Evaluate ordered JSON rules (regex + LLM) per herd mode and dispatch rendered commands via `tmux send-keys` on first match.
- Rule evaluation is trigger-gated to conservative herd-eligible states (`stalled` or long `waiting` past grace) plus cooldown/max-nudge limits.
- Rule command templates support placeholders like `{command}` and named variables.
- Rule input scope is configurable per rule: `full_buffer` or `visible_window`.
- Cooldown and max-nudge safety guards.
- Persistence:
- Settings persisted in `~/.config/herd/settings.json`.
- Herd state persisted in `~/.config/herd/state.json`.
- Herd mode rule files persisted in `~/.config/herd/herd_modes/*.json`.

## Build

```bash
cargo build
```

## Docker Integration Tests

Run integration tests in a reproducible container with tmux and codex installed:

```bash
./scripts/run-docker-integration-tests.sh
```

Run the fast PR-style integration tier:

```bash
./scripts/run-docker-integration-tests.sh --tier fast
```

The script auto-falls back to a temporary Docker config if your local credential helper is unavailable.
If tests fail, that reflects project test status; the container harness is still usable.
Runtime artifacts and crash dumps are directed to `./tmp` by default.

Pass through custom cargo test arguments:

```bash
./scripts/run-docker-integration-tests.sh --test tmux_discovery -- --nocapture
```

## Docker Runtime

Run `cargo run` inside the Docker container against a seeded tmux server (3 sessions, 3 windows each, including real interactive `codex` panes):

```bash
./scripts/run-herd.sh
```

This run bind-mounts your host `~/.config/herd` and `~/.codex` into the container, so Herd settings/state and Codex auth/session state are available in-container.
If you rely on API-key auth, set `OPENAI_API_KEY` (or `ANTHROPIC_API_KEY`) in your host shell before running it.
Runtime artifacts and crash dumps from tmux/cargo are written under `./tmp` by default.

Run a non-TUI command inside that same seeded environment:

```bash
./scripts/run-herd.sh sessions
```

Use a custom tmux socket name:

```bash
HERD_DOCKER_TMUX_SOCKET=herd_socket ./scripts/run-herd.sh
```

Use a different host config directory (optional):

```bash
HERD_HOST_CONFIG_DIR=/tmp/herd-config ./scripts/run-herd.sh sessions
```

Use a different host Codex state directory (optional):

```bash
HERD_HOST_CODEX_DIR=/tmp/codex-state ./scripts/run-herd.sh sessions
```

Use a different runtime artifact directory (optional):

```bash
HERD_HOST_RUNTIME_DIR=/tmp/herd-runtime ./scripts/run-herd.sh sessions
```

`scripts/run-herd.sh` is the host-facing Docker wrapper. It invokes the container-only entrypoint `scripts/run-herd-container-entrypoint.sh` inside the container.

## Commands

```bash
# open TUI
herd tui

# list sessions and derived statuses (hierarchical by session/window)
herd sessions

# herd management
herd herd list
herd herd mark %1
herd herd unmark %1
```

Global flags:

- `--tmux-socket <name>`: tmux socket name (same as `tmux -L <name>`).
- `--config <path>`: explicit config path.
- `--state <path>`: explicit state file path.

Equivalent env vars:

- `HERD_TMUX_SOCKET`
- `HERD_CONFIG`
- `HERD_STATE`

## Keybindings

- `H` / `J` / `K` / `L`: move pane focus left/down/up/right (`sessions -> herds -> details -> content -> herder_log` on down)
- `h` / `l`: focus sessions/content panes
- sessions pane: `j` / `k` move selection, `g` / `G` first/last, `0-9` assign herd, `-` clear herd
- herds pane: `j` / `k` move, `g` / `G` first/last, `e` cycle herd mode
- details pane: `enter`/`t` toggle herd, `y` herd on, `n` herd off, `0-9` assign herd, `-` clear herd
- content pane (command mode): `i` enter input mode, `j` / `k` scroll, `u` / `d` page up/down, `g` / `G` top/bottom
- content pane (input mode): typing stays local in an `unsent>` draft footer, `Enter` inserts a newline, `Shift+Enter` sends to tmux (`Ctrl+S` fallback), `Esc` returns to command mode
- herder log pane: `j` / `k` scroll, `u` / `d` page up/down, `g` / `G` top/bottom, `0-9` herd filter, `a`/`-` clear filter (tail-follow resumes at bottom)
- `,`: open Settings overlay (edit herd count, provider keys, provider/model, and herd modes)
- Settings model field: `Enter` opens model dropdown (if provider key is available), and custom model text input is also supported
- Settings herd modes: select/add/remove modes, rename mode, and edit JSON rule files (`Enter` on `Edit Rules`, `Ctrl+S` save)
- `q`: quit

## Settings

Default settings path:

- `$HOME/.config/herd/settings.json` (created on first boot if missing)
- Herd mode rule files live under `$HOME/.config/herd/herd_modes/*.json`

Default state path:

- `$HOME/.config/herd/state.json`

Example settings:

```json
{
  "refresh_interval_ms": 500,
  "capture_lines": 300,
  "stall_threshold_secs": 120,
  "cooldown_secs": 120,
  "max_nudges": 3,
  "nudge_message": "Please continue until the task is fully complete.",
  "finished_markers": ["finished", "complete", "done"],
  "waiting_markers": ["waiting for input", "need your input"],
  "marker_lookback_lines": 8,
  "status_track_exact_commands": ["tmux"],
  "agent_process_markers": ["claude", "codex"],
  "status_waiting_grace_secs": 120,
  "status_transition_stability_secs": 5,
  "status_confidence_min_for_trigger": 60,
  "live_capture_line_multiplier": 8,
  "live_capture_min_lines": 400,
  "herd_count": 5,
  "openai_api_key": "",
  "anthropic_api_key": "",
  "llm_provider": "openai",
  "llm_model": "",
  "herd_modes": [
    { "name": "Balanced", "rule_file": "herd_modes/balanced.json" },
    { "name": "Conservative", "rule_file": "herd_modes/conservative.json" },
    { "name": "Aggressive", "rule_file": "herd_modes/aggressive.json" }
  ]
}
```

Example herd mode rule file (`~/.config/herd/herd_modes/balanced.json`):

```json
{
  "version": 1,
  "rules": [
    {
      "id": "default_nudge",
      "type": "regex",
      "enabled": true,
      "input_scope": "full_buffer",
      "pattern": "(?s).*",
      "command_template": "Please continue until the task is fully complete."
    },
    {
      "id": "llm_suggested_command",
      "type": "llm",
      "enabled": false,
      "input_scope": "visible_window",
      "prompt": "Return strict JSON: {\"match\":bool,\"command\":string?,\"variables\":object?}.",
      "command_template": "{command}"
    }
  ]
}
```

## Safety Notes

- Nudges only fire for herd-eligible assessments (`stalled` or `waiting_long`) that are marked as herded.
- Finished sessions are never nudged.
- Low-confidence assessments are suppressed by `status_confidence_min_for_trigger`.
- Cooldown and max-nudge limits prevent repeated spam.
- Herd state is persisted and reused across restarts.
