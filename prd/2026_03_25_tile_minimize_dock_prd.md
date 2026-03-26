# Tile Minimize Dock PRD

## Header

1. Title: Tile Minimize Dock
2. Status: Completed
3. Date: 2026-03-25

## Context

Canvas tiles currently support close/delete chrome but not minimization. The requested behavior is a Windows-style minimize action that moves tiles into a compact dock just above the bottom status bar, while the main canvas continues to pan and zoom independently underneath.

## Goals

1. Add a minimize control next to the existing close control on pane tiles and work cards.
2. Move minimized tiles out of the canvas render path and into a fixed dock above the status bar.
3. Restore minimized tiles to their prior canvas layout when the dock item is activated.
4. Keep canvas-only systems such as wire routing, fit-to-canvas, and tile counts aligned with visible canvas tiles.

## Non-goals

1. Persist minimized state across Herd restarts.
2. Add a second layout persistence format or backend migration for minimized tiles.
3. Introduce alternate legacy render paths for minimized vs non-minimized tiles.

## Scope

1. Frontend app state for per-session minimized tile tracking.
2. Canvas filtering for pane tiles, work cards, and wire geometry.
3. A new fixed dock UI mounted in the canvas viewport above the status bar/debug inset.
4. Tile chrome updates for shell/agent/browser tiles and work cards.

## Risks and mitigations

1. Risk: Hidden tiles still affect wire routing or fit-to-canvas.
   Mitigation: Filter minimized tiles out of canvas rect collection and fit calculations, and cover with unit tests.
2. Risk: Tile selection and cleanup drift when panes/work cards close.
   Mitigation: Reconcile minimized tile ids against live pane/work tile ids during tmux/work state updates.
3. Risk: Dock overlaps fixed UI.
   Mitigation: Mount dock inside the existing canvas viewport so it inherits sidebar/debug/status offsets.

## Acceptance criteria

1. Pane tiles and work cards show a minimize control adjacent to close/delete.
2. Clicking minimize removes the tile from the canvas and adds a compact dock item above the status bar.
3. Clicking the dock item restores the tile to the canvas at its previous size and position.
4. Minimized tiles no longer contribute to canvas wire paths or fit-to-canvas bounds.
5. Focused unit and integration coverage passes.

## Phased Plan (Red/Green)

### Phase 0

1. Objective
   - Lock the state and projection model for minimized tiles.
2. Red
   - Add store tests for per-session minimize/restore behavior and canvas filtering.
   - Expected failure signal: minimized tiles still appear in canvas projections or no minimize API exists.
3. Green
   - Add minimized tile state, visible-canvas filters, and cleanup reconciliation.
   - Verification commands:
     - `npm run test:unit -- --run src/lib/stores/appState.test.ts -t "minimize"`
4. Exit criteria
   - Store tests pass and minimized tiles are absent from canvas-only projections.

### Phase 1

1. Objective
   - Ship the UI controls and dock behavior.
2. Red
   - Add integration coverage for minimizing/restoring pane and work tiles via DOM controls.
   - Expected failure signal: minimize buttons or dock items are missing, or restore does not return the tile.
3. Green
   - Add minimize buttons to tile chrome, dock UI, and restore handlers.
   - Verification commands:
     - `npm run test:integration -- tests/integration/test-driver.test.ts -t "minimizes tiles into a dock above the status bar and restores them"`
4. Exit criteria
   - Pane and work tile minimize/restore flows pass in integration coverage.

### Phase 2

1. Objective
   - Close regression gaps and finalize.
2. Red
   - Re-run adjacent checks around canvas rendering, layout state, and typing.
   - Expected failure signal: type errors, dirty diff, or canvas regressions.
3. Green
   - Tighten any selectors or layout edge cases without changing semantics.
   - Verification commands:
     - `npm run check`
     - `git diff --check -- src/App.svelte src/lib/Canvas.svelte src/lib/TerminalTile.svelte src/lib/BrowserTile.svelte src/lib/WorkCard.svelte src/lib/StatusBar.svelte src/lib/stores/appState.ts src/lib/stores/appState.test.ts tests/integration/test-driver.test.ts`
4. Exit criteria
   - Targeted unit/integration checks and repo checks pass.

## Execution Checklist

- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Phase 2 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log

1. `sed -n '1,220p' /Users/skryl/.codex/skills/phased-prd-red-green/SKILL.md`
   - result: pass
   - notes: confirmed phased PRD workflow.
2. `sed -n '1,220p' /Users/skryl/.codex/skills/phased-prd-red-green/references/prd_red_green_template.md`
   - result: pass
   - notes: loaded the PRD template.
3. `npm run test:unit -- --run src/lib/stores/appState.test.ts -t "minimized|fits the canvas to only non-minimized"`
   - result: fail -> pass
   - notes: started red on missing minimize actions, then passed after adding per-session minimize state and visible-canvas filters.
4. `npm run test:integration -- tests/integration/test-driver.test.ts -t "minimizes tiles into a dock above the status bar and restores them"`
   - result: fail -> pass
   - notes: started red on missing minimize buttons, then passed after adding tile chrome buttons and dock restore UI.
5. `npm run test:unit -- --run src/lib/stores/appState.test.ts`
   - result: pass
   - notes: full store unit file passed after switching motion timers to environment-safe globals.
6. `npm run check`
   - result: pass
   - notes: Svelte and TypeScript checks passed.
7. `git diff --check -- src/App.svelte src/lib/Canvas.svelte src/lib/MinimizedTileDock.svelte src/lib/TerminalTile.svelte src/lib/BrowserTile.svelte src/lib/WorkCard.svelte src/lib/stores/appState.ts src/lib/stores/appState.test.ts src/lib/types.ts tests/integration/test-driver.test.ts prd/2026_03_25_tile_minimize_dock_prd.md`
   - result: pass
   - notes: no whitespace or patch formatting issues.
