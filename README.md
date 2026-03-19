# Herd

![Herd screenshot](docs/screenshots/claudes.png)

Herd is a Tauri desktop app for managing terminal work as a spatial canvas instead of a stack of tabs. It runs an isolated `tmux` server, projects shells into a zoomable 2D workspace, and exposes a local Unix socket plus an MCP bridge so tools and agents can drive the canvas from inside Herd.

## Docs

- [`docs/keyboard-shortcuts.md`](docs/keyboard-shortcuts.md): keyboard modes, navigation, view controls, sidebar controls, and command bar shortcuts
- [`docs/socket-and-test-driver.md`](docs/socket-and-test-driver.md): socket API, `test_driver`, compatibility notes, and manual `socat` examples

## What It Does

- Renders terminal shells as draggable, resizable tiles on a pannable canvas
- Keeps runtime shell topology in `tmux` and canvas geometry in Herd-owned layout state
- Maps tabs to tmux sessions and visible tiles to tmux windows with their primary pane
- Draws parent/child links for shells spawned from another pane, including Claude hook tiles and tmux-created teammate panes
- Supports keyboard-first control through command mode, input mode, the sidebar tree, the command bar, and the help overlay
- Exposes a local Unix socket and a separate stdio MCP server in `mcp-server/`
- Ships a typed in-app `test_driver` API used by the integration suite

## Current Runtime Model

Herd currently behaves like this:

- Herd starts or reconnects to its own isolated tmux server with `tmux -f /dev/null -L herd`
- The frontend hydrates from backend `TmuxSnapshot` updates
- `tmux` owns shell lifecycle, focus, session/window naming, and output buffers
- Herd owns tile geometry, canvas zoom/pan, overlays, parent-line rendering, local read-only state, and UI mode
- A tab maps to a tmux session
- A visible shell tile maps to a tmux window with its primary pane
- New shells are created by splitting from an existing pane and immediately breaking that pane into its own window so every tile remains independent on the canvas

## Stack

- Frontend: Svelte 5, TypeScript, Vite, xterm.js
- Desktop shell: Tauri v2
- Backend: Rust
- Terminal runtime: tmux control mode
- Agent bridge: Model Context Protocol (MCP) over stdio, backed by Herd's Unix socket
- Test stack: Vitest plus a typed socket-driven integration harness

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

Build the MCP bridge if you want to use the checked-in `.mcp.json` entry:

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

For frontend-only iteration:

```bash
npm run dev
```

Frontend-only production bundle:

```bash
npm run build
```

Desktop build:

```bash
npm run tauri build
```

## Runtime Files

By default, Herd uses the runtime name `herd` and writes:

- `/tmp/herd.sock`: local newline-delimited JSON socket API
- `tmp/herd-socket.log`: socket traffic log
- `tmp/herd-cc.log`: tmux control-mode log
- `tmp/herd-state.json`: persisted tile geometry

If you set `HERD_RUNTIME_ID`, Herd namespaces those files under `herd-<runtime_id>` instead. The integration suite uses that to run isolated app instances without colliding with the default runtime.

## MCP Server

The repo includes a separate MCP server in [`mcp-server/`](mcp-server/) that forwards tool calls to Herd over the local socket.

The checked-in [`.mcp.json`](.mcp.json) points at:

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

When `TMUX_PANE` or `HERD_SESSION_ID` is present in the calling environment, `herd_spawn_shell` forwards parent context so spawned tiles stay linked to the originating shell.

The app must be running before the MCP server can connect successfully.

## Claude Integration

Claude works best when it is launched inside a Herd shell, not from an unrelated terminal.

The active project hooks are configured in [`.claude/settings.json`](.claude/settings.json):

- `PreToolUse` matcher `Agent` -> [`.claude/hooks/on-agent-start.sh`](.claude/hooks/on-agent-start.sh)
- `PreToolUse` matcher `Bash` -> [`.claude/hooks/on-bg-bash.sh`](.claude/hooks/on-bg-bash.sh)

In the current setup:

- Herd injects `HERD_SOCK` into the tmux shells it creates so processes inside those shells can call back into Herd
- The hook scripts use `TMUX_PANE` when available so child tiles retain visible parent linkage
- The `Agent` hook creates a normal child tile, titles it, launches the child process, and streams transcript/task updates into that tile
- The background `Bash` hook only acts on `run_in_background` calls and marks the spawned tile as read-only
- Herd also discovers tmux-created teammate panes directly through control mode, so tmux-created Claude teammates still appear as linked tiles even without a socket callback

Typical flow:

1. Open a shell in Herd.
2. Start Claude in that shell with `claude --teammate-mode tmux`.
3. Ask Claude to create teammates or run background tool work.
4. Herd renders those hook-spawned or tmux-created children as additional linked tiles on the canvas.

## Testing

Static checks and tests:

```bash
npm run check
npm run test:unit
npm run test:integration
```

Lower-level tmux integration script:

```bash
bash bin/test-herd.sh
```

The managed integration suite currently covers:

- the typed in-app `test_driver` API
- the configured Claude `PreToolUse` `Agent` hook
- the configured Claude `PreToolUse` background `Bash` hook
- tmux-created teammate panes appearing as linked child tiles with preserved lineage

## Repo Layout

- [`docs/`](docs/): reference docs and screenshots
- [`src/`](src/): Svelte frontend
- [`src-tauri/`](src-tauri/): Rust backend and Tauri app
- [`mcp-server/`](mcp-server/): stdio MCP bridge
- [`tests/integration/`](tests/integration/): typed socket-driven integration suite
- [`bin/`](bin/): helper scripts and lower-level tmux test utilities
