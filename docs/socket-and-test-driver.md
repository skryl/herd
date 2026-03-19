# Herd Socket API And Test Driver

This page documents Herd's local socket control surface and the typed `test_driver` automation API.

## Socket API

Herd exposes a newline-delimited JSON protocol on `/tmp/herd.sock` by default. If `HERD_RUNTIME_ID` is set, the socket path becomes `/tmp/herd-<runtime_id>.sock`.

Compatibility note: several socket commands still use the field name `session_id`, but the value is the target pane ID for the tile you are operating on.

Supported commands:

- `spawn_shell`
- `destroy_shell`
- `list_shells`
- `send_input`
- `exec_in_shell`
- `read_output`
- `set_title`
- `set_read_only`
- `test_driver`
- `test_dom_query`
- `test_dom_keys`
- `tmux_pane_created` (accepted for compatibility; currently a no-op because tmux control mode discovers new panes directly)

`spawn_shell` accepts optional `x`, `y`, `width`, `height`, `parent_session_id`, and `parent_pane_id`. It returns the new tile's pane ID as `session_id`, plus its `window_id` and resolved `parent_window_id`.

`exec_in_shell` is different from `send_input`: it respawns the target pane with `/bin/bash -lc <command>`, which is what the Claude hook path uses when it needs to replace an interactive shell with a specific background process.

Examples with `socat`:

```bash
export HERD_SOCK=/tmp/herd.sock

printf '%s\n' '{"command":"list_shells"}' \
  | socat - UNIX-CONNECT:$HERD_SOCK
```

Spawn a child shell linked to an existing pane:

```bash
printf '%s\n' '{"command":"spawn_shell","parent_pane_id":"%1","x":180,"y":140,"width":640,"height":400}' \
  | socat - UNIX-CONNECT:$HERD_SOCK
```

Send input to a shell:

```bash
printf '%s\n' '{"command":"send_input","session_id":"%1","input":"pwd\n"}' \
  | socat - UNIX-CONNECT:$HERD_SOCK
```

Read buffered output:

```bash
printf '%s\n' '{"command":"read_output","session_id":"%1"}' \
  | socat - UNIX-CONNECT:$HERD_SOCK
```

Replace a shell with a one-shot command:

```bash
printf '%s\n' '{"command":"exec_in_shell","session_id":"%1","shell_command":"echo hello from herd && sleep 5"}' \
  | socat - UNIX-CONNECT:$HERD_SOCK
```

## Test Driver

The typed `test_driver` socket API is the supported automation surface for the integration suite. It is available in debug builds and can also be enabled explicitly with `HERD_ENABLE_TEST_DRIVER=1`.

Example:

```bash
printf '%s\n' '{"command":"test_driver","request":{"type":"ping"}}' \
  | socat - UNIX-CONNECT:$HERD_SOCK
```

The current request surface includes:

- Readiness and status: `ping`, `wait_for_ready`, `wait_for_bootstrap`, `wait_for_idle`, `get_status`
- State snapshots: `get_state_tree`, `get_projection`
- Keyboard and command bar control: `press_keys`, `command_bar_open`, `command_bar_set_text`, `command_bar_submit`, `command_bar_cancel`
- Toolbar and sidebar control: `toolbar_select_tab`, `toolbar_add_tab`, `toolbar_spawn_shell`, `sidebar_open`, `sidebar_close`, `sidebar_select_item`, `sidebar_move_selection`, `sidebar_begin_rename`
- Tile and canvas control: `tile_select`, `tile_close`, `tile_drag`, `tile_resize`, `tile_title_double_click`, `canvas_pan`, `canvas_zoom_at`, `canvas_wheel`, `canvas_fit_all`, `canvas_reset`
- Close-confirm flow: `confirm_close_tab`, `cancel_close_tab`

For programmatic examples, see [`../tests/integration/client.ts`](../tests/integration/client.ts).

`test_dom_query` and `test_dom_keys` are still present behind the same gate, but they are manual debugging helpers rather than the supported automated integration surface.
