# Herd Quickstart

Use this guide for the shortest path from clone to a running local Herd app.

## Prerequisites

You need:

- Node.js and npm
- Rust toolchain
- Tauri system prerequisites for your OS
- `tmux`
- `zsh`

Optional but useful:

- `socat` for manual socket API checks

## 1. Install Dependencies

Install the root workspace dependencies:

```bash
npm install
```

If you want agent launches to use the checked-in [`.mcp.json`](../.mcp.json), also build the MCP bridge once:

```bash
cd mcp-server
npm install
npm run build
cd ..
```

## 2. Start Herd

Run the desktop app in development mode:

```bash
npm run tauri dev
```

That starts the Vite dev server, launches the Tauri app, ensures Herd's private `tmux` server exists, and opens the app window.

On supported platforms, Herd may also prompt to install `agent-browser` and Chrome for Testing on first launch. You can skip that and stay on the default `live_webview` backend until you want the alternate browser runtime.

## 3. Use The Local CLI

Before the installed app binary is on your `PATH`, use the repo-local wrapper:

```bash
bin/herd tile list
bin/herd network list
```

After the app starts, Herd refreshes `~/.local/bin/herd`, so the installed command is usually available as:

```bash
herd tile list
herd message root "Please inspect the local session"
```

## 4. Common Development Loops

Frontend-only iteration:

```bash
npm run dev
```

Production frontend bundle:

```bash
npm run build
```

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

## 5. Read Next

- [README](../README.md) for the high-level project overview
- [Sessions And Layout](./session-and-layout.md) for saved sessions, browser backends, and layout workflows
- [Architecture](./architecture.md) for the runtime model and collaboration concepts
- [Keyboard Shortcuts](./keyboard-shortcuts.md) for the UI control surface
- [CLI, Socket API, and Test Driver](./socket-and-test-driver.md) for the full automation reference
