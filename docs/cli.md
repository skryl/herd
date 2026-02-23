# CLI Reference

## Command Overview

```bash
herd tui
herd sessions
herd herd list
herd herd mark <pane_id>
herd herd unmark <pane_id>
```

## Commands

`herd tui`

- Starts the split-pane terminal UI.

`herd sessions`

- Prints tmux sessions grouped by session/window/pane.
- Includes derived status for tracked agent panes.

`herd herd list`

- Prints persisted herd registry entries.

`herd herd mark <pane_id>`

- Marks a pane as herded in state.

`herd herd unmark <pane_id>`

- Unmarks a pane as herded in state.

## Global Flags

`--tmux-socket <name>`

- tmux socket name (equivalent to `tmux -L <name>`).

`--config <path>`

- Override config path (defaults to `~/.config/herd/settings.json`).

`--state <path>`

- Override state path (defaults to `~/.config/herd/state.json`).

## Environment Variables

- `HERD_TMUX_SOCKET`
- `HERD_CONFIG`
- `HERD_STATE`
