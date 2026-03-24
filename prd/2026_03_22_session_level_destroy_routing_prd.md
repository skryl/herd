# Session-Level Destroy Routing PRD

## Status

Completed

## Date

2026-03-22

## Context

After the session receiver expansion, session-scoped `*_list` and `*_create` commands already route through `SessionMessageReceiver`, but the specialized destroy wrappers still dispatched directly to `TileMessageReceiver`, and generic tile discovery still advertised `destroy` as a tile-level capability. The intended boundary is now: list/create/destroy operations are session-level, while instance-level tile operations stay on tile receivers.

## Goals

1. Route `shell_destroy` and `browser_destroy` through `SessionMessageReceiver`.
2. Preserve the existing socket command shapes and root-only permission checks.
3. Make their structured logs target the session instance rather than the tile.
4. Remove generic tile-level `destroy` from tile receiver capabilities and `responds_to` discovery.
5. Leave generic tile-instance commands such as `tile_get`, `tile_call`, `tile_move`, and `tile_resize` otherwise unchanged in this slice.

## Non-goals

1. Renaming legacy payload fields like `shell_destroy.session_id`.
2. Refactoring non-destroy tile-instance commands.

## Scope

1. `src-tauri/src/socket/server.rs`
2. `tests/integration/worker-root-mcp.test.ts`
3. `docs/socket-and-test-driver.md`

## Risks And Mitigations

1. The destroy wrappers could lose the existing root guard.
   - Mitigation: keep the current root checks in the socket arms before session delivery.
2. Destroy behavior could drift if the session receiver reimplements kill semantics incorrectly.
   - Mitigation: keep the implementation narrow and reuse the existing pane/window kill path.
3. The session receiver test could verify logging without verifying actual destruction.
   - Mitigation: destroy real shell/browser tiles in the integration flow and assert the wrappers appear in session-targeted logs.

## Acceptance Criteria

1. `shell_destroy` and `browser_destroy` dispatch through `SessionMessageReceiver.send(...)`.
2. Their socket arms no longer resolve a tile receiver directly.
3. Tile discovery and generic tile receivers no longer advertise or accept `destroy`.
4. The focused session-receiver integration covers both destroy wrappers and observes session-targeted logs.
5. Targeted compile/type/integration checks are green.

## Phased Plan

### Phase 1: Red

#### Objective

Make the missing session-level destroy routing observable.

#### Red

1. Extend the session-receiver integration to destroy a shell tile and a browser tile and expect session-targeted log entries for both wrapper commands.
2. Update the docs and tile capability expectations to state that list/create/destroy operations are session-level.

Expected failure signal:
- `shell_destroy` and `browser_destroy` log against tile targets instead of the session
- shell/browser tile `responds_to` still include `destroy`
- docs still imply only create/list wrappers are session-level

#### Green

1. Add destroy message support to `SessionMessageReceiver`.
2. Switch the `shell_destroy` and `browser_destroy` socket arms to `dispatch_session_message(...)`.
3. Remove generic tile-level `destroy` from `responds_to` and tile dispatch.
4. Preserve the current root permission checks and destroy behavior.

Verification commands:
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `cargo test --manifest-path src-tauri/Cargo.toml network::tests`
- `npm run check`
- `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "enforces worker local-network permissions at the backend"`
- `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "routes session-scoped socket commands through the session receiver"`

#### Exit Criteria

1. Both destroy wrappers are session-receiver commands.
2. Generic tile capability discovery no longer exposes `destroy`.
3. The focused integrations pass with session-targeted destroy log entries and updated worker capability expectations.

## Execution Checklist

- [x] PRD saved
- [x] Phase 1 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log

1. `rg -n "shell_destroy|browser_destroy|destroy" src-tauri/src/cli.rs src-tauri/src/socket/protocol.rs tests/integration/client.ts tests/integration/worker-root-mcp.test.ts docs/socket-and-test-driver.md README.md`
   - result: pass
   - notes: confirmed the public destroy wrapper surface and current references
2. `sed -n '2880,3210p' src-tauri/src/socket/server.rs`
   - result: pass
   - notes: confirmed `shell_destroy` and `browser_destroy` still resolve directly to tile receivers
3. `cargo check --manifest-path src-tauri/Cargo.toml`
   - result: pass
   - notes: verified the destroy routing refactor compiled with only pre-existing warnings
4. `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "routes session-scoped socket commands through the session receiver"`
   - result: pass
   - notes: verified `shell_destroy` and `browser_destroy` now appear as session-targeted wrapper deliveries in the focused session-receiver flow
5. `npm run check`
   - result: pass
   - notes: verified the updated TypeScript test surface
6. `cargo test --manifest-path src-tauri/Cargo.toml network::tests`
   - result: pass
   - notes: verified the `responds_to` surface no longer exposes tile-level `destroy`
7. `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "enforces worker local-network permissions at the backend"`
   - result: pass
   - notes: verified worker-visible tile capabilities and generic destroy rejection after removing tile-level `destroy`
8. `git diff --check`
   - result: pass
   - notes: confirmed patch hygiene
