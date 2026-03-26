## Title

Centered Tile Drawer Grip

## Status

Completed

## Date

2026-03-24

## Context

Tile bottom drawers now have resize grips, but the user wants the three-dot handle visually centered in the drawer title bar. The browser text preview drawer must also expose the same centered grip, not just the shared activity drawer.

## Goals

1. Center the three-dot grip in the title bar of the shared activity drawer.
2. Center the three-dot grip in the title bar of the browser text preview drawer.
3. Keep both drawers resizable with the same interaction as before.

## Non-goals

1. Changing drawer resize semantics.
2. Reworking any non-drawer tile headers.

## Scope

1. `TileActivityDrawer.svelte`
2. `BrowserTextPreviewDrawer.svelte`
3. Focused UI regression assertions for centered placement plus resize behavior

## Risks and mitigations

1. Centering the grip could overlap header content.
   - Mitigation: reserve padding in the header and position the grip absolutely.
2. The text preview drawer could accidentally lose its grip during the refactor.
   - Mitigation: assert presence and centered placement in the browser preview UI test.

## Acceptance criteria

1. The shared activity drawer grip is centered in the header.
2. The browser text preview drawer grip is centered in the header.
3. Both drawers still resize vertically.

## Phased Plan (Red/Green)

### Phase 0

1. Objective
   - Add failing UI assertions for centered grip placement.
2. Red
   - Extend the activity and browser preview integration tests to assert the grip exists and its center aligns with the header center.
   - Expected failure signal: grip center mismatch.
3. Green
   - Update both drawer headers to center the grip while preserving resize behavior.
4. Exit criteria
   - Focused tests pass for both presence and centered placement.

### Phase 1

1. Objective
   - Re-run adjacent checks and finish bookkeeping.
2. Red
   - Catch any Svelte/layout regressions from the header changes.
3. Green
   - Run targeted integration/type checks and close the PRD.
4. Exit criteria
   - Checks pass and the PRD is marked completed.

## Execution Checklist

- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log

1. `sed -n '1,220p' src/lib/TileActivityDrawer.svelte`
   - result: pass
   - notes: confirmed the grip exists but is right-aligned in the shared activity drawer
2. `sed -n '1,240p' src/lib/BrowserTextPreviewDrawer.svelte`
   - result: pass
   - notes: confirmed the preview drawer also has a grip, but it is not centered
3. `npm run test:integration -- tests/integration/test-driver.test.ts -t "surfaces agent messaging activity in the per-pane activity projection"`
   - result: pass
   - notes: shared activity drawer grip is present, centered, and still resizes
4. `npm run test:integration -- tests/integration/test-driver.test.ts -t "shows a live browser DOM text preview immediately left of the activity toggle"`
   - result: pass
   - notes: browser text preview drawer grip is present, centered, and still resizes
5. `npm run check`
   - result: pass
   - notes: frontend type/Svelte checks passed cleanly
6. `git diff --check -- src/lib/TileActivityDrawer.svelte src/lib/BrowserTextPreviewDrawer.svelte tests/integration/test-driver.test.ts prd/2026_03_24_centered_tile_drawer_grip_prd.md`
   - result: pass
   - notes: changed files are whitespace-clean
