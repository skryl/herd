# Herd

![Herd screenshot](docs/screenshots/herd_chess.gif)

Herd is an experiment platform for agent collaboration. It gives agents explicit message channels, LAN-style local service discovery over visible tile networks, and a per-session Root agent that can inspect and configure the shared canvas. Under the hood, Herd runs an isolated `tmux` server, projects terminal-backed tiles into a spatial workspace, and exposes a local socket, CLI, and MCP bridge so users and agents operate inside the same environment.

## Docs

- [`docs/architecture.md`](docs/architecture.md): collaboration model, runtime architecture, Root/worker roles, messaging, networks, and persistence
- [`docs/keyboard-shortcuts.md`](docs/keyboard-shortcuts.md): keyboard modes, navigation, view controls, sidebar controls, and command bar shortcuts
- [`docs/socket-and-test-driver.md`](docs/socket-and-test-driver.md): detailed CLI, socket, MCP, and `test_driver` reference

## Why Herd

- Experiment with how worker agents coordinate when they communicate through explicit channels instead of hidden shared context.
- Model local collaboration as visible connected components, so service discovery and callable capabilities come from the agent’s current network rather than a global registry.
- Separate coordination from orchestration: workers collaborate locally, while a Root agent can inspect and reconfigure the shared canvas and session state.
- Keep the collaboration graph visible. Herd’s canvas makes agent placement, network topology, lineage, activity, and ownership legible instead of burying them in logs or background processes.

## Mental Model

- `tmux` owns terminal process lifecycle and scrollback.
- Herd owns semantic state: tile identity, messaging, local networks, work ownership, activity, and canvas layout.
- A tab maps to a tmux session. Terminal-backed tiles are tmux-backed, but public control flows target Herd-owned `tile_id`, not tmux pane ids.
- Workers discover and call services through their visible local network. Root is the privileged coordinator for layout, lifecycle, topology, and other session-wide changes.

See [`docs/architecture.md`](docs/architecture.md) for the detailed runtime model.

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

The CLI mirrors the local collaboration model: inspect tiles and networks, message agents, and let Root handle privileged session changes. See [`docs/socket-and-test-driver.md`](docs/socket-and-test-driver.md) for the full CLI and socket reference.

Examples:

```bash
herd network list
herd tile list
herd message network "Need another pair of eyes on this local network"
herd message root "Please inspect the local session and assign follow-up"
herd tile create work --title "Socket API follow-up"
```

Agent, topic, chatter, network, and work commands are session-private. They only expose the current tmux tab/session's registry data.

## Runtime Files

By default, Herd uses the runtime name `herd` and writes:

- `/tmp/herd.sock`: local newline-delimited JSON socket API
- `tmp/herd-socket.log`: socket traffic log
- `tmp/herd-cc.log`: tmux control-mode log
- `tmp/herd.sqlite`: SQLite store for tile registry/layout state, chatter, agents, topics, network state, and work metadata/stage content

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

Workers and Root use the same checked-in `server:herd` entry, but they do not see the same interface. Workers get messaging plus local-network discovery and `network_call`; Root gets the broader session control surface. The MCP bridge also forwards inbound Herd events into the Claude channel when it runs inside a Herd-managed agent tile.

The exact worker/root split, channel behavior, and browser/service-control details are documented in [`docs/socket-and-test-driver.md`](docs/socket-and-test-driver.md).

## Agent Integration

Herd agents currently run on top of the Claude CLI, so they work best when launched inside a Herd shell rather than from an unrelated terminal.

The active project hooks are configured in [`.claude/settings.json`](.claude/settings.json):

- `PreToolUse` matcher `Agent` -> [`.claude/hooks/on-agent-start.sh`](.claude/hooks/on-agent-start.sh)
- `PreToolUse` matcher `Bash` -> [`.claude/hooks/on-bg-bash.sh`](.claude/hooks/on-bg-bash.sh)

In practice, Herd injects the local socket and tile/agent context into managed launches, keeps Root present as the session coordinator, and relies on the Claude hooks to spawn or observe additional collaborator tiles. The detailed hook/runtime behavior lives in [`docs/architecture.md`](docs/architecture.md) and [`docs/socket-and-test-driver.md`](docs/socket-and-test-driver.md).

Typical flow:

1. Open a shell in Herd or click `+ Agent`.
2. The agent starts in the session spawn directory with `claude --mcp-config <repo-root>/.mcp.json --teammate-mode tmux --dangerously-load-development-channels server:herd`.
3. Ask the agent to create teammates or run background tool work.
4. Herd renders those hook-spawned or tmux-created children as additional linked tiles on the canvas and tracks agent messaging activity.

## Command Bar

See [`docs/keyboard-shortcuts.md`](docs/keyboard-shortcuts.md) for the current keyboard and command-bar surface, including `:sudo`, `:dm`, and `:cm`.

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
