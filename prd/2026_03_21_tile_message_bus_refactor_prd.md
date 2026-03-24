# Tile Message Bus Refactor PRD

## Status

Completed

## Date

2026-03-21

## Context

Herd's socket server currently dispatches most commands directly inside one large `match` in `src-tauri/src/socket/server.rs`. Tile-targeted operations such as `shell_*`, `browser_*`, and `tile_call` bypass a shared message-delivery layer, and discovery currently exposes `allowed_actions` schemas instead of a simpler receiver-oriented surface. The user wants all socket-facing operations to flow through one message interface with clear delivery logging, with tile-type implementations owning their tool-specific execution details.

## Goals

1. Introduce one internal message bus for socket-facing operations.
2. Route every tile-targeted command through a tile receiver interface with `send(...)` and `responds_to(...)` semantics.
3. Keep public socket, CLI, and MCP commands available, but convert them into wrappers over the bus.
4. Replace `allowed_actions` with `responds_to: string[]` everywhere tiles are described.
5. Add structured tile-message logging that records the origin channel: `cli`, `socket`, `mcp`, or `internal`.
6. Make `tile_send` and `tile_call` exact aliases over the same generic tile message path.
7. Expose tile-message logs through the current debug snapshot so the app can inspect them.

## Non-goals

1. Keeping the old direct-dispatch tile path alive alongside the bus.
2. Exposing new legacy compatibility surfaces beyond the requested aliases.
3. Changing the existing root-vs-worker permission model beyond routing it through the bus.
4. Building a new dedicated UI for tile-message logs in this change.

## Scope

In scope:
- Socket protocol updates for `tile_send` and receiver-style routing
- Shared tile discovery shape updates across Rust, CLI, MCP, tests, and TypeScript
- A new backend tile-message dispatcher and receiver implementation
- Structured tile-message persistence and debug snapshot exposure
- Routing existing socket commands through pseudo-target receivers where no concrete tile target exists
- Docs and focused regressions for the new bus-based model

Out of scope:
- New end-user UI beyond carrying the extra debug data
- Non-socket Tauri command redesign unrelated to this bus
- Expanding worker permissions outside the current local-network model

## Risks And Mitigations

1. The refactor could leave a half-bus, half-direct server path.
   - Mitigation: remove the direct tile dispatch while landing the bus and make wrapper commands call the bus immediately.
2. Replacing `allowed_actions` could break MCP guidance, tests, and typed clients.
   - Mitigation: change the shared shape in one pass and update every caller in the same change.
3. Logging every message could create persistence or emission drift.
   - Mitigation: add a dedicated tile-message log type with unit coverage and feed it through the existing debug snapshot path.
4. Root-only vs worker-local permission checks could regress during routing changes.
   - Mitigation: keep permissions in the wrapper-to-bus translation layer and add targeted integration coverage for worker-local `tile_call` and root-only wrappers.

## Acceptance Criteria

1. `network_list`, `network_get`, `session_list`, `tile_list`, and `tile_get` return tile objects with `responds_to: string[]` instead of `allowed_actions`.
2. `tile_call` and `tile_send` are exact aliases over one generic tile message path.
3. Existing wrapper commands such as `shell_input_send`, `shell_exec`, `browser_navigate`, `browser_load`, `tile_move`, and `tile_resize` route through the message bus before tile-specific execution happens.
4. Non-tile socket commands also use the same bus abstraction through pseudo-target receivers.
5. Tile receivers own the actual tmux/browser/work/message execution details, and socket command handlers no longer directly talk to those backends for tile-targeted work.
6. Every bus delivery attempt is logged with session id, channel, target id, target kind, wrapper command, receiver message name, args payload, outcome, error text when present, and duration.
7. Debug snapshot payloads include tile-message logs for the active session.
8. Worker generic tile messaging remains limited to visible local-network tiles, and root generic tile messaging can reach any tile in the current session.
9. CLI, MCP, Rust tests, and targeted integration checks pass for the updated surface.

## Phased Plan

### Phase 1: Public Surface Red/Green

#### Objective

Replace the old discovery/action-schema surface with receiver-style discovery and add the alias protocol needed by the bus.

#### Red

1. Update or add tests that expect `responds_to` instead of `allowed_actions`.
2. Add failing coverage for the `tile_send` alias in CLI/MCP/protocol-adjacent tests.

Expected failure signal:
- tile discovery assertions still reference `allowed_actions`
- `tile_send` is missing from protocol/CLI/MCP surfaces

#### Green

1. Replace `allowed_actions` with `responds_to` in Rust tile structs, TypeScript types, CLI fixtures, MCP docs/tool text, and integration assertions.
2. Add `tile_send` as an alias of `tile_call` across socket, CLI, and MCP.

Verification commands:
- `cargo test --manifest-path src-tauri/Cargo.toml cli::tests`
- `cargo test --manifest-path src-tauri/Cargo.toml network::tests`
- `npx vitest run --root mcp-server src/index.test.ts`

#### Exit Criteria

1. No public tile shape uses `allowed_actions`.
2. `tile_send` exists anywhere `tile_call` is intentionally exposed.

### Phase 2: Dispatcher And Tile Logging Red/Green

#### Objective

Introduce the internal bus, tile receivers, pseudo-receivers, and structured tile-message logging, then route socket commands through that layer.

#### Red

1. Add backend tests for receiver discovery, unsupported-message handling, and tile-message log persistence.
2. Add or update integration coverage to prove worker-local tile messaging still works through the generic path.

Expected failure signal:
- no tile-message log entries are produced
- direct socket handlers still bypass the bus
- unsupported messages do not produce the expected not-found/error behavior

#### Green

1. Add a tile-message dispatcher module with:
   - receiver resolution
   - `responds_to(...)`
   - `send(...)`
   - structured delivery logging
2. Add concrete tile receivers for shell/browser/other tile kinds and pseudo-receivers for non-tile socket groups.
3. Route socket handlers through the dispatcher so wrapper commands become thin translators over the bus.
4. Persist and expose tile-message logs through `AppState` and the debug snapshot.

Verification commands:
- `cargo test --manifest-path src-tauri/Cargo.toml`
- `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "enforces worker message-only permissions at the backend"`

#### Exit Criteria

1. Direct tile execution no longer lives in socket command handlers.
2. Structured tile-message logs are persisted and queryable.

### Phase 3: Wrapper Parity, Docs, And Regression Verification

#### Objective

Finish the wrapper conversions, update docs, and verify the bus-backed surface end to end.

#### Red

1. Keep focused wrapper/integration assertions failing until the final wrappers are routed through the bus and docs match the new discovery surface.

Expected failure signal:
- docs still describe `allowed_actions`
- wrapper commands succeed without appearing in tile-message logs

#### Green

1. Convert remaining CLI/MCP/socket wrapper text and docs to the bus model.
2. Verify the final targeted command set and record results in the command log.
3. Mark this PRD completed only after focused checks are green or any residual known failure is explicitly documented.

Verification commands:
- `npm --prefix mcp-server run build`
- `npm run check`
- focused `npm run test:integration -- ...`

#### Exit Criteria

1. Docs match the receiver-based surface.
2. Verification is recorded and the PRD status reflects the final outcome.

## Implementation Checklist

- [x] Phase 1 PRD saved
- [x] Phase 1 public surface complete
- [x] Phase 2 dispatcher and logging complete
- [x] Phase 3 wrapper/docs verification complete
- [x] Documentation/status updated

## Command Log

1. `sed -n '1,240p' /Users/skryl/.codex/skills/phased-prd-red-green/references/prd_red_green_template.md`
   - result: pass
   - notes: confirmed the required PRD structure and red/green phase format
2. `rg -n "allowed_actions|tile_call|network_get|agent_log|snapshot_agent_debug_state_for_session|SocketCommand::Tile|network_list|session_list|tile_list|tile_get|tile_move|tile_resize|shell_input_send|browser_navigate" src-tauri/src mcp-server/src src/lib tests/integration`
   - result: pass
   - notes: identified all current discovery, wrapper, and test touchpoints for the refactor
3. `sed -n '1320,2295p' src-tauri/src/socket/server.rs`
   - result: pass
   - notes: confirmed the current direct-dispatch path that will be replaced by the bus
4. `cargo test --manifest-path src-tauri/Cargo.toml cli::tests`
   - result: pass
   - notes: verified the CLI surface after replacing `allowed_actions` with `responds_to` and adding `tile_send`
5. `cargo test --manifest-path src-tauri/Cargo.toml network::tests`
   - result: pass
   - notes: verified the shared tile shape and network/session filtering updates
6. `cargo test --manifest-path src-tauri/Cargo.toml persist::tests`
   - result: pass
   - notes: verified tile-message log persistence and round-trip loading
7. `npx vitest run --root mcp-server src/index.test.ts`
   - result: pass
   - notes: verified the MCP worker/root tool surfaces including `tile_send`
8. `npm run check`
   - result: pass
   - notes: verified the frontend/store type updates for `responds_to` and `tile_message_logs`
9. `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "lists, gets, moves, and resizes tiles for root"`
   - result: pass
   - notes: verified root session-wide generic tile access, wrapper parity, and socket log visibility
10. `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "enforces worker local-network permissions at the backend"`
   - result: pass
   - notes: verified workers remain limited to the non-destructive local-network tile message subset
11. `cargo check --manifest-path src-tauri/Cargo.toml`
   - result: pass with pre-existing warnings
   - notes: confirmed the final Rust build after the permission fix and doc alignment
