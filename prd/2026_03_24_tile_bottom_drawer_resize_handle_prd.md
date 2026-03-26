## Title

Tile Bottom Drawer Resize Handle

## Status

Completed

## Date

2026-03-24

## Context

Tile bottom drawers currently open at fixed heights. The debug pane already has a three-dot grip that lets the user resize it vertically, and the user wants the same affordance on all tile bottom drawers. In practice this applies to the shared tile activity drawer used by terminal, browser, and work tiles, plus the browser text preview drawer.

## Goals

1. Add a three-dot vertical resize grip to every tile bottom drawer.
2. Allow dragging the grip to resize the drawer up and down.
3. Keep the change shared across all activity drawers via the shared drawer component.
4. Preserve existing drawer toggle/open behavior.

## Non-goals

1. Resizing non-drawer tile content areas.
2. Reworking the overall tile layout model.
3. Leaving one-off drawer variants without the new handle.

## Scope

1. Shared activity drawer used by terminal, browser, and work tiles.
2. Browser text preview drawer.
3. Focused integration coverage for the new handle and resize behavior.

## Risks and mitigations

1. Drag events could interfere with tile dragging.
   - Mitigation: keep the handle inside the drawer header and stop propagation on grip mousedown.
2. Oversized drawers could crowd the tile body.
   - Mitigation: clamp drawer height to the available parent tile space.
3. The feature could regress existing drawer visibility behavior.
   - Mitigation: extend the existing activity and browser preview UI tests.

## Acceptance criteria

1. Every tile bottom drawer shows a three-dot resize handle.
2. Dragging the handle changes the drawer height.
3. Terminal/work/browser activity drawers all inherit the behavior through the shared activity drawer.
4. The browser text preview drawer also supports the same resize interaction.

## Phased Plan (Red/Green)

### Phase 0

1. Objective
   - Add failing UI coverage for drawer grips and resizing.
2. Red
   - Extend the existing activity drawer and browser preview integration tests to require a resize grip and a height change after dragging.
   - Expected failure signal: missing grip or unchanged drawer height.
3. Green
   - Implement the resize grip and drag behavior in both drawer components.
   - Verification commands: focused integration tests.
4. Exit criteria
   - Both integration checks pass and prove the drawers resize.

### Phase 1

1. Objective
   - Ensure the behavior is clean across shared drawer components.
2. Red
   - Catch any compile or adjacent browser regressions after the drawer changes.
   - Expected failure signal: type/Svelte errors or browser tile regressions.
3. Green
   - Run targeted compile and adjacent regression checks.
4. Exit criteria
   - Changed files are clean and adjacent checks pass.

### Phase 2

1. Objective
   - Finalize PRD/status bookkeeping.
2. Red
   - Identify any remaining stale docs/status/checklist items.
3. Green
   - Mark the PRD complete and record the command log.
4. Exit criteria
   - PRD is completed with verification evidence.

## Execution Checklist

- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Phase 2 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log

1. `sed -n '1,260p' /Users/skryl/.codex/skills/phased-prd-red-green/SKILL.md`
   - result: pass
   - notes: confirmed phased PRD workflow
2. `rg -n "DebugPane|resize handle|three dots|3 dot|handle" src/lib tests/integration`
   - result: pass
   - notes: located the existing debug-pane grip and relevant drawer/test files
3. `sed -n '1,220p' src/lib/TileActivityDrawer.svelte`
   - result: pass
   - notes: confirmed the shared activity drawer is the common path for terminal/browser/work
4. `sed -n '1,220p' src/lib/BrowserTextPreviewDrawer.svelte`
   - result: pass
   - notes: confirmed the browser text preview uses a separate drawer component
5. `npm run test:integration -- tests/integration/test-driver.test.ts -t "surfaces agent messaging activity in the per-pane activity projection"`
   - result: fail
   - notes: red signal was missing `.drawer-resize-grip` on the shared activity drawer
6. `npm run test:integration -- tests/integration/test-driver.test.ts -t "surfaces agent messaging activity in the per-pane activity projection"`
   - result: pass
   - notes: shared activity drawer now exposes the grip and resizes vertically
7. `npm run test:integration -- tests/integration/test-driver.test.ts -t "shows a live browser DOM text preview immediately left of the activity toggle"`
   - result: pass
   - notes: browser preview drawer now exposes the same grip and resizes vertically
8. `npm run test:integration -- tests/integration/test-driver.test.ts -t "gates browser tile address bar focus behind input mode"`
   - result: pass
   - notes: adjacent browser tile behavior still works
9. `npm run check`
   - result: pass
   - notes: frontend type/svelte checks passed cleanly
10. `git diff --check -- src/lib/TileActivityDrawer.svelte src/lib/BrowserTextPreviewDrawer.svelte tests/integration/test-driver.test.ts prd/2026_03_24_tile_bottom_drawer_resize_handle_prd.md`
   - result: pass
   - notes: changed files are whitespace-clean
