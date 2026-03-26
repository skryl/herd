# Game Boy Grid Overlay PRD

## Header

1. Title: Game Boy navigation grid overlay
2. Status: Completed
3. Date: 2026-03-25

## Context

The Game Boy browser extension currently exposes only the raw emulator screen. The user wants a toggleable grid overlay to help agents navigate by screen position. The overlay must be visible both in the live UI and in the extension screenshot API output. Each row and column should be labeled, and each grid square should be labeled as `row.col`, with `0.0` at the bottom-left corner.

## Goals

1. Add a toolbar button that toggles a visible navigation grid overlay on the Game Boy screen.
2. Render row labels, column labels, and per-cell `row.col` labels with `0.0` at the bottom-left origin.
3. Ensure the overlay is included in `extension_call -> screenshot` output when enabled.
4. Expose overlay state and a discoverable extension method so agents can enable it deterministically.

## Non-goals

1. Adding OCR or semantic game-state extraction.
2. Changing the emulator core or ROM behavior.
3. Mirroring the same overlay into JSNES in this change.

## Scope

1. Add overlay state, drawing helpers, and a toggle button to the Game Boy extension UI.
2. Composite the overlay into screenshot captures instead of returning only the raw emulator canvas.
3. Extend the Game Boy extension manifest/API with a grid-overlay control method and state fields.
4. Add focused browser-extension tests for the overlay UI, API state, and screenshot behavior.

## Risks and mitigations

1. Risk: a DOM-only overlay would be missing from screenshots.
   Mitigation: render the overlay through shared drawing logic and composite it into screenshot output explicitly.
2. Risk: dense labels could become unreadable at native resolution.
   Mitigation: use a coarse 10x9 grid that matches 16x16 cells on the 160x144 Game Boy screen and render high-contrast monospace labels.
3. Risk: an agent cannot reliably toggle the overlay through a pure “toggle” API.
   Mitigation: expose an explicit extension method that can set the enabled state deterministically.

## Acceptance criteria

1. The Game Boy toolbar includes a grid-overlay toggle button.
2. Enabling the overlay draws labeled rows, columns, and per-cell `row.col` labels with `0.0` at the bottom-left.
3. The Game Boy extension state reports whether the grid overlay is enabled.
4. The Game Boy extension manifest exposes a discoverable grid-overlay control method.
5. Screenshot results differ when the overlay is enabled because the overlay is included in the captured PNG.
6. Focused Game Boy extension tests pass.

## Phased Plan (Red/Green)

### Phase 0

1. Objective
   - Lock the UI/API/screenshot contract with failing extension tests.
2. Red
   - Add a browser-extension test for the new toggle button and overlay state fields.
   - Add a screenshot test that freezes the frame, enables the overlay, and expects screenshot output to change.
   - Expected failure signal: missing toggle button, missing API method/state, or screenshots unchanged by overlay state.
3. Green
   - Implement the smallest overlay state and screenshot composition needed to satisfy the tests.
   - Verification commands:
     - `npx vitest run extensions/browser/game-boy/game-boy.test.ts`
4. Exit criteria
   - Game Boy extension tests fail first, then pass with the overlay feature implemented.

### Phase 1

1. Objective
   - Finalize evidence and status tracking.
2. Red
   - N/A beyond re-running focused checks.
3. Green
   - Re-run the focused verification command, update the PRD checklist/status, and record the result.
   - Verification commands:
     - `npx vitest run extensions/browser/game-boy/game-boy.test.ts`
4. Exit criteria
   - The PRD is marked completed with passing test evidence.

## Execution Checklist

- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log

1. `sed -n '1,220p' /Users/skryl/.codex/skills/phased-prd-red-green/SKILL.md`
   - result: pass
   - notes: loaded the required PRD/red-green workflow
2. `sed -n '1,220p' /Users/skryl/.codex/skills/phased-prd-red-green/references/prd_red_green_template.md`
   - result: pass
   - notes: loaded the PRD template
3. `sed -n '1,240p' extensions/browser/game-boy/app.js`
   - result: pass
   - notes: identified the extension manifest, current state payload, and screenshot path
4. `sed -n '1,220p' extensions/browser/game-boy/index.html`
   - result: pass
   - notes: identified the toolbar and screen container for the new overlay button
5. `sed -n '1,280p' extensions/browser/game-boy/styles.css`
   - result: pass
   - notes: identified the screen layout and toolbar styles to extend
6. `npx vitest run extensions/browser/game-boy/game-boy.test.ts`
   - result: fail, then pass
   - notes: red run failed on the missing `#toggle-grid-overlay` control; green rerun passed after adding the overlay UI, state/API, and screenshot composition
7. `git diff --check -- extensions/browser/game-boy/index.html extensions/browser/game-boy/styles.css extensions/browser/game-boy/app.js extensions/browser/game-boy/game-boy.test.ts prd/2026_03_25_gameboy_grid_overlay_prd.md`
   - result: pass
   - notes: confirmed the touched files are patch-clean
