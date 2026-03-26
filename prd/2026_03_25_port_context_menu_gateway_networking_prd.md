# Port Context Menus and Gateway Networking PRD

## Header

1. Title: Port context menus, per-port settings, and gateway-aware networking
2. Status: Completed
3. Date: 2026-03-25

## Context

Herd currently treats port access as a tile-kind default and has no per-port configuration surface. Ports can be dragged to connect and disconnect, but they cannot be configured directly in the UI. Network visibility, `network_call`, and `message_network` all use the same plain connected-component traversal with no concept of a gateway boundary.

The requested behavior adds:

- right-click port context menus
- per-port `Access` and `Networking` settings
- visual port status lights
- gateway-aware network traversal that stops automatic propagation at the gateway tile

## Goals

- Let users right-click any visible port and change `Access` between `Read` and `Read/Write`.
- Let users right-click any visible port and change `Networking` between `Broadcast` and `Gateway`.
- Render two indicator lights per port:
  - left red when the port is effectively read-only
  - right orange when the port is a gateway
- Persist sparse per-port overrides by session and tile.
- Make `network_list`, `network_get`, `network_call`, and `message_network` respect gateway-aware traversal.
- Keep the gateway tile itself able to see all networks directly attached to its own ports so it can decide whether to forward.

## Non-goals

- No new CLI or socket write APIs for port settings in this pass.
- No automatic bridging or policy engine that forwards across gateways on behalf of a tile.
- No change to raw wire rendering or raw connection storage beyond attaching port metadata.
- No sender-port identity model for agents or tiles.

## Scope

In scope:

- SQLite persistence for per-port settings
- backend access and gateway traversal logic
- Tauri command for UI port setting mutation
- frontend port context menu and light rendering
- targeted unit and integration coverage
- docs updates for the new behavior

Out of scope:

- MCP or socket commands to mutate port settings directly
- per-message forwarding policies on tiles
- protocol changes that require agents to specify an egress port when sending

## Risks and mitigations

- Risk: gateway-aware traversal can accidentally break direct ownership or access rules.
  - Mitigation: keep direct-edge ownership logic separate from traversal and cover with targeted tests.
- Risk: right-click handling can interfere with drag-connect behavior.
  - Mitigation: add a dedicated port context-menu path and preserve left-button-only drag behavior.
- Risk: per-port overrides can leave invalid existing connections behind.
  - Mitigation: disconnect now-invalid `read` to `read` edges immediately when access settings change.
- Risk: sender-visible network semantics become ambiguous for gateway tiles.
  - Mitigation: define and test the tile-as-router viewpoint explicitly.

## Acceptance criteria

- Right-clicking a port opens a context menu with `Access > Read | Read/Write` and `Networking > Broadcast | Gateway`.
- Ports show a red left indicator when effective access is `read`.
- Ports show an orange right indicator when networking mode is `gateway`.
- Default networking mode is `broadcast`.
- Changing access persists and updates drag-connect validation immediately.
- Changing access disconnects live edges that become invalid.
- Changing gateway mode persists and changes network visibility and message propagation as specified.
- A tile reached through a gateway port is visible/reachable, but automatic traversal does not continue beyond that tile.
- The gateway tile itself can still see tiles on each directly attached segment.

## Phased Plan (Red/Green)

### Phase 1: Backend persistence and traversal

1. Objective
   - Add persisted port settings and gateway-aware network traversal in the Rust/backend layer.
2. Red
   - Add failing unit tests for:
     - per-port default plus override access resolution
     - persisted sparse settings round-trip
     - gateway-aware sender reachability
     - `message_network` stopping at the gateway tile
   - Expected failure signal
     - missing schema/helpers
     - traversal still returns the full connected component
3. Green
   - Add `tile_port_setting` storage.
   - Add backend helpers for effective port access and networking mode.
   - Replace plain connected-component sender traversal where sender-visible network behavior is computed.
   - Add a Tauri command for setting port settings and disconnect invalid edges on access downgrade.
   - Verification commands
     - targeted `cargo test` for network and command cases
4. Exit criteria
   - backend tests pass and sender-visible traversal matches the requested gateway rules

### Phase 2: Frontend port UI and state wiring

1. Objective
   - Expose the per-port settings in the UI and render the new indicators.
2. Red
   - Add failing frontend tests for:
     - port right-click menu content
     - selected menu state for access and networking
     - red/orange indicator rendering
     - live disconnect on invalid access change
   - Expected failure signal
     - no port context menu target
     - missing indicators or stale state
3. Green
   - Extend context-menu state/projection for port targets.
   - Add right-click handling in `TilePorts`.
   - Add the two submenu groups and wire selection to the new Tauri command.
   - Render the two per-port lights and reflect effective port settings in classes/data attributes.
   - Verification commands
     - targeted Vitest for app state and UI behavior
4. Exit criteria
   - UI updates correctly without breaking left-button drag connect/disconnect

### Phase 3: Integration, route animation, and docs

1. Objective
   - Verify the end-to-end behavior in integration tests and update docs/status.
2. Red
   - Add failing integration tests for:
     - port context menu selection through the test driver
     - gateway-aware `network_list`
     - gateway-aware `network_call`
     - gateway-aware `message_network`
   - Expected failure signal
     - old full-component behavior still visible
3. Green
   - Add any missing projection/test-driver plumbing.
   - Update the frontend route animation helper to use gateway-aware sender-visible paths.
   - Update docs and mark this PRD completed.
   - Verification commands
     - targeted frontend, backend, and integration suites
4. Exit criteria
   - all targeted checks are green and docs match shipped behavior

## Execution Checklist

- [x] Phase 1 complete
- [x] Phase 2 complete
- [x] Phase 3 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log

1. `git status --short`
   - result: pass
   - notes: confirmed existing unrelated dirty files before implementation
2. `sed -n '1,220p' /Users/skryl/.codex/skills/phased-prd-red-green/SKILL.md`
   - result: pass
   - notes: loaded required workflow guidance
3. `sed -n '1,220p' /Users/skryl/.codex/skills/phased-prd-red-green/references/prd_red_green_template.md`
   - result: pass
   - notes: loaded template for phased PRD structure
4. `cargo test --manifest-path src-tauri/Cargo.toml network::tests -- --nocapture`
   - result: pass
   - notes: verified sparse port settings, access resolution, and gateway-aware traversal
5. `npx vitest run src/lib/stores/appState.test.ts src/lib/tilePorts.test.ts`
   - result: pass
   - notes: verified frontend state wiring, context-menu state, and port drag validation
6. `npx vitest run --config vitest.integration.config.ts tests/integration/test-driver.test.ts -t "opens and dismisses typed context menus for the canvas and the selected tile|updates port settings from the port context menu, lights the indicators, and disconnects invalidated edges|applies gateway traversal rules to sender-visible network_list and network_call"`
   - result: pass
   - notes: verified test-driver port menu flow, indicator updates, access-triggered disconnect behavior, and gateway-aware network visibility/call routing
7. `git diff --check -- src-tauri/src/db.rs src-tauri/src/network.rs src-tauri/src/agent.rs src-tauri/src/state.rs src-tauri/src/socket/server.rs src-tauri/src/commands.rs src-tauri/src/lib.rs src/lib/types.ts src/lib/tauri.ts src/lib/stores/appState.ts src/lib/TilePorts.svelte src/lib/ContextMenu.svelte src/lib/testDriver.ts src/lib/stores/appState.test.ts tests/integration/client.ts tests/integration/test-driver.test.ts docs/architecture.md docs/socket-and-test-driver.md prd/2026_03_25_port_context_menu_gateway_networking_prd.md`
   - result: pass
   - notes: verified no whitespace or patch formatting issues in touched files
