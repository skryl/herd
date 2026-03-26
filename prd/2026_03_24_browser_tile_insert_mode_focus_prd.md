# Browser Tile Insert Mode Focus PRD

Status: Completed
Date: 2026-03-24

## Context

Browser tiles currently expose their URL input regardless of Herd mode. That means the tile-local address bar can take focus outside insert mode, while the expected behavior is:

- selecting a browser tile while already in insert mode should focus the address bar
- pressing `i` with a browser tile selected should focus the address bar
- outside insert mode, the address bar should not accept focus or typing
- the browser webview itself should remain usable

## Goals

- Gate browser address-bar focus and typing behind insert mode.
- Auto-focus the browser address bar when a browser tile becomes selected in insert mode.
- Allow keyboard exit from browser address-bar focus without trapping the user in input mode.

## Non-Goals

- Changing browser MCP tooling or browser-drive behavior.
- Redesigning browser tile layout or controls.
- Preventing direct interaction with the browser webview surface.

## Scope

- `src/lib/BrowserTile.svelte`
- Focused browser UI integration coverage in `tests/integration/test-driver.test.ts`
- PRD status and command log

## Risks And Mitigations

- Risk: focusing the URL field on every render could steal focus back from the webview.
  Mitigation: only refocus when the relevant mode/selection state changes.
- Risk: the focused URL field bypasses global shortcuts and traps input mode.
  Mitigation: handle `Shift+Escape` locally in the URL input to exit input mode.

## Acceptance Criteria

- Browser URL input is focused when the browser tile is selected while mode is already `input`.
- Browser URL input is focused when `i` is pressed with the browser tile selected.
- Browser URL input is not focusable/editable in command mode.
- Focused browser URL input can exit input mode with `Shift+Escape`.

## Phased Plan

### Phase 0: Red

Objective: capture the incorrect browser URL focus behavior with targeted integration coverage.

Red:
- Add a focused integration test that covers:
  - selecting a browser tile while already in input mode
  - entering input mode on a selected browser tile
  - exiting input mode from the URL field
- Expected failure signal:
  - browser URL input is not focused when it should be, or remains active in command mode

Green:
- No implementation changes in this phase.

Exit Criteria:
- Regression exists and fails on current behavior.

### Phase 1: Green

Objective: align BrowserTile focus behavior with insert mode.

Red:
- Use the failing integration regression from Phase 0.

Green:
- Track whether the browser URL input is editable from mode + selection state.
- Focus the URL input when the selected browser tile is in input mode.
- Blur and lock the URL input when leaving input mode.
- Handle `Shift+Escape` inside the URL input to exit input mode.

Exit Criteria:
- Browser insert-mode regression passes.

### Phase 2: Regression Check

Objective: confirm adjacent browser/tile interactions remain green.

Red:
- N/A

Green:
- Run the focused integration regression plus a diff sanity check.

Exit Criteria:
- Verification commands are green and recorded.

## Implementation Checklist

- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Phase 2 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log

1. `npm run test:integration -- tests/integration/test-driver.test.ts -t "gates browser tile address bar focus behind input mode"`
   - result: failed
   - notes: initial red run hit `No webview found` from the test-driver DOM hook after browser spawn
2. `npm run test:integration -- tests/integration/test-driver.test.ts -t "gates browser tile address bar focus behind input mode"`
   - result: failed
   - notes: follow-up run timed out waiting for the DOM driver after browser spawn
3. `npm run test:integration -- tests/integration/test-driver.test.ts -t "lets focused dialog inputs bypass global shortcuts and temporarily switch the app into input mode"`
   - result: passed
   - notes: adjacent DOM-driver/input-path sanity check after targeting the main app webview
4. `npm run test:integration -- tests/integration/test-driver.test.ts -t "gates browser tile address bar focus behind input mode"`
   - result: passed
   - notes: focused browser insert-mode regression green
5. `git diff --check -- src/lib/BrowserTile.svelte src-tauri/src/socket/server.rs tests/integration/test-driver.test.ts prd/2026_03_24_browser_tile_insert_mode_focus_prd.md`
   - result: passed
   - notes: touched files are whitespace-clean
