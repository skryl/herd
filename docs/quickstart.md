# Quickstart

## Prerequisites

- Rust toolchain (`cargo`)
- tmux
- Optional: `codex` and/or `claude` in tmux panes for agent-aware status/rule behavior

## Build

```bash
cargo build
```

## Run

Open the TUI:

```bash
cargo run -- tui
```

List sessions with derived statuses:

```bash
cargo run -- sessions
```

Inspect herd state:

```bash
cargo run -- herd list
```

## First Boot Files

By default, herd writes all config/state under `~/.config/herd`:

- `settings.json` for app settings
- `state.json` for herd registry state
- `herd_modes/*.json` for rule files

`settings.json` is created automatically on first boot if missing.

## Next Steps

1. Open the TUI and press `,` to open Settings.
2. Add your provider API keys and choose a model.
3. Assign panes to herd groups and herd modes.
4. Monitor the content and Herder Log panes.
