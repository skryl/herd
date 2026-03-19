# Herd

Herd is a Tauri desktop app for managing terminal work as a spatial canvas instead of a stack of tabs. It runs an isolated `tmux` server, projects shells into a zoomable 2D workspace, and exposes a local socket + MCP bridge so agents can spawn and control more shells from inside Herd.

## What It Does

- Renders terminal shells as draggable, resizable tiles on a pannable canvas
- Keeps runtime shell topology in `tmux` and canvas geometry in Herd-owned layout metadata
- Supports keyboard-first navigation with command mode and input mode
- Exposes a local Unix socket at `/tmp/herd.sock`
- Ships a separate stdio MCP server in `mcp-server/` that forwards to the socket API
- Persists tile layout across app restarts in `tmp/herd-state.json`

## Current Runtime Model

Herd is in the middle of a tmux-authoritative refactor. The current codebase behaves like this:

- Herd starts its own isolated tmux server with `tmux -f /dev/null -L herd`
- The frontend hydrates from backend `TmuxSnapshot` updates
- `tmux` owns shell lifecycle, focus, active selection, and naming
- Herd owns only presentation state such as tile positions, canvas zoom/pan, overlays, and local UI mode
- UI tabs currently map to tmux sessions
- Visible shell tiles currently map to single-pane tmux windows, with some compatibility APIs still referring to pane IDs as `session_id`

If you are changing topology behavior, read [`prd/2026_03_18_tmux_authoritative_state_refactor_prd.md`](/Users/skryl/Dev/herd/prd/2026_03_18_tmux_authoritative_state_refactor_prd.md) first.

## Stack

- Frontend: Svelte 5, TypeScript, Vite, xterm.js
- Desktop shell: Tauri v2
- Backend: Rust
- Terminal runtime: tmux control mode
- Agent bridge: Model Context Protocol (MCP) over stdio, backed by Herd's Unix socket

## Prerequisites

You need:

- Node.js and npm
- Rust toolchain
- Tauri system prerequisites for your OS
- `tmux`
- `zsh`

Optional but useful:

- `socat` for manually testing the Unix socket API

## Development

Install root dependencies:

```bash
npm install
```

Install and build the MCP bridge:

```bash
cd mcp-server
npm install
npm run build
cd ..
```

Run the desktop app:

```bash
npm run tauri dev
```

That starts the Vite dev server, launches Tauri, ensures the private tmux server exists, and opens the Herd window.

To produce a desktop build:

```bash
npm run tauri build
```

## Runtime Files

During local development, Herd writes state and logs under `tmp/` when possible:

- `tmp/herd-state.json`: persisted tile geometry
- `tmp/herd-socket.log`: socket traffic log
- `tmp/herd-cc.log`: tmux control-mode log

The public Unix socket path is:

```text
/tmp/herd.sock
```

## Keyboard Controls

Herd is primarily keyboard-driven.

### Modes

- `i`: enter input mode for the selected shell
- `Shift+Esc`: leave input mode and return to command mode
- `:`: open the command bar
- `?`: open help

### Navigation

- `h j k l`: move focus between tiles
- `H J K L`: move the selected tile
- `n` / `p`: cycle windows in the current tab
- `N` / `P`: cycle tabs
- `b`: toggle the tmux tree sidebar
- `d`: toggle the debug pane

### View

- `z`: zoom to selected tile
- `f`: fit all tiles in view
- `0`: reset zoom and pan
- `a`: auto-arrange shells in a grid

### Shell And Tab Actions

- `s`: new shell
- `q`: close selected shell
- `Q`: close all shells in the current tab
- `t`: new tab
- `w`: close current tab

### Command Bar

Examples:

- `:sh`: new shell
- `:q`: close selected shell
- `:qa`: close all shells in the current tab
- `:rename <name>`: rename selected shell
- `:tn`: new tab
- `:tc`: close tab
- `:tr <name>`: rename tab
- `:z`, `:fit`, `:reset`

## Socket API

Herd exposes a newline-delimited JSON protocol on `/tmp/herd.sock`.

Supported commands:

- `spawn_shell`
- `destroy_shell`
- `list_shells`
- `send_input`
- `read_output`
- `set_title`
- `set_read_only`
- `dom_query`
- `dom_keys`

`dom_query` and `dom_keys` are test helpers for driving the live Tauri webview. Treat them as unstable internal tooling, not a polished external API.

Example with `socat`:

```bash
export HERD_SOCK=/tmp/herd.sock

printf '%s\n' '{"command":"list_shells"}' \
  | socat - UNIX-CONNECT:$HERD_SOCK
```

Spawn a new shell:

```bash
printf '%s\n' '{"command":"spawn_shell"}' \
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

Compatibility note: the socket API still uses `session_id` in a few places even when the value is actually a tmux pane ID.

## MCP Server

The repo includes a separate MCP server in [`mcp-server/`](/Users/skryl/Dev/herd/mcp-server) that forwards tool calls to Herd over `/tmp/herd.sock`.

The checked-in [`.mcp.json`](/Users/skryl/Dev/herd/.mcp.json) points at:

```json
{
  "mcpServers": {
    "herd": {
      "type": "stdio",
      "command": "node",
      "args": ["mcp-server/dist/index.js"]
    }
  }
}
```

Available MCP tools:

- `herd_spawn_shell`
- `herd_list_shells`
- `herd_destroy_shell`
- `herd_send_input`
- `herd_read_output`
- `herd_set_title`

The app must be running before the MCP server can connect successfully.

## Testing

Static checks and unit tests:

```bash
npm run check
npm run test:unit
```

tmux integration script:

```bash
bash bin/test-herd.sh
```

End-to-end script against the real Tauri webview:

```bash
npx tsx test-e2e.ts
```

`test-e2e.ts` expects Herd to already be running and listening on `/tmp/herd.sock`.

## Repo Layout

- [`src/`](/Users/skryl/Dev/herd/src): Svelte frontend
- [`src-tauri/`](/Users/skryl/Dev/herd/src-tauri): Rust backend and Tauri app
- [`mcp-server/`](/Users/skryl/Dev/herd/mcp-server): stdio MCP bridge
- [`bin/`](/Users/skryl/Dev/herd/bin): helper scripts and integration test utilities
- [`prd/`](/Users/skryl/Dev/herd/prd): product and refactor notes

## Notes

- The original scaffold PRD is in [`prd/2026_03_13_tauri_canvas_terminal_scaffold_prd.md`](/Users/skryl/Dev/herd/prd/2026_03_13_tauri_canvas_terminal_scaffold_prd.md).
- The current refactor direction is captured in [`prd/2026_03_18_tmux_authoritative_state_refactor_prd.md`](/Users/skryl/Dev/herd/prd/2026_03_18_tmux_authoritative_state_refactor_prd.md).
- `TODO.md` tracks a few near-term ideas such as libghostty and window snapping.
