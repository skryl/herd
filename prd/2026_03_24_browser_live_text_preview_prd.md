## Title

Browser Live Text Preview

## Status

Completed

## Date

2026-03-24

## Context

Browser tiles already expose `browser_drive screenshot { format: "text" }`, which returns a layout-preserving text grid from the browser DOM. The user now wants that surfaced directly in the browser tile UI as a live preview, with a dedicated button immediately left of the existing activity log toggle. This should be a first-class browser-tile affordance, not a hidden debug path.

## Goals

1. Add a browser-tile UI button immediately left of `ACT` that toggles a live text preview drawer.
2. Fetch the preview from the existing browser DOM text renderer rather than duplicating extraction logic in the frontend.
3. Keep the preview refreshed while open so dynamic game/UI screens remain readable.
4. Preserve the current activity log behavior and placement, with the new control inserted to its left.

## Non-goals

1. Replacing the existing screenshot/image formats.
2. Adding a global preview panel outside browser tiles.
3. Leaving a legacy debug-only preview path alongside the new UI feature.

## Scope

1. Backend Tauri invoke command for browser live text preview.
2. Frontend browser tile UI, refresh loop, and drawer rendering.
3. Focused browser tile integration coverage.
4. Minimal docs/PRD status updates if needed.

## Risks and mitigations

1. Frequent preview refreshes could spam the webview.
   - Mitigation: only poll while the preview is open, and use a modest interval.
2. Preview updates could race with navigation and viewport sync.
   - Mitigation: reuse the same browser backend extraction path and tolerate transient read errors without breaking the tile.
3. The preview drawer could crowd small browser tiles.
   - Mitigation: reuse the existing drawer pattern and keep it collapsible.

## Acceptance criteria

1. Browser tiles render a preview toggle button immediately left of the activity log button.
2. Opening the preview shows the current browser DOM text grid for that tile.
3. While the preview is open, the content refreshes live enough to reflect DOM changes.
4. Existing activity log behavior still works.
5. Focused integration coverage verifies the preview drawer opens and updates.

## Phased Plan (Red/Green)

### Phase 0

1. Objective
   - Add failing UI coverage for the new preview toggle and live content.
2. Red
   - Add an integration test that opens a browser tile, toggles the preview, and expects text content plus live updates.
   - Expected failure signal: missing preview button/drawer or stale/empty content.
3. Green
   - Implement the frontend toggle, drawer, and backend invoke path.
   - Verification commands: focused integration and targeted compile/tests.
4. Exit criteria
   - The new UI control and drawer behavior are covered and passing.

### Phase 1

1. Objective
   - Reuse the backend text renderer through a dedicated invoke command.
2. Red
   - Add failing backend/unit coverage if needed for the new invoke wrapper.
   - Expected failure signal: missing invoke handler or invalid payload.
3. Green
   - Add a browser invoke command that returns the layout-preserving text result for a pane.
   - Verification commands: focused Rust test/build checks.
4. Exit criteria
   - Frontend can request preview text directly from the backend without root/socket indirection.

### Phase 2

1. Objective
   - Finalize docs/status and verify changed files cleanly.
2. Red
   - Tighten any docs/test references that still imply only activity logs exist in that footer slot.
   - Expected failure signal: stale labels or assertions.
3. Green
   - Update docs/PRD/checklist and rerun targeted verification.
4. Exit criteria
   - PRD is completed and changed surfaces are verified.

## Execution Checklist

- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Phase 2 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log

1. `sed -n '1,260p' /Users/skryl/.codex/skills/phased-prd-red-green/SKILL.md`
   - result: pass
   - notes: confirmed phased PRD workflow applies
2. `rg -n "Activity Logs|activity" src src-tauri tests/integration tests`
   - result: pass
   - notes: located the browser tile footer activity button and existing activity drawer coverage
3. `rg -n "browser_webview_|invoke_handler|browser_drive" src-tauri/src/lib.rs src-tauri/src/browser.rs src/lib/tauri.ts`
   - result: pass
   - notes: located the backend/frontend invoke seams for a direct browser preview command
4. `npm run test:integration -- tests/integration/test-driver.test.ts -t "shows a live browser DOM text preview immediately left of the activity toggle"`
   - result: fail
   - notes: red signal was that only `ACT` existed and the new `TXT` toggle/drawer were missing
5. `npm run test:integration -- tests/integration/test-driver.test.ts -t "shows a live browser DOM text preview immediately left of the activity toggle"`
   - result: pass
   - notes: verified the `TXT` toggle opens a live preview and refreshes after a browser DOM mutation
6. `npm run test:integration -- tests/integration/test-driver.test.ts -t "gates browser tile address bar focus behind input mode"`
   - result: pass
   - notes: adjacent browser tile input-mode behavior still works
7. `cargo test --manifest-path src-tauri/Cargo.toml browser::braille_tests::`
   - result: pass
   - notes: browser text/screenshot backend tests still pass after the new invoke path
8. `npm run check`
   - result: pass
   - notes: frontend type/svelte checks passed with no errors or warnings
9. `git diff --check -- src-tauri/src/browser.rs src-tauri/src/lib.rs src/lib/BrowserTile.svelte src/lib/BrowserTextPreviewDrawer.svelte src/lib/tauri.ts tests/integration/test-driver.test.ts prd/2026_03_24_browser_live_text_preview_prd.md`
   - result: pass
   - notes: changed files are whitespace-clean
