## Title

Browser Preview ANSI Rendering

## Status

Completed

## Date

2026-03-25

## Context

The browser preview drawer already supports an `ansi` mode, but the frontend currently renders the ANSI payload as raw text inside a plain `<pre>`. The backend ANSI output is intentionally structured: it emits `38;2` foreground colors, `48;2` background colors, `0m` resets, newlines, and `▀` half-block characters. The preview drawer should render those colors in-app instead of exposing escape sequences.

## Goals

- Render ANSI preview output with visible foreground and background colors in the browser preview drawer.
- Keep the existing plain-text rendering path for `text`, `braille`, and `ascii`.
- Add focused regression coverage proving ANSI mode renders styled spans instead of raw escape text.

## Non-goals

- Supporting arbitrary terminal control sequences beyond the ANSI subset emitted by Herd.
- Switching the backend to a different ANSI payload format.
- Replacing the preview drawer with a full terminal emulator.

## Scope

- `src/lib/BrowserTextPreviewDrawer.svelte`
- `src/lib/ansiPreview.ts`
- `src/lib/ansiPreview.test.ts`
- `tests/integration/test-driver.test.ts`

## Risks and mitigations

- Risk: a loose ANSI parser could silently misrender unsupported sequences.
  - Mitigation: support only the exact subset emitted by the backend and ignore everything else.
- Risk: inline color rendering could break the monospace cell alignment needed for the half-block renderer.
  - Mitigation: keep the same monospace font, `white-space: pre`, and per-character span grouping.
- Risk: integration assertions could be flaky if they depend on exact pixel colors.
  - Mitigation: assert on rendered span structure and inline RGB styles, not screenshots.

## Acceptance criteria

- Switching the browser preview drawer to `ANSI` renders styled spans with visible colors.
- Raw `\u001b[` escape text is no longer displayed in ANSI mode.
- Existing `text`, `braille`, and `ascii` preview rendering continues to work.
- Focused unit and integration coverage pass.

## Phased Plan

### Phase 0

#### Objective

Capture the missing ANSI rendering behavior in the existing browser preview integration.

#### Red

- Extend the browser preview integration to require styled ANSI output and no raw escape text.
- Expected failure signal: the preview still shows raw ANSI text and no styled segments.

#### Green

- No implementation in this phase.
- Verification commands:
  - `npm run test:integration -- tests/integration/test-driver.test.ts -t "shows a live browser DOM text preview immediately left of the activity toggle"`

#### Exit criteria

- The focused integration test fails because ANSI mode is not being rendered.

### Phase 1

#### Objective

Implement a constrained ANSI parser and render styled preview segments for ANSI mode.

#### Red

- Re-run the focused browser preview integration after the red assertions land.
- Expected failure signal: ANSI rendering is still raw text.

#### Green

- Add a small frontend parser for Herd’s ANSI subset.
- Render ANSI preview output as styled spans while preserving the existing plain-text path for other formats.
- Verification commands:
  - `npm run test:unit -- --run src/lib/ansiPreview.test.ts`
  - `npm run test:integration -- tests/integration/test-driver.test.ts -t "shows a live browser DOM text preview immediately left of the activity toggle"`

#### Exit criteria

- ANSI preview mode renders styled output and the focused checks pass.

## Execution Checklist

- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log

1. `sed -n '1,260p' src/lib/BrowserTextPreviewDrawer.svelte`
   - result: `pass`
   - notes: confirmed ANSI mode still renders through the plain `<pre>` path
2. `sed -n '790,1065p' tests/integration/test-driver.test.ts`
   - result: `pass`
   - notes: loaded the existing browser preview integration coverage
3. `rg -n "vitest|test:unit|svelte" src/lib/*.test.ts src/lib/**/*.test.ts tests -g '!tests/integration/**'`
   - result: `pass`
   - notes: confirmed the existing unit-test surface for a new parser helper
4. `npm run test:integration -- tests/integration/test-driver.test.ts -t "shows a live browser DOM text preview immediately left of the activity toggle"`
   - result: `fail`
   - notes: red signal was missing an ANSI render surface and styled segments
5. `npm run test:unit -- --run src/lib/ansiPreview.test.ts`
   - result: `pass`
   - notes: constrained ANSI parser coverage passed
6. `npm run check`
   - result: `pass`
   - notes: Svelte and TypeScript checks passed after wiring the ANSI renderer
7. `npm run test:integration -- tests/integration/test-driver.test.ts -t "shows a live browser DOM text preview immediately left of the activity toggle"`
   - result: `fail`
   - notes: first green run hit a root-agent bootstrap timeout before reaching the preview assertions
8. `npm run test:integration -- tests/integration/test-driver.test.ts -t "shows a live browser DOM text preview immediately left of the activity toggle"`
   - result: `pass`
   - notes: ANSI mode rendered styled spans without raw escape text
9. `git diff --check -- prd/2026_03_25_browser_preview_ansi_rendering_prd.md src/lib/ansiPreview.ts src/lib/ansiPreview.test.ts src/lib/BrowserTextPreviewDrawer.svelte tests/integration/test-driver.test.ts`
   - result: `pass`
   - notes: no whitespace or patch hygiene issues in the touched files
