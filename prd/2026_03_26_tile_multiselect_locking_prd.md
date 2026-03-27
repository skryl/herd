# Tile Multi-Select and Locking PRD

## Header

1. Title: tile multi-select, locking, and lock-aware arrange behavior
2. Status: Complete
3. Date: 2026-03-26

## Context

Herd currently treats tile selection as a single selected pane or single selected work item. Tile context menus are also single-tile only, and tile layout persistence stores geometry without any lock state. That leaves a few gaps:

- users cannot shift-select multiple tiles
- tile context menus cannot act on a multi-selection
- there is no way to lock tiles in place
- auto-arrange moves every eligible tile, even if the user wants some positions preserved
- lock state is not persisted with the rest of the session layout state

The requested behavior adds click selection, additive shift-click selection, lock/unlock actions in tile context menus, lock-aware arrange behavior, persisted lock state, and a visible lock indicator in tile chrome.

## Goals

- Clicking a tile selects it.
- Shift-clicking tiles allows multi-select.
- When multiple tiles are selected, the tile context menu shows only `Close` and `Lock`/`Unlock`.
- Single-tile context menus also include `Lock`/`Unlock` immediately below `Close`.
- Locked tiles cannot be moved on the canvas until unlocked.
- Auto-arrange and ELK auto-arrange do not move locked tiles.
- Lock state persists in live layout storage and saved session configuration files.
- Locked tiles show a lock indicator in the top-left of their chrome.

## Non-goals

- No marquee or box selection in this pass.
- No resize lock; the requested lock only blocks position changes.
- No per-port or per-session lock controls.
- No redesign of the existing close confirmation model for root agents or last-window tab closes.

## Scope

In scope:

- frontend multi-select state and tile click handling
- tile and multi-select context-menu behavior
- lock/unlock state in live layout persistence and saved sessions
- lock-aware drag and keyboard movement blocking
- lock-aware auto-arrange / ELK arrange behavior
- tile chrome lock indicators
- targeted unit, Rust, and integration coverage

Out of scope:

- selection rectangles
- resize locking
- drag-moving multiple selected tiles together
- new socket or MCP tile-lock mutation APIs

## Risks and mitigations

- Risk: many code paths mutate `selectedPaneId` / `selectedWorkId` directly and could leave multi-select state inconsistent.
  - Mitigation: add explicit selection helpers and cover the main selection flows with tests.
- Risk: adding `locked` to persisted layout could break existing saved sessions.
  - Mitigation: default missing `locked` to `false` in Rust and TypeScript.
- Risk: batch close for multi-select can conflict with existing root-agent or last-window close confirmation logic.
  - Mitigation: keep single-tile close behavior unchanged and disable batch close when the selection includes tiles that require confirmation semantics.
- Risk: arrange changes can still displace locked tiles indirectly.
  - Mitigation: seed arrange occupancy with locked tiles and verify both normal and ELK arrange with tests.

## Acceptance criteria

- A normal tile click selects only that tile.
- A shift-click adds the clicked tile to the current selection.
- Right-clicking one of several selected tiles shows only `Close` and `Lock`/`Unlock`.
- Right-clicking a single tile shows `Close` followed by `Lock`/`Unlock`, plus the tile’s normal extra actions.
- Locked tiles do not move when dragged or when keyboard move commands target them.
- Auto-arrange and ELK arrange leave locked tiles at their current positions.
- Layout persistence round-trips `locked` state through SQLite and saved session JSON.
- Locked panes and work cards show a lock indicator in the tile chrome.

## Phased Plan (Red/Green)

### Phase 1: Selection model and lock persistence

1. Objective
   - Add multi-select state and persisted `locked` layout state.
2. Red
   - Add failing tests for:
     - additive shift-selection
     - context-menu selection payload for multi-select
     - SQLite tile-state round-trip with `locked`
     - saved-session config default/round-trip behavior for `locked`
   - Expected failure signal
     - single-select-only state and missing `locked` fields
3. Green
   - Extend UI state for selected tile ids.
   - Extend layout persistence types/storage with `locked`.
   - Keep legacy saved layouts loading with `locked = false`.
   - Verification commands
     - targeted Vitest and `cargo test`
4. Exit criteria
   - selection state and persistence primitives exist and tests pass

### Phase 2: Tile UI, context menus, and movement guards

1. Objective
   - Wire multi-select and locking into the tile UI.
2. Red
   - Add failing tests for:
     - single vs multi tile context-menu contents
     - lock/unlock action behavior
     - drag / keyboard move no-op on locked tiles
     - lock indicator rendering
   - Expected failure signal
     - context menu still single-tile only and locked tiles still move
3. Green
   - Update tile click and right-click handling.
   - Add lock/unlock actions for single and multi selections.
   - Prevent dragging / move-selected operations on locked tiles.
   - Render lock indicators on tile chrome.
   - Verification commands
     - targeted Vitest and integration tests
4. Exit criteria
   - UI behavior matches the request and movement guards are enforced

### Phase 3: Arrange behavior and regression coverage

1. Objective
   - Make arrange operations respect locked tiles and close out the feature.
2. Red
   - Add failing tests for:
     - regular auto-arrange preserving locked tile positions
     - ELK auto-arrange preserving locked tile positions
     - saved-session load preserving locked tiles
   - Expected failure signal
     - arrange rewrites locked positions
3. Green
   - Update arrange logic to treat locked tiles as fixed anchors/obstacles.
   - Persist lock state through load/save flows.
   - Update PRD status and command log.
   - Verification commands
     - targeted frontend, Rust, and integration suites
4. Exit criteria
   - arrange no longer moves locked tiles and the full requested feature is verified

## Execution Checklist

- [x] Phase 1 complete
- [x] Phase 2 complete
- [x] Phase 3 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log

1. `sed -n '1,220p' /Users/skryl/.codex/skills/phased-prd-red-green/SKILL.md`
   - result: pass
   - notes: loaded workflow instructions
2. `sed -n '1,220p' /Users/skryl/.codex/skills/phased-prd-red-green/references/prd_red_green_template.md`
   - result: pass
   - notes: loaded PRD template
3. `npx vitest run src/lib/stores/appState.test.ts -t "opens a pane context menu|collapses tile context menus|does not move a locked selected tile|does not move locked tiles during regular auto-arrange|does not move locked tiles during elk auto-arrange"`
   - result: fail
   - notes: red step confirmed stale menu target expectations and missing lock-aware behavior
4. `cargo test --manifest-path src-tauri/Cargo.toml tile_state_round_trips_through_sqlite -- --nocapture`
   - result: pass
   - notes: SQLite tile-state persistence round-trips `locked`
5. `cargo test --manifest-path src-tauri/Cargo.toml defaults_legacy_saved_tile_lock_state_to_false -- --nocapture`
   - result: pass
   - notes: legacy saved session configs default missing `locked` to `false`
6. `npm run check`
   - result: pass
   - notes: frontend/test-driver TypeScript and Svelte checks clean after selection/test-driver updates
7. `npx vitest run src/lib/stores/appState.test.ts`
   - result: pass
   - notes: full app-state unit coverage green
8. `cargo check --manifest-path src-tauri/Cargo.toml`
   - result: pass
   - notes: Rust compile clean after persistence and protocol updates
9. `npx vitest run --config vitest.integration.config.ts tests/integration/test-driver.test.ts -t "supports shift multi-select and lock/unlock through the tile context menu"`
   - result: pass
   - notes: integration verifies shift-select, restricted multi-select menu, lock indicators, and drag blocking
