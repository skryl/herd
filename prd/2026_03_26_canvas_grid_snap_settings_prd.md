# Canvas Grid Snap Settings PRD

## Header

1. Title: canvas grid snap toggle and snap-size settings
2. Status: Completed
3. Date: 2026-03-26

## Context

Herd currently hard-codes a `20px` tile snap grid in the frontend layout logic. Tile placement, overlap resolution, and some arrange paths always snap, with no user control in the settings sidebar. That makes it impossible to switch tiles to free-floating canvas positioning or to change the snap granularity.

## Goals

- Add a `SNAP TO GRID` setting in the settings sidebar, enabled by default.
- Add a `GRID SIZE` selector directly below it to control snap granularity.
- Keep the current `20px` grid as the default size.
- When snapping is enabled, tile movement and placement snap to the chosen grid size.
- When snapping is disabled, tiles move and place freely on the canvas.

## Non-goals

- No visual background grid rendering in this pass.
- No persistence beyond the current in-memory UI settings model unless already implied by existing settings behavior.
- No backend/socket/MCP surface for changing snap settings.

## Scope

In scope:

- UI state and store slices for snap toggle and grid size
- settings sidebar controls and help text
- tile drag/work-card drag snapping behavior
- frontend tile placement helpers that currently use the hard-coded snap value
- targeted unit and integration coverage

Out of scope:

- background grid drawing
- backend layout snapping configuration
- changing network-port snap radius behavior

## Risks and mitigations

- Risk: different placement paths could drift and apply different snapping rules.
  - Mitigation: route drag and placement paths through the same snap helper.
- Risk: free-floating mode could accidentally keep snapping in overlap placement or spawn placement.
  - Mitigation: cover both enabled and disabled behavior with unit tests.
- Risk: settings sidebar regressions could break existing settings tests.
  - Mitigation: update the existing settings integration coverage instead of adding a separate disconnected test.

## Acceptance criteria

- `SNAP TO GRID` appears in the settings sidebar and defaults to `ON`.
- `GRID SIZE` appears directly below it and defaults to `20`.
- Dragging a tile or work card snaps to the selected grid size when snapping is enabled.
- Dragging a tile or work card moves freely when snapping is disabled.
- Placement helpers no longer force snapping when the toggle is off.
- The settings sidebar integration reflects the new controls and can change them.

## Phased Plan (Red/Green)

### Phase 0: Settings state and red coverage

1. Objective
   - Define the UI state shape and failing tests for the new settings.
2. Red
   - Add failing tests for:
     - default snap toggle and size values
     - drag snapping when enabled
     - free-floating drag when disabled
     - settings sidebar showing the new controls
   - Expected failure signal
     - missing UI state fields and unchanged hard-coded `20px` snapping
3. Green
   - Add state fields, exported slices, and settings sidebar controls.
   - Verification commands
     - targeted Vitest and `npm run check`
4. Exit criteria
   - new settings exist with correct defaults and UI controls

### Phase 1: Snap helper integration

1. Objective
   - Route tile movement and placement through the new snap configuration.
2. Red
   - Run targeted unit tests against drag and placement helpers.
   - Expected failure signal
     - movement still always snaps to `20px`
3. Green
   - Replace the hard-coded snap helper with a configurable helper used by drag and placement logic.
   - Verification commands
     - targeted Vitest
4. Exit criteria
   - snapping behavior matches the toggle and size selection

### Phase 2: Integration coverage and closeout

1. Objective
   - Verify the settings sidebar flow end to end.
2. Red
   - Add/update integration test coverage for the new settings card behavior.
   - Expected failure signal
     - settings UI missing controls or drag behavior unchanged after toggling
3. Green
   - Update integration assertions and close the PRD.
   - Verification commands
     - targeted integration Vitest
5. Exit criteria
   - end-to-end settings behavior verified

## Execution Checklist

- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Phase 2 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log

1. `sed -n '1,220p' /Users/skryl/.codex/skills/phased-prd-red-green/SKILL.md`
   - result: pass
   - notes: loaded phased PRD workflow
2. `sed -n '1,220p' /Users/skryl/.codex/skills/phased-prd-red-green/references/prd_red_green_template.md`
   - result: pass
   - notes: loaded PRD template
3. `npx vitest run src/lib/stores/appState.test.ts -t "enables canvas grid snapping by default|snaps tile drags to the configured grid size when enabled|allows free-floating tile drags when snapping is disabled|allows free-floating work card drags when snapping is disabled|uses free-floating placement for new tiles when snapping is disabled"`
   - result: fail
   - notes: red step confirmed missing settings state and unchanged hard-coded snap behavior
4. `npm run check`
   - result: pass
   - notes: frontend compiles after adding state, helpers, and settings controls
5. `npx vitest run src/lib/stores/appState.test.ts -t "enables canvas grid snapping by default|snaps tile drags to the configured grid size when enabled|allows free-floating tile drags when snapping is disabled|allows free-floating work card drags when snapping is disabled|uses free-floating placement for new tiles when snapping is disabled"`
   - result: pass
   - notes: targeted grid snap unit coverage green
6. `npx vitest run src/lib/stores/appState.test.ts`
   - result: pass
   - notes: full app-state unit coverage green
7. `npx vitest run --config vitest.integration.config.ts tests/integration/test-driver.test.ts -t "shows canvas settings in the settings sidebar and lets you adjust snapping, ports, and wire sparks"`
   - result: pass
   - notes: end-to-end settings sidebar coverage includes snap toggle and grid size selector
