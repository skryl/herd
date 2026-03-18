# Herd Canvas Terminal App — Tauri v2 Scaffold PRD

## Status

Completed

## Date

2026-03-13

## Context

Setting up a greenfield Tauri v2 desktop app ("Herd") with a 2D pannable/zoomable canvas where users can spawn terminal shells. AI agents running inside shells can programmatically interact with the canvas via a local Unix socket API to spawn new shells or canvas elements. Frontend: Svelte + TypeScript. Terminals: xterm.js + portable-pty (libghostty WASM swap planned later).

## Goals

1. Scaffold a working Tauri v2 + Svelte + TypeScript project.
2. Build a 2D pannable/zoomable canvas workspace.
3. Embed xterm.js terminal tiles on the canvas, backed by PTY sessions in Rust.
4. Expose a Unix socket API (`HERD_SOCK`) so agents inside shells can spawn new shells.

## Non-goals

1. libghostty integration (future — when WASM/rendering API is available).
2. Canvas annotations or drawing tools beyond terminal tiles.
3. Multi-window or multi-user support.
4. Production packaging/signing.

## Scope

### Files to create

**Frontend (`src/`)**:
- `main.ts`, `App.svelte`
- `lib/Canvas.svelte`, `lib/TerminalTile.svelte`, `lib/Toolbar.svelte`
- `lib/stores/canvas.ts`, `lib/stores/terminals.ts`
- `lib/types.ts`, `lib/tauri.ts`
- `styles/global.css`

**Backend (`src-tauri/src/`)**:
- `main.rs`, `lib.rs`, `state.rs`, `commands.rs`
- `pty/mod.rs`, `pty/manager.rs`, `pty/session.rs`
- `socket/mod.rs`, `socket/server.rs`, `socket/protocol.rs`

**Config**: `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`

### Key dependencies

**Rust**: `tauri 2`, `portable-pty 0.9`, `tokio` (full), `serde`, `serde_json`, `uuid`
**JS**: `@tauri-apps/api`, `@tauri-apps/cli`, `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-webgl`, `svelte 5`, `vite`, `typescript`

## Risks and Mitigations

1. **Risk**: `portable-pty` blocking reads stall tokio runtime.
   **Mitigation**: PTY reader runs on `std::thread::spawn`, not `tokio::spawn`.
2. **Risk**: Non-UTF8 terminal output corrupts Tauri event payloads.
   **Mitigation**: Use `String::from_utf8_lossy` for MVP.
3. **Risk**: Stale Unix socket file from unclean shutdown.
   **Mitigation**: Remove `/tmp/herd.sock` on startup and on app exit.

## Phased Plan (Red/Green)

### Phase 1: Project Skeleton

**Objective**: Scaffold Tauri v2 + Svelte project, verify it compiles and opens a window.

Red:
1. No project structure exists — `npm run tauri dev` fails.
2. No Rust backend — `cargo check` in `src-tauri/` fails.

Green:
1. Scaffold Svelte+TS frontend with Vite.
2. Initialize Tauri v2 backend with `npx @tauri-apps/cli init`.
3. Add all Rust dependencies to `src-tauri/Cargo.toml`.
4. Add all JS dependencies to `package.json`.
5. Update `.gitignore` for `node_modules/`, `dist/`, `src-tauri/target/`.

Exit criteria:
1. `npm run tauri dev` opens a window showing the Svelte hello-world page.
2. `cargo check` in `src-tauri/` passes.

### Phase 2: 2D Canvas Workspace

**Objective**: Build a pannable/zoomable canvas with a toolbar.

Red:
1. App shows default Svelte template, no canvas interaction.

Green:
1. Create `stores/canvas.ts` — writable store for `{ panX, panY, zoom }`.
2. Create `Canvas.svelte` — full-viewport div with CSS `transform: translate() scale()` on inner container, mouse wheel zoom, middle-click/space+drag pan.
3. Create `Toolbar.svelte` — top bar with "New Shell" button (no-op initially).
4. Wire `App.svelte` to render `Toolbar` + `Canvas`.

Exit criteria:
1. Canvas pans with middle-click drag and zooms with scroll wheel.
2. Toolbar renders with button visible.

### Phase 3: PTY Backend

**Objective**: Implement PTY session management in Rust with Tauri commands.

Red:
1. No Tauri commands exist — `invoke('create_pty')` from frontend would fail.

Green:
1. Create `state.rs` — `AppState { pty_manager: Arc<Mutex<PtyManager>> }`.
2. Create `pty/session.rs` — `PtySession` holding child, writer, reader thread handle.
3. Create `pty/manager.rs` — `PtyManager` with `create_session(cols, rows, app_handle) -> id`, `destroy_session(id)`, `write_to_session(id, data)`, `resize_session(id, cols, rows)`.
   - Reader on `std::thread::spawn`, emits `app_handle.emit("pty-output-{id}", data)`.
   - Sets `HERD_SOCK` env var on child process.
4. Create `commands.rs` — `#[tauri::command]` wrappers: `create_pty`, `destroy_pty`, `write_pty`, `resize_pty`.
5. Wire in `lib.rs` with `.manage(AppState)` and `.invoke_handler()`.

Exit criteria:
1. `cargo check` passes with all PTY modules.
2. Commands are registered and callable (verified in Phase 4).

### Phase 4: Terminal Tiles (Frontend + Backend Wiring)

**Objective**: Connect xterm.js terminals to PTY sessions via Tauri IPC.

Red:
1. "New Shell" button does nothing.
2. No terminal rendering on canvas.

Green:
1. Create `stores/terminals.ts` — `TerminalInfo[]` store with `spawnTerminal`, `removeTerminal`, `moveTerminal`, `resizeTerminal` actions.
2. Create `types.ts` — `TerminalInfo` interface (`id, x, y, width, height, title`).
3. Create `tauri.ts` — typed `invoke()` wrappers for PTY commands.
4. Create `TerminalTile.svelte`:
   - `onMount`: create xterm.js Terminal + FitAddon, call `createPty(cols, rows)`.
   - Listen to `pty-output-{sessionId}` → write to xterm.
   - xterm `onData` → call `writePty(sessionId, data)`.
   - Draggable title bar, close button.
   - `onDestroy`: call `destroyPty`, unlisten events.
5. Wire Toolbar button → spawn terminal at canvas center.
6. Canvas renders `TerminalTile` for each entry in terminals store.

Exit criteria:
1. Click "New Shell" → terminal tile appears on canvas.
2. Type commands → see shell output.
3. Close terminal → PTY session destroyed.

### Phase 5: Unix Socket Server

**Objective**: Enable agents inside shells to spawn new shells via `HERD_SOCK`.

Red:
1. No socket server running.
2. `echo '{"command":"list_shells"}' | socat - UNIX-CONNECT:/tmp/herd.sock` fails.

Green:
1. Create `socket/protocol.rs` — `SocketCommand` enum (`spawn_shell`, `destroy_shell`, `list_shells`).
2. Create `socket/server.rs` — `tokio::net::UnixListener` on `/tmp/herd.sock`, newline-delimited JSON, per-connection task.
3. Spawn server in `lib.rs` setup hook via `tauri::async_runtime::spawn`.
4. `spawn_shell` handler: creates PTY + emits `shell-spawned` event to frontend.
5. Frontend listens for `shell-spawned` → adds TerminalTile to store.
6. Cleanup: remove socket file on startup (stale) and app exit.

Exit criteria:
1. From a shell inside Herd: `echo '{"command":"list_shells"}' | socat - UNIX-CONNECT:$HERD_SOCK` returns JSON list.
2. `spawn_shell` command creates a new terminal tile on the canvas.

### Phase 6: Polish

**Objective**: Basic UX polish for MVP.

Red:
1. Terminal tiles cannot be moved or resized.

Green:
1. Drag-to-move on terminal title bar (updates store position).
2. Resize handle at bottom-right (calls `resizePty` on release).
3. Dark theme styling (global.css).
4. Proper cleanup on tile close and app exit.

Exit criteria:
1. Terminals can be dragged and resized on the canvas.
2. App has a cohesive dark theme.

## Execution Checklist

- [x] Phase 1: Project skeleton compiles and opens window
- [x] Phase 2: Canvas pans and zooms
- [x] Phase 3: PTY backend compiles
- [x] Phase 4: Terminal tiles work end-to-end
- [x] Phase 5: Unix socket API works from inside shells
- [x] Phase 6: Drag/resize/styling polish

## Acceptance Criteria

1. `npm run tauri dev` opens the app with a 2D canvas workspace.
2. Users can spawn terminal shells on the canvas via the toolbar.
3. Terminals are fully interactive (shell I/O works).
4. Terminals can be moved and resized on the canvas.
5. Canvas supports pan and zoom.
6. Agents inside shells can spawn new shells via `HERD_SOCK` Unix socket.
