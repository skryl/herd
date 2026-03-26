## Title

Browser Text Preview Format Controls

## Status

Completed

## Date

2026-03-24

## Context

Browser tiles already expose a live bottom-drawer text preview, but the drawer is locked to DOM text output with a fixed refresh cadence. The browser screenshot pipeline already supports `text`, `braille`, `ansi`, and `ascii`, so the live preview surface should expose those same modes directly in the title bar and let the user choose a slower or faster refresh cadence without leaving the tile.

## Goals

- Add title-bar toggles for `Text`, `Braille`, `ANSI`, and `ASCII` in the browser preview drawer.
- Add a title-bar control that cycles the live refresh cadence between `0.5s`, `1s`, and `3s`.
- Keep the centered three-dot resize grip intact while adding the new controls.
- Drive the live preview from a single backend preview command that supports all text-returning preview formats.

## Non-goals

- Adding new screenshot formats beyond the existing four text-returning formats.
- Changing the activity drawer UI.
- Adding persistent per-tile preview preferences across app restarts.

## Scope

- `src-tauri/src/browser.rs`
- `src-tauri/src/lib.rs`
- `src/lib/tauri.ts`
- `src/lib/BrowserTile.svelte`
- `src/lib/BrowserTextPreviewDrawer.svelte`
- `tests/integration/test-driver.test.ts`

## Risks and mitigations

- Risk: adding multiple controls to the preview header could break the centered grip layout.
  - Mitigation: keep a dedicated centered column for the grip and assert center alignment in integration coverage.
- Risk: switching preview formats could cause overlapping refresh requests.
  - Mitigation: reuse the existing in-flight/queued refresh guards and re-request immediately when the format changes.
- Risk: ANSI previews are noisy in DOM text assertions.
  - Mitigation: assert on escape-sequence presence rather than exact rendered content.

## Acceptance criteria

- Opening a browser text preview shows header controls for `Text`, `Braille`, `ANSI`, `ASCII`, and the refresh cadence button.
- Clicking a format toggle updates the live preview output to the selected format.
- Clicking the cadence button cycles through `0.5s`, `1s`, and `3s`, then wraps.
- The preview continues to refresh live after DOM mutations.
- The resize grip remains centered in the preview title bar.

## Phased Plan

### Phase 0

#### Objective

Capture the UI contract for the new preview controls and cadence cycle in the existing browser preview integration test.

#### Red

- Extend `tests/integration/test-driver.test.ts` with assertions for the format toggles and cadence cycle.
- Expected failure signal: the test cannot find the new controls or observe the expected format-switching output.

#### Green

- No implementation in this phase.
- Verification commands:
  - `npm run test:integration -- tests/integration/test-driver.test.ts -t "shows a live browser DOM text preview immediately left of the activity toggle"`

#### Exit criteria

- The targeted test fails for the missing controls or unsupported preview format switching.

### Phase 1

#### Objective

Generalize the backend/browser preview invoke so the live preview can request `text`, `braille`, `ansi`, and `ascii`.

#### Red

- Re-run the targeted preview test after Phase 0 changes.
- Expected failure signal: the UI requests unsupported preview formats or the backend invoke shape no longer matches.

#### Green

- Replace the text-only preview invoke with a format-aware preview invoke.
- Reuse the existing DOM text and PNG text-rendering paths based on the requested format.
- Verification commands:
  - `cargo test --manifest-path src-tauri/Cargo.toml browser::tests::`

#### Exit criteria

- The backend command returns text preview payloads for each supported format and existing Rust tests pass.

### Phase 2

#### Objective

Add the preview header controls and cadence cycling to the browser tile UI.

#### Red

- Re-run the targeted preview integration test after the backend change.
- Expected failure signal: header controls are still missing or the cadence button does not cycle correctly.

#### Green

- Update the title bar with format toggles and a cadence cycle button.
- Feed the selected format and cadence into the existing live preview polling loop.
- Verification commands:
  - `npm run test:integration -- tests/integration/test-driver.test.ts -t "shows a live browser DOM text preview immediately left of the activity toggle"`
  - `npm run check`

#### Exit criteria

- The targeted integration test passes and the drawer keeps its centered resize grip.

## Execution Checklist

- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Phase 2 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log

1. `sed -n '1,220p' /Users/skryl/.codex/skills/phased-prd-red-green/SKILL.md`
   - result: `pass`
   - notes: loaded the required workflow
2. `sed -n '1,260p' /Users/skryl/.codex/skills/phased-prd-red-green/references/prd_red_green_template.md`
   - result: `pass`
   - notes: loaded the PRD template
3. `npm run test:integration -- tests/integration/test-driver.test.ts -t "shows a live browser DOM text preview immediately left of the activity toggle"`
   - result: `fail`
   - notes: red signal was missing preview header controls
4. `cargo test --manifest-path src-tauri/Cargo.toml browser::braille_tests::`
   - result: `fail`
   - notes: first green attempt hit a Rust `let ... else` syntax error in `browser_preview_result`
5. `cargo test --manifest-path src-tauri/Cargo.toml browser::braille_tests::`
   - result: `pass`
   - notes: targeted Rust preview-format tests passed after the syntax fix
6. `npm run test:integration -- tests/integration/test-driver.test.ts -t "shows a live browser DOM text preview immediately left of the activity toggle"`
   - result: `fail`
   - notes: the first green test exposed a brittle ANSI-mode assertion in the integration probe
7. `npm run test:integration -- tests/integration/test-driver.test.ts -t "shows a live browser DOM text preview immediately left of the activity toggle"`
   - result: `pass`
   - notes: preview header controls, refresh cycling, format switching, live updates, and centered grip all passed
8. `npm run check`
   - result: `pass`
   - notes: Svelte and TypeScript checks passed
9. `git diff --check -- prd/2026_03_24_browser_text_preview_controls_prd.md src-tauri/src/browser.rs src-tauri/src/lib.rs src/lib/tauri.ts src/lib/BrowserTile.svelte src/lib/BrowserTextPreviewDrawer.svelte tests/integration/test-driver.test.ts`
   - result: `pass`
   - notes: no whitespace or patch hygiene issues in the touched files
