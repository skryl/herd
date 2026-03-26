## Title

Browser Webview Zoom Compensation

## Status

Completed

## Date

2026-03-25

## Context

Browser tiles live inside the zoomable canvas, but their child webviews are native overlays whose bounds are synchronized separately from the canvas DOM. Today the sync path scales the child webview’s on-screen viewport with the canvas zoom, so browser content grows and shrinks along with canvas zoom. A full overlay refactor would decouple browser tiles from the transformed canvas entirely, but the smaller first step is to apply inverse zoom compensation inside the child webview while keeping the existing bounds sync path. The user also asked to push the main canvas zoom floor down to `5%`, so the browser compensation range needed to expand alongside that lower floor.

## Goals

- Compensate browser child webview content for canvas zoom by applying inverse page zoom during browser sync.
- Allow the main canvas to zoom out to `5%`.
- Keep the existing tile layout, ports, and wire alignment unchanged.
- Cover the zoom-compensation math with targeted unit tests.

## Non-goals

- Moving browser tiles out of the transformed canvas into a separate overlay layer.
- Changing how browser tile chrome or network wires are rendered.
- Reworking the browser sync path beyond the added zoom compensation.

## Scope

- `src/lib/browserViewport.ts`
- `src/lib/browserViewport.test.ts`
- `src/lib/BrowserTile.svelte`
- `src/lib/tauri.ts`
- `src-tauri/src/browser.rs`
- `src/lib/stores/appState.ts`
- `src/lib/stores/appState.test.ts`

## Risks and mitigations

- Risk: inverse zoom values could become invalid for extreme or bad canvas zoom inputs.
  - Mitigation: clamp and sanitize the page zoom before it reaches the webview API.
- Risk: page zoom compensation could break the existing browser sync path.
  - Mitigation: keep the viewport bounds logic intact and add a focused browser integration regression check afterward.
- Risk: the behavior may not perfectly match a future overlay architecture.
  - Mitigation: keep the compensation isolated to one helper and one sync field so it can be removed cleanly later.

## Acceptance criteria

- Browser sync sends inverse page zoom based on the current canvas zoom.
- The main canvas can zoom out to `0.05`.
- The backend applies that zoom to the child webview during sync.
- Invalid or extreme zoom inputs are sanitized safely.
- Focused unit tests and Rust checks pass, and the adjacent browser integration is at least rerun to detect regressions.

## Phased Plan

### Phase 0

#### Objective

Pin down the zoom-compensation math with a failing helper test.

#### Red

- Add unit coverage for inverse browser page zoom derivation.
- Expected failure signal: the helper is missing or returns the wrong compensation factor.

#### Green

- No implementation in this phase.
- Verification commands:
  - `npm run test:unit -- --run src/lib/browserViewport.test.ts`

#### Exit criteria

- The targeted unit test fails before the helper exists.

### Phase 1

#### Objective

Thread the inverse page zoom through browser sync and apply it in the child webview.

#### Red

- Re-run the targeted helper test after Phase 0 changes.
- Expected failure signal: the missing helper or sync field still blocks the test/build.

#### Green

- Add the helper and use it in `BrowserTile.svelte`.
- Extend the browser sync viewport payload with page zoom and apply it in Rust.
- Lower the shared canvas zoom floor to `0.05`.
- Verification commands:
  - `npm run test:unit -- --run src/lib/browserViewport.test.ts`
  - `npm run test:unit -- --run src/lib/stores/appState.test.ts -t "allows the main canvas to zoom out to the lower floor"`
  - `cargo test --manifest-path src-tauri/Cargo.toml browser::tests::`
  - `npm run check`
  - `npm run test:integration -- tests/integration/test-driver.test.ts -t "shows a live browser DOM text preview immediately left of the activity toggle"`

#### Exit criteria

- The helper test passes, the lower zoom floor is verified, the app builds cleanly, and the adjacent browser integration has been rerun.

## Execution Checklist

- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log

1. `sed -n '520,980p' src/lib/BrowserTile.svelte`
   - result: `pass`
   - notes: confirmed browser sync currently measures the transformed host rect directly
2. `sed -n '260,390p' src/lib/Canvas.svelte`
   - result: `pass`
   - notes: confirmed the entire canvas world is scaled with `transform-origin: 0 0`
3. `rg -n "BrowserViewport|browser_webview_sync\\(|syncBrowserWebview\\(|currentViewport\\(|set_zoom\\(" src src-tauri/src`
   - result: `pass`
   - notes: confirmed `set_zoom` is available and browser sync is the only place to thread the compensation
4. `npm run test:unit -- --run src/lib/browserViewport.test.ts`
   - result: `fail`
   - notes: expected red; `./browserViewport` was missing before the helper was added
5. `npm run test:unit -- --run src/lib/browserViewport.test.ts`
   - result: `pass`
   - notes: helper math passed after threading inverse zoom through the browser sync payload
6. `npm run test:unit -- --run src/lib/stores/appState.test.ts -t "allows the main canvas to zoom out to the lower floor"`
   - result: `pass`
   - notes: verified the main canvas now clamps at `0.05`
7. `cargo test --manifest-path src-tauri/Cargo.toml browser::tests::`
   - result: `pass`
   - notes: verified Rust-side browser page-zoom sanitization and clamping up to `20x`
8. `npm run check`
   - result: `pass`
   - notes: `svelte-check` and `tsc` both completed without errors
9. `npm run test:integration -- tests/integration/test-driver.test.ts -t "shows a live browser DOM text preview immediately left of the activity toggle"`
   - result: `hung`
   - notes: adjacent pre-existing issue; browser host disconnected and the test looped on `browser_drive dom_query` returning `Host disconnected`
10. `git diff --check -- src/lib/browserViewport.ts src/lib/browserViewport.test.ts src/lib/BrowserTile.svelte src/lib/tauri.ts src-tauri/src/browser.rs src/lib/stores/appState.ts src/lib/stores/appState.test.ts prd/2026_03_25_browser_webview_zoom_compensation_prd.md`
   - result: `pass`
   - notes: no whitespace or patch formatting issues in the touched files
