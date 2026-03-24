# Herd

![Herd screenshot](docs/screenshots/claudes.png)

Herd is a Tauri desktop app for managing terminal work as a spatial canvas instead of a stack of tabs. It runs an isolated `tmux` server, projects shells into a zoomable 2D workspace, and exposes a local Unix socket, a grouped `herd` CLI, and an MCP bridge so tools and agents can drive the canvas from inside Herd.

## Docs

- [`docs/architecture.md`](docs/architecture.md): runtime model, roles, messaging, networks, ownership, and persistence
- [`docs/keyboard-shortcuts.md`](docs/keyboard-shortcuts.md): keyboard modes, navigation, view controls, sidebar controls, and command bar shortcuts
- [`docs/socket-and-test-driver.md`](docs/socket-and-test-driver.md): socket API, `test_driver`, compatibility notes, and manual `socat` examples

## What It Does

- Renders shell, Agent, Browser, and Work tiles as draggable, resizable tiles on a pannable canvas
- Gives every tile visible side ports and tracks session-local tile networks through manual port connections
- Derives Work ownership from the Agent connected to the Work tile's left read/write port
- Keeps runtime shell topology in `tmux` and canvas/debug/runtime state in Herd-owned SQLite state
- Maps tabs to tmux sessions and visible terminal-backed tiles to tmux windows with their primary pane
- Draws parent/child provenance lines only for hook-triggered lineage, while keeping manual user-created tiles rooted at the session
- Supports keyboard-first control through command mode, input mode, the sidebar tree, the command bar, and the help overlay
- Includes `+ Shell`, `+ Agent`, `+ Browser`, and `+ Work` launchers plus matching canvas context-menu actions
- Includes a per-session red Root agent and Herd-managed worker agents with channel support
- Exposes a local Unix socket, a grouped `herd` CLI, and a separate stdio MCP server in `mcp-server/`
- Ships a typed in-app `test_driver` API used by the integration suite

## Current Runtime Model

Herd currently behaves like this:

- Herd starts or reconnects to its own isolated tmux server with `tmux -f /dev/null -L herd`
- The frontend hydrates from backend `TmuxSnapshot` updates
- `tmux` owns shell lifecycle, focus, session/window naming, and output buffers
- Herd owns tile geometry, canvas zoom/pan, overlays, parent-line rendering, manual network edges, local read-only state, and UI mode
- A tab maps to a tmux session
- A visible shell/Agent/Browser tile maps to a tmux window with its primary pane
- A Work tile is a session-local registry item backed entirely by Herd-owned SQLite state
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

## CLI

The app binary also exposes a grouped local CLI:

- installed usage: `herd`
- source-tree usage: `bin/herd`

When the app starts, it refreshes `~/.local/bin/herd` to point at the installed executable. In the repo, `bin/herd` wraps the Rust CLI directly.

Examples:

```bash
herd network list
herd network list shell
herd session list
herd session list agent
herd session list work
herd tile get %7
herd tile move %7 1180 260
herd tile resize %7 760 520
herd topic list
herd work create "Socket API follow-up"
herd message public "Picking up #prd-7 with @agent-1234"
herd message network "Need another pair of eyes on this local network"
herd message root "Please inspect the local session and assign follow-up"
herd sudo "Please inspect the local session and assign follow-up"
herd message direct agent-1234 "Can you review the socket changes?"
```

Agent, topic, chatter, network, and work commands are session-private. They only expose the current tmux tab/session's registry data.

## Runtime Files

By default, Herd uses the runtime name `herd` and writes:

- `/tmp/herd.sock`: local newline-delimited JSON socket API
- `tmp/herd-socket.log`: socket traffic log
- `tmp/herd-cc.log`: tmux control-mode log
- `tmp/herd.sqlite`: SQLite store for tile state, chatter, agents, topics, and work metadata

If you set `HERD_RUNTIME_ID`, Herd namespaces those files under `herd-<runtime_id>` instead. The integration suite uses that to run isolated app instances without colliding with the default runtime.

## MCP Server

The repo includes a separate MCP server in [`mcp-server/`](mcp-server/) that forwards tool calls to Herd over the local socket. That same server also declares the experimental Claude channel capability when it is running inside a Herd-managed agent tile.

The checked-in [`.mcp.json`](.mcp.json) points at:

```json
{
  "mcpServers": {
    "herd": {
      "type": "stdio",
      "command": "./bin/herd-mcp-server"
    }
  }
}
```

`bin/herd-mcp-server` is a tracked wrapper that resolves the repo root and runs `mcp-server/run.mjs`.
`mcp-server/run.mjs` rebuilds `mcp-server/dist/` automatically when the TypeScript source is newer, so new agent tiles do not silently boot a stale MCP bridge.

Herd-managed agent launches pass the repo-root `.mcp.json` explicitly with `--mcp-config`, so they can run from the configured session spawn directory without carrying duplicate MCP config files in subdirectories.

Available MCP tools depend on the calling agent role:

- worker agents get message tools plus local network inspection and local tool access:
  - `message_direct`
  - `message_public`
  - `message_network`
  - `message_root`
  - `network_list`
  - `network_get`
  - `network_call`
- root agents additionally get the latest user-facing root/socket surface:
  - `tile_create`
  - `tile_destroy`
  - `tile_list`
  - `tile_rename`
  - `tile_call`
  - `shell_input_send`
  - `shell_exec`
  - `shell_output_read`
  - `shell_role_set`
  - `browser_navigate`
  - `browser_load`
  - `browser_drive`
  - `message_topic_list`
  - `message_topic_subscribe`
  - `message_topic_unsubscribe`
  - `tile_get`
  - `tile_move`
  - `tile_resize`
  - `network_connect`
  - `network_disconnect`
  - `work_stage_start`
  - `work_stage_complete`
  - `work_review_approve`
  - `work_review_improve`

When `HERD_TILE_ID` or `HERD_SESSION_ID` is present in the calling environment, `tile_create` forwards parent context so spawned tiles stay linked to the originating tile/session.

The app must be running before the MCP server can connect successfully.

When launched inside a Herd-managed agent tile, the MCP server also:

1. registers the agent with Herd using `HERD_AGENT_ID`
2. subscribes to agent events over `HERD_SOCK`
3. forwards backend events to Claude through `notifications/claude/channel`
4. acknowledges Herd `PING` events for liveness tracking

Every session/tab also has one visible red Root agent with stable id `root:<session_id>`. Root and worker agents both use the same checked-in `server:herd` entry; the MCP server switches between worker-safe local-network mode and full-tool root mode by inspecting `HERD_AGENT_ROLE` and `HERD_AGENT_ID`.

Over the worker network surface, `agent` and `root_agent` tiles are always read-only. Agents coordinate with each other through the `message_*` tools, not by sending terminal control actions over `network_call`.

The MCP server also teaches agents how the inbound message channel works:

- incoming Herd traffic arrives through `notifications/claude/channel`
- metadata includes sender, recipient, topics, mentions, replay flag, and timestamp
- `replay=true` means historical context, not a fresh request
- if an agent wants Herd or another agent to see a reply, it must answer through the Herd messaging tools, not plain assistant text

`browser_drive` is the dedicated child-webview automation surface for browser tiles. It takes a browser `tile_id`, an `action`, and action-specific args. Supported actions are `click`, `type`, `dom_query`, and `eval`. Root may use it on any browser tile in the current session. Workers should use `network_call` against a visible local-network browser tile with action `drive`, and inspect `network_get(...).message_api` for the exact browser args and `drive` subcommands.

## Agent Integration

Herd agents currently run on top of the Claude CLI, so they work best when launched inside a Herd shell rather than from an unrelated terminal.

The active project hooks are configured in [`.claude/settings.json`](.claude/settings.json):

- `PreToolUse` matcher `Agent` -> [`.claude/hooks/on-agent-start.sh`](.claude/hooks/on-agent-start.sh)
- `PreToolUse` matcher `Bash` -> [`.claude/hooks/on-bg-bash.sh`](.claude/hooks/on-bg-bash.sh)

In the current setup:

- Herd injects `HERD_SOCK` into the tmux shells it creates so processes inside those shells can call back into Herd
- Herd injects `HERD_AGENT_ID` into Herd-managed agent launches
- Herd injects `HERD_TILE_ID` into Herd-managed agent launches
- Each tmux tab/session carries a configurable spawn directory used by both new shell and new Agent windows; new sessions default it to the project root
- The hook scripts may still use tmux pane metadata internally so child tiles retain visible parent linkage
- The `Agent` hook creates a normal child tile, titles it, launches the child process with `--mcp-config <repo-root>/.mcp.json --teammate-mode tmux --dangerously-load-development-channels server:herd`, and streams transcript/task updates into that tile
- Root agents are spawned and repaired by Herd automatically, are highlighted in red, and can be closed only through a confirmation flow that immediately restarts them
- Worker agents can inspect visible local-network `shell` and `browser` tiles with `network_list` / `network_get`, read `message_api` for action args, and invoke worker-safe tile messages through `network_call`, including browser `drive`
- Root agents can use generic `tile_call` across any tile in the current session
- Worker agents should still use `message root` for privileged Herd actions such as lifecycle, layout, topology, and work mutations
- The background `Bash` hook only acts on `run_in_background` calls and marks the spawned tile as read-only
- Herd keeps per-session agent/work registries, per-session chatter history, topic subscriptions, session-local tile networks, and per-agent activity panels for Agent tiles
- Herd also discovers tmux-created teammate panes directly through control mode, so tmux-created agent teammates still appear as linked tiles even without a socket callback
- Messages received through the Claude channel must be answered through Herd messaging tools if the response should be visible to other agents or Root

Typical flow:

1. Open a shell in Herd or click `+ Agent`.
2. The agent starts in the session spawn directory with `claude --mcp-config <repo-root>/.mcp.json --teammate-mode tmux --dangerously-load-development-channels server:herd`.
3. Ask the agent to create teammates or run background tool work.
4. Herd renders those hook-spawned or tmux-created children as additional linked tiles on the canvas and tracks agent messaging activity.

## Command Bar

The `:` command bar currently supports:

- `:sh`, `:shell`, `:new`
- `:q`, `:close`
- `:qa`, `:closeall`
- `:rename <name>`
- `:tn`, `:tabnew [name]`
- `:tc`, `:tabclose`
- `:tr`, `:tabrename <name>`
- `:z`, `:zoom`
- `:fit`
- `:reset`
- `:sudo <message>` to message the current session Root as `User`
- `:dm <agent_id|AgentNumber|root> <message>` to send a direct message as `User`
- `:cm <message>` to send a public chatter message as `User`

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
