# Tile Port Count Setting PRD

## Header

1. Title: Tile port count setting
2. Status: Completed
3. Date: 2026-03-25

## Context

Tiles currently expose exactly one connectable port per side, so every tile has four total network ports. The user wants a `Ports` control in the sidebar `SETTINGS` section, below `SPAWN DIR`, with toggles for `4`, `8`, `12`, and `16`. That value represents the total number of available ports per tile, which means `1`, `2`, `3`, or `4` ports per side. Supporting this requires changing port identity and geometry end to end; rendering extra sockets without unique port IDs would still leave the network model limited to one connection per side.

## Goals

1. Add a sidebar `Ports` setting with `4`, `8`, `12`, and `16` toggles and default it to `4`.
2. Expand the frontend and backend port model so tiles can carry up to four distinct ports per side.
3. Use the selected setting to determine which ports are available for new connections while still rendering existing higher-index occupied ports if the user lowers the setting.
4. Preserve existing work/browser left-side access rules by applying them to every left-side slot, not just one hard-coded port.

## Non-goals

1. Persisting the setting outside the current frontend app state.
2. Adding arbitrary per-side counts or values outside `4`, `8`, `12`, and `16`.
3. Changing the visual design of tiles beyond the extra port handles and the new sidebar control.

## Scope

1. Introduce a shared tile-port helper model for side/slot parsing, configured counts, and visible-port lists.
2. Update frontend connection geometry, snapping, drag/drop, ELK port generation, and tile port rendering to use the expanded port IDs.
3. Update backend parsing, storage, and connection validation so multi-slot ports round-trip through Tauri, socket, and CLI paths.
4. Add the `Ports` setting UI in the sidebar and connect it to the app-state source of truth.
5. Add focused helper, store, backend, and integration coverage.

## Risks and mitigations

1. Risk: changing port IDs could break existing stored connections or old tests.
   Mitigation: keep slot-1 ports serialized as the current plain side names (`left`, `top`, `right`, `bottom`) and only add suffixed IDs for higher slots.
2. Risk: lowering the configured port count could hide connected ports and strand wires.
   Mitigation: always render any occupied higher-slot ports in addition to the configured available ports.
3. Risk: work/browser controller semantics currently key off the left port.
   Mitigation: apply left-side access logic to all left-side slots and keep owner/controller lookup based on the left side, not just a single variant.

## Acceptance criteria

1. The sidebar `SETTINGS` section shows a `Ports` control below `SPAWN DIR` with `4`, `8`, `12`, and `16` toggles.
2. New app state defaults the tile port count to `4`.
3. Setting `4`, `8`, `12`, or `16` exposes `1`, `2`, `3`, or `4` ports per side for new connections.
4. Network drag/connect/disconnect logic can address higher-slot ports as distinct endpoints.
5. Existing occupied higher-slot ports remain visible after lowering the configured port count.
6. Targeted frontend, backend, and integration tests pass.

## Phased Plan (Red/Green)

### Phase 0

1. Objective
   - Lock the new port-count contract with failing helper/store/integration tests.
2. Red
   - Add helper tests for count-to-port expansion and side/slot parsing.
   - Add store tests for multi-slot geometry and connection behavior.
   - Add a sidebar/integration check for the new `Ports` control and default selection.
   - Expected failure signal: missing helper module, missing setting UI, or connection logic still treating an entire side as a single port.
3. Green
   - Implement the smallest shared port helper and UI state changes needed to make those tests pass.
   - Verification commands:
     - `npx vitest run src/lib/tilePorts.test.ts src/lib/stores/appState.test.ts`
     - `npx vitest run --config vitest.integration.config.ts tests/integration/test-driver.test.ts -t "ports setting"`
4. Exit criteria
   - Tests fail first against the old four-port model, then pass with the new count contract.

### Phase 1

1. Objective
   - Update backend/network plumbing for multi-slot ports and verify round-tripping.
2. Red
   - Add backend tests for parsing and connecting higher-slot ports.
   - Expected failure signal: invalid port parsing or backend connection validation still limited to one port per side.
3. Green
   - Implement backend port parsing/serialization and connection validation updates.
   - Verification commands:
     - `cargo test --manifest-path src-tauri/Cargo.toml network`
4. Exit criteria
   - Higher-slot ports round-trip through backend parsing and connection validation.

### Phase 2

1. Objective
   - Finalize evidence and regression coverage.
2. Red
   - N/A beyond re-running focused checks.
3. Green
   - Re-run focused checks, update the PRD checklist/status, and record command outcomes.
   - Verification commands:
     - Re-run focused commands from previous phases.
4. Exit criteria
   - Checklist is complete and the PRD is marked completed.

## Execution Checklist

- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Phase 2 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log

1. `sed -n '1,220p' /Users/skryl/.codex/skills/phased-prd-red-green/SKILL.md`
   - result: pass
   - notes: loaded required skill workflow
2. `sed -n '1,220p' /Users/skryl/.codex/skills/phased-prd-red-green/references/prd_red_green_template.md`
   - result: pass
   - notes: loaded PRD template
3. `rg -n "spawn dir|Spawn Dir|ports per side|port count|available ports|portCount|ports setting|Settings menu|sidebar" src tests extensions -g'!*dist*'`
   - result: pass
   - notes: located the sidebar settings surface and initial UI entry points
4. `rg -n "type TilePort|parse_port\\(|PortId|from_port: TilePort|to_port: TilePort|TilePort\\b" src/lib src-tauri tests -g'*.ts' -g'*.rs' -g'*.svelte'`
   - result: pass
   - notes: confirmed the network model still treats a whole side as a single port today
5. `npx vitest run src/lib/tilePorts.test.ts src/lib/stores/appState.test.ts`
   - result: fail, then pass
   - notes: initial red run failed on the missing shared helper, missing `tilePortCount` UI state, and side-only higher-slot behavior; green rerun passed with 91/91 tests
6. `cargo test --manifest-path src-tauri/Cargo.toml network`
   - result: fail, then pass
   - notes: initial red run failed because higher-slot `TilePort` variants did not exist; green rerun passed with 16/16 network-related tests
7. `npx vitest run --config vitest.integration.config.ts tests/integration/test-driver.test.ts -t "shows a Ports setting below spawn dir and updates the selected tile port count"`
   - result: pass
   - notes: verified the sidebar `Ports` setting order, default `4`, and visible tile-port count change to `12`
8. `git diff --check -- src/lib/types.ts src/lib/tilePorts.ts src/lib/tilePorts.test.ts src/lib/stores/appState.ts src/lib/stores/appState.test.ts src/lib/TilePorts.svelte src/lib/Sidebar.svelte src/lib/wireCurves.ts src/lib/wireRouting.ts src-tauri/src/network.rs tests/integration/test-driver.test.ts prd/2026_03_25_tile_port_count_setting_prd.md`
   - result: pass
   - notes: confirmed no whitespace or patch-format issues in the touched files
