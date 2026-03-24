## Title
Layered Dispatch Logging And Unified Tile Activity

## Status
Completed

## Date
2026-03-23

## Context
Herd already persists `tile_message_logs`, `agent_logs`, and chatter, but the coverage is incomplete relative to the current receiver architecture. Socket commands are logged once, receiver deliveries are not consistently logged as a separate layer, `network_call` does not have its own interface-layer log, and the canvas UI only exposes an agent-only activity panel inside terminal tiles. The user wants three explicit logging layers, DB-backed logs for those layers, unified per-tile activity for every tile type, and a Debug pane control to clear all logs.

## Goals
- Log every socket command in the DB.
- Log every receiver delivery in the DB for tile, session, and herd receivers.
- Log `network_call` as its own interface layer in the DB.
- Replace the agent-only activity panel with a unified per-tile activity log UI for terminal, browser, and work tiles.
- Include agent chatter and agent log traffic in the unified per-tile activity surface.
- Add a Debug pane button that clears all persisted logs and the visible tailed log buffers.

## Non-goals
- Replacing the existing plain-text socket / control-mode log files.
- Reworking the receiver or permission architecture beyond what is needed for layered logging.
- Adding long-term persisted UI state for activity drawer open/closed state.

## Scope
- Rust socket logging helpers and receiver call sites
- Rust persisted log clearing
- Frontend tile activity derivation and shared UI
- Debug pane clear action
- Focused integration and store tests

## Risks And Mitigations
- Risk: nested logging could double-log in ambiguous places or miss one layer.
  - Mitigation: add explicit `layer` tagging and focused integration checks for socket, message, and network entries.
- Risk: tile activity matching could miss session-scoped operations that refer to tiles indirectly.
  - Mitigation: persist `related_tile_ids` alongside each log entry and use that for activity fan-out.
- Risk: the new unified UI could leave the old agent-only path behind.
  - Mitigation: replace `agent_activity_by_pane` with `tile_activity_by_id` in the same change.

## Acceptance Criteria
- Socket commands produce `tile_message_logs` entries tagged with `layer = socket`.
- Receiver deliveries produce `tile_message_logs` entries tagged with `layer = message` for session, tile, and herd receivers.
- `network_call` additionally produces `tile_message_logs` entries tagged with `layer = network`.
- Each tile activity drawer shows events involving that tile as sender or receiver, including agent chatter / agent log traffic for agent tiles.
- Terminal, browser, and work tiles expose an activity toggle button on their bottom border and render the same activity drawer pattern.
- The Debug pane has a `Clear Logs` button that clears persisted chatter, agent logs, tile message logs, and the visible tailed log output.

## Phased Plan (Red/Green)

### Phase 0
Objective: lock the layered logging model in tests.

Red:
- Extend focused integration coverage to assert explicit `layer` values for:
  - socket-level test-driver calls
  - session receiver calls
  - `network_call`
  - tile receiver deliveries reached through socket wrappers
- Expected failure signal:
  - logs only exist once per call
  - no `layer` tagging
  - no explicit `network` log for `network_call`

Green:
- Add `layer` and `related_tile_ids` to persisted tile-message log entries.
- Log nested receiver deliveries separately from socket wrappers.
- Log `network_call` at its own interface layer before the target tile receiver dispatch.

Verification commands:
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `npm run test:integration -- tests/integration/test-driver.test.ts -t "routes test socket commands through the herd receiver"`
- `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "routes session-scoped socket commands through the session receiver"`
- `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "enforces worker local-network permissions at the backend"`

Exit criteria:
- The focused integration checks prove the three logging layers and their target metadata.

### Phase 1
Objective: replace the agent-only activity model with unified tile activity.

Red:
- Replace the current agent-activity unit coverage with tile-activity expectations that include tile message logs.
- Add a focused UI integration that opens a tile activity drawer from the tile footer button.
- Expected failure signal:
  - only agent panes expose activity
  - browser and work tiles have no drawer button
  - tile message logs do not appear in tile activity output

Green:
- Introduce `tile_activity_by_id` and `buildTileActivityEntries`.
- Route terminal, browser, and work tiles through the same drawer UI.
- Remove the old `agent_activity_by_pane` projection field and store path.

Verification commands:
- `npx vitest run src/lib/stores/appState.test.ts`
- `npm run test:integration -- tests/integration/test-driver.test.ts -t "surfaces tile activity in the shared activity drawer UI"`

Exit criteria:
- All tile types expose the same activity affordance and show the expected per-tile events.

### Phase 2
Objective: clear all persisted logs from the Debug pane.

Red:
- Add a focused integration that creates chatter / tile-message activity, clicks `Clear Logs`, and waits for the projection to empty the log collections.
- Expected failure signal:
  - no Debug pane clear control
  - logs remain in projection after clear

Green:
- Add a backend clear-logs command that clears DB-backed log tables and truncates the tailed socket / cc files.
- Add the Debug pane button and reset its local tailed buffer offsets after success.

Verification commands:
- `npm run test:integration -- tests/integration/test-driver.test.ts -t "clears persisted logs from the debug pane"`
- `npm run check`
- `git diff --check`

Exit criteria:
- The visible debug data and the persisted log-backed projections clear together.

## Execution Checklist
- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Phase 2 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log
1. `rg -n "tile_message_logs|agent_logs|dispatch_with_log|Clear Logs|activity" src-tauri/src src/lib tests docs README.md`
   - result: pass
   - notes: confirmed the current split between DB-backed message logs, agent-only activity UI, and file-tailed debug logs.
2. `cargo check --manifest-path src-tauri/Cargo.toml`
   - result: pass
   - notes: layered logging changes compile; only pre-existing dead-code warnings remain.
3. `npm run test:integration -- tests/integration/test-driver.test.ts -t "routes test socket commands through the herd receiver"`
   - result: pass
   - notes: confirmed socket and message layer entries for herd receiver calls.
4. `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "routes session-scoped socket commands through the session receiver"`
   - result: pass
   - notes: confirmed session receiver calls emit both socket and message layer logs.
5. `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "enforces worker local-network permissions at the backend"`
   - result: pass
   - notes: confirmed network-call logging and worker-visible enforcement remain correct.
6. `npx vitest run src/lib/stores/appState.test.ts`
   - result: pass
   - notes: verified tile activity derivation, including tile-message log fan-out.
7. `npm run test:integration -- tests/integration/test-driver.test.ts -t "clears persisted logs from the debug pane"`
   - result: pass
   - notes: verified pre-clear persisted logs are removed while allowing fresh post-clear system traffic.
8. `npm run check`
   - result: pass
   - notes: frontend/UI changes typecheck and pass Svelte diagnostics.
9. `cargo test --manifest-path src-tauri/Cargo.toml persist::tests`
   - result: pass
   - notes: verified SQLite round-trips and `clear_log_entries` coverage, including full log-table clearing.
10. `git diff --check`
    - result: pass
    - notes: no whitespace or patch-formatting issues remain.
