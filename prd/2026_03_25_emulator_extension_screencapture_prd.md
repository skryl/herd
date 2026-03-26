# Emulator Extension Screencapture PRD

## Header

1. Title: Emulator Extension Screencapture
2. Status: Completed
3. Date: 2026-03-25

## Context

The `game-boy` and `jsnes` browser extensions expose control APIs through `HerdBrowserExtension`, but they do not expose a way to capture the emulator screen through `extension_call`. The browser tile already has a screenshot pipeline that supports `image`, `braille`, `ascii`, `ansi`, and `text`, and that formatting logic should be reused instead of duplicated inside each extension.

## Goals

1. Add an extension API method that captures the current emulator screen for both Game Boy and JSNES.
2. Support the same screenshot format arguments accepted by browser tile screenshots: `image`, `braille`, `ascii`, `ansi`, and `text`, plus `columns` where applicable.
3. Reuse the shared Rust screenshot formatting path so emulator extensions and browser tiles stay consistent.

## Non-goals

1. Generalize arbitrary extension media capture beyond the screenshot contract needed here.
2. Add OCR or semantic text extraction for emulator framebuffers.
3. Change the existing browser tile screenshot API semantics outside the new extension screenshot path.

## Scope

1. Add a documented `screenshot` method to the `game-boy` and `jsnes` extension manifests.
2. Return a raw PNG screenshot source from each extension page.
3. Extend Rust `call_browser_extension` handling to detect extension screenshot payloads and convert them into the existing browser screenshot result shapes.
4. Add focused unit and integration coverage.

## Risks and mitigations

1. Risk: `text` format on emulator pixels has no DOM text source.
   Mitigation: define extension `text` screenshots as image-derived plain text output using the shared grayscale text renderer path, while preserving the existing browser tile DOM-text path.
2. Risk: extension methods currently return generic JSON and could collide with screenshot payload detection.
   Mitigation: use an explicit tagged screenshot-source object shape.
3. Risk: canvas capture differences between Game Boy and JSNES.
   Mitigation: keep each extension method responsible only for finding its canvas and exporting PNG bytes.

## Acceptance criteria

1. `extension_call` on both `game-boy` and `jsnes` advertises a `screenshot` method.
2. Calling `extension_call` `screenshot` with `format: image` returns a PNG payload.
3. Calling `extension_call` `screenshot` with `format: braille|ascii|ansi|text` returns the expected text screenshot payload shape.
4. Focused tests for both extensions pass.

## Phased Plan (Red/Green)

### Phase 0

1. Objective
   - Add failing tests and coverage targets for the new screenshot method.
2. Red
   - Add extension/page tests expecting `screenshot` in the manifests and expecting a capture payload after a ROM is loaded.
   - Add an integration test expecting `extension_call screenshot` to return browser-style screenshot payloads for emulator pages.
   - Expected failure signal: missing method in manifest, unknown extension method, or screenshot payload shape mismatch.
3. Green
   - Implement only the minimum screenshot contract and routing needed to make those tests pass.
   - Verification commands:
     - `npx vitest run extensions/browser/game-boy/game-boy.test.ts extensions/browser/jsnes/jsnes.test.ts`
     - `npx vitest run --config vitest.integration.config.ts tests/integration/worker-root-mcp.test.ts -t "game boy extension metadata|jsnes extension metadata"`
4. Exit criteria
   - Tests fail first for the missing screenshot API, then pass after implementation.

### Phase 1

1. Objective
   - Reuse the shared Rust screenshot formatter for extension-provided emulator PNGs.
2. Red
   - Add a Rust unit test for extension screenshot source parsing and PNG-to-result conversion, including `text`.
   - Expected failure signal: parse error or unsupported `text` format from PNG-backed extension screenshots.
3. Green
   - Add a tagged extension screenshot source contract and post-process it in `call_browser_extension`.
   - Verification commands:
     - `cargo test --manifest-path src-tauri/Cargo.toml browser`
4. Exit criteria
   - Rust tests pass and the browser extension screenshot path returns the same payload shapes as browser screenshots.

### Phase 2

1. Objective
   - Finalize docs/status and confirm no regressions in adjacent extension-call behavior.
2. Red
   - N/A beyond regression verification.
3. Green
   - Update PRD status/checklist and report exact command outcomes.
   - Verification commands:
     - Re-run focused passing commands from earlier phases.
4. Exit criteria
   - Checklist is complete and evidence is recorded.

## Execution Checklist

- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Phase 2 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log

1. `sed -n '1,220p' /Users/skryl/.codex/skills/phased-prd-red-green/SKILL.md`
   - result: pass
   - notes: loaded required skill workflow
2. `sed -n '1,220p' /Users/skryl/.codex/skills/phased-prd-red-green/references/prd_red_green_template.md`
   - result: pass
   - notes: loaded PRD template
3. `npx vitest run extensions/browser/game-boy/game-boy.test.ts extensions/browser/jsnes/jsnes.test.ts`
   - result: fail
   - notes: red phase confirmed missing `screenshot` method/coverage before implementation
4. `npx vitest run --config vitest.integration.config.ts tests/integration/worker-root-mcp.test.ts -t "exposes game boy extension metadata and bundled ROM controls|exposes jsnes extension metadata and multiplayer controls"`
   - result: fail
   - notes: integration red phase confirmed `extension_call screenshot` was not exposed
5. `cargo test --manifest-path src-tauri/Cargo.toml browser`
   - result: pass
   - notes: shared Rust screenshot-source parsing and formatting tests passed after implementation
6. `npx vitest run --config vitest.integration.config.ts tests/integration/worker-root-mcp.test.ts -t "exposes game boy extension metadata and bundled ROM controls|exposes jsnes extension metadata and multiplayer controls"`
   - result: pass
   - notes: Herd-facing `extension_call screenshot` now works for both emulator extensions
7. `npx vitest run extensions/browser/game-boy/game-boy.test.ts extensions/browser/jsnes/jsnes.test.ts`
   - result: pass
   - notes: page-level manifests and raw PNG screenshot sources pass for both extensions
