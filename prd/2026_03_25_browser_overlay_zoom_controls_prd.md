## Title

Browser Tile Overlay Zoom Controls

## Status

Completed

## Date

2026-03-25

## Context

Browser tiles currently live inside the transformed canvas world, and the app compensates by applying inverse page zoom inside the child browser webview. The delivered direction keeps browser tile webviews in a dedicated overlay layer outside `.canvas-world`, keeps the tile chrome scaling with the canvas, and makes browser page zoom an explicit tile-local control layered on top of that inverse canvas compensation.

## Goals

- Render browser tiles through a dedicated overlay layer instead of the main transformed canvas world.
- Keep browser content visually stable across canvas zoom changes by combining inverse canvas compensation with explicit browser page zoom controls.
- Add a dedicated browser page zoom out/in button pair immediately left of the `TXT` preview button.
- Keep the existing browser tile drag, resize, selection, activity drawer, preview drawer, and wire/port behavior working.

## Non-goals

- Changing terminal or work-tile rendering paths.
- Adding compatibility fallbacks that keep both the old compensation path and the new overlay path alive.
- Persisting browser page zoom across app restarts.

## Scope

- `prd/2026_03_25_browser_overlay_zoom_controls_prd.md`
- `src/lib/browserViewport.ts`
- `src/lib/browserViewport.test.ts`
- `src/lib/Canvas.svelte`
- `src/lib/BrowserTile.svelte`
- `tests/integration/test-driver.test.ts`

## Risks and mitigations

- Risk: moving browser tiles out of `.canvas-world` could break pointer, port, or context-menu behavior.
  - Mitigation: keep the browser overlay inside `.canvas-viewport`, preserve the same tile component contract, and verify the adjacent browser integration test.
- Risk: explicit browser zoom state could stop syncing if viewport dedupe keys ignore page zoom.
  - Mitigation: include page zoom in the sync invalidation path and cover the zoom helper behavior with unit tests.
- Risk: overlay browser tiles could block canvas interactions incorrectly.
  - Mitigation: make the overlay layer itself non-interactive and keep pointer events on the browser tiles only.

## Acceptance criteria

- Browser tiles render in a dedicated overlay layer and are no longer descendants of `.canvas-world`.
- Browser sync derives the effective child-webview page zoom from explicit browser page zoom layered over inverse canvas compensation.
- Browser tile bounds still scale with canvas zoom like the rest of the canvas tiles.
- Browser tiles expose `Z-` and `Z+` controls immediately left of `TXT`.
- Clicking the zoom buttons updates the tile-local browser page zoom state and re-syncs the child webview.
- Targeted unit and integration checks pass, followed by `npm run check`.

## Phased Plan

### Phase 0

#### Objective

Capture the new overlay placement and explicit zoom-control contract in failing tests.

#### Red

- Update the browser zoom helper unit test to describe explicit page zoom clamping/stepping instead of inverse canvas compensation.
- Update the browser preview integration test to expect browser tiles outside `.canvas-world`, plus the new `Z-`, `Z+`, `TXT`, `ACT` control order.
- Expected failure signal: missing helper behavior, missing zoom buttons, and browser tiles still rendered in the transformed canvas world.

#### Green

- No implementation in this phase.
- Verification commands:
  - `npm run test:unit -- --run src/lib/browserViewport.test.ts`
  - `npm run test:integration -- tests/integration/test-driver.test.ts -t "shows a live browser DOM text preview immediately left of the activity toggle"`

#### Exit criteria

- The targeted checks fail for the missing overlay/zoom-control behavior.

### Phase 1

#### Objective

Move browser tiles to the overlay path and replace inverse compensation with explicit browser zoom controls.

#### Red

- Re-run the Phase 0 checks after the test updates.
- Expected failure signal: browser tiles still use the transformed canvas path or the new explicit zoom controls do not update browser sync.

#### Green

- Replace inverse canvas compensation helpers with explicit browser page zoom helpers.
- Render browser tiles through a dedicated overlay layer in `Canvas.svelte`.
- Update `BrowserTile.svelte` to use screen-space positioning and explicit page zoom controls.
- Verification commands:
  - `npm run test:unit -- --run src/lib/browserViewport.test.ts`
  - `npm run test:integration -- tests/integration/test-driver.test.ts -t "shows a live browser DOM text preview immediately left of the activity toggle"`
  - `npm run check`

#### Exit criteria

- Browser tiles render through the overlay path, the explicit zoom controls work, and the targeted checks pass.

## Execution Checklist

- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log

1. `sed -n '1,260p' /Users/skryl/.codex/skills/phased-prd-red-green/SKILL.md`
   - result: `pass`
   - notes: loaded the required phased PRD workflow
2. `sed -n '1,260p' /Users/skryl/.codex/skills/phased-prd-red-green/references/prd_red_green_template.md`
   - result: `pass`
   - notes: loaded the PRD template
3. `npm run test:unit -- --run src/lib/browserViewport.test.ts`
   - result: `fail`
   - notes: expected red; the old inverse-compensation helper API was still in place and the new explicit zoom helper exports were missing
4. `npm run test:integration -- tests/integration/test-driver.test.ts -t "shows a live browser DOM text preview immediately left of the activity toggle"`
   - result: `hung`
   - notes: the initial red attempt did not return a useful assertion signal before implementation work continued; pre-change code still showed browser tiles rendered under `.canvas-world` with no `Z-` / `Z+` controls
5. `npm run test:unit -- --run src/lib/browserViewport.test.ts`
   - result: `pass`
   - notes: explicit browser page-zoom clamp/step/format helpers passed after adding the new tile-local browser zoom helper set
6. `npm run test:integration -- tests/integration/test-driver.test.ts -t "shows a live browser DOM text preview immediately left of the activity toggle"`
   - result: `pass`
   - notes: verified the browser tile overlay layer, `Z-` / `Z+` controls, zoom-label updates, and the adjacent live preview behavior
7. `npm run check`
   - result: `pass`
   - notes: `svelte-check` and TypeScript checks both completed without errors
8. `git diff --check -- prd/2026_03_25_browser_overlay_zoom_controls_prd.md src/lib/browserViewport.ts src/lib/browserViewport.test.ts src/lib/Canvas.svelte src/lib/BrowserTile.svelte tests/integration/test-driver.test.ts`
   - result: `pass`
   - notes: no whitespace or patch-formatting issues in the touched files
9. `npm run test:unit -- --run src/lib/browserViewport.test.ts`
   - result: `pass`
   - notes: explicit browser page-zoom helpers still passed after restoring browser tile canvas scaling
10. `npm run test:integration -- tests/integration/test-driver.test.ts -t "shows a live browser DOM text preview immediately left of the activity toggle"`
   - result: `pass`
   - notes: verified the corrected contract: browser tile bounds grow with canvas zoom while the browser page zoom label remains explicit and independent
11. `npm run check`
   - result: `pass`
   - notes: `svelte-check` and TypeScript checks remained clean after the browser tile contract correction
12. `git diff --check -- src/lib/BrowserTile.svelte src/lib/stores/appState.ts src/lib/stores/appState.test.ts tests/integration/test-driver.test.ts prd/2026_03_25_browser_overlay_zoom_controls_prd.md`
   - result: `pass`
   - notes: no whitespace or patch-formatting issues after the contract correction
13. `npm run test:unit -- --run src/lib/browserViewport.test.ts`
   - result: `pass`
   - notes: verified explicit browser zoom plus inverse canvas compensation helper coverage
14. `npx vitest run --config vitest.integration.config.ts tests/integration/test-driver.test.ts -t "shows a live browser DOM text preview immediately left of the activity toggle" --reporter=verbose`
   - result: `pass`
   - notes: confirmed the live browser tile path still passes with the corrected content-stability contract
15. `npm run check`
   - result: `pass`
   - notes: `svelte-check` and TypeScript checks passed after reintroducing inverse compensation under the explicit browser zoom controls
16. `git diff --check -- src/lib/browserViewport.ts src/lib/browserViewport.test.ts src/lib/BrowserTile.svelte`
   - result: `pass`
   - notes: no whitespace or patch-formatting issues in the final compensation patch
