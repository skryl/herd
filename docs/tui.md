# TUI Guide and Keybindings

## Layout

- Left side:
  - Sessions tree (`server(status) -> session -> window -> pane`)
  - Herds list
  - Session details
- Right side:
  - Content pane (selected pane output)
  - Herder Log pane (always visible)

## Core Behavior

- Agent status is tracked for `claude*`, `codex*`, and `tmux` command panes.
- `codex` panes attempt app-server status first, then fall back to tmux heuristics.
- Content pane defaults to tail-follow and remembers per-pane manual scroll overrides.
- Herder Log supports per-herd color and numeric filtering.

## Input Mode

In the content pane:

- `i` enters input mode.
- Typed text stays local as an unsent draft.
- `Enter` inserts newline into the unsent buffer.
- `Shift+Enter` sends the full buffer to tmux.
- `Ctrl+S` is a send fallback.
- `Esc` exits input mode.

## Keybindings

Global and focus movement:

- `H` / `J` / `K` / `L`: move focus left/down/up/right
- `h` / `l`: focus sessions/content
- `q`: quit
- `,`: open Settings overlay

Sessions pane:

- `j` / `k`: move selection
- `g` / `G`: first/last
- `0-9`: assign herd
- `-`: clear herd assignment

Herds pane:

- `j` / `k`: move selection
- `g` / `G`: first/last
- `e`: cycle herd mode

Details pane:

- `enter` or `t`: toggle herd
- `y`: herd on
- `n`: herd off
- `0-9`: assign herd
- `-`: clear herd assignment

Content pane (command mode):

- `j` / `k`: scroll
- `u` / `d`: page up/down
- `g` / `G`: top/bottom

Herder Log pane:

- `j` / `k`: scroll
- `u` / `d`: page up/down
- `g` / `G`: top/bottom
- `0-9`: filter to one herd
- `a` or `-`: clear filter

## Settings Overlay

Settings currently support:

- Herd count
- OpenAI and Anthropic API keys
- Provider + model selection
- Herd modes list (add/remove/rename/select)
- Rule file editing for selected herd mode
