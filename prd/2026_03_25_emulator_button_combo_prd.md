# Emulator Button Combo PRD

## Header

1. Title: Emulator button combo extension call
2. Status: Completed
3. Date: 2026-03-25

## Context

The `game-boy` and `jsnes` browser extensions already expose single-button control through `set_button` and `release_all_buttons`, but they do not provide a higher-level way to run scripted input sequences such as menu navigation or short gameplay combos. The user wants a discoverable `button_combo` extension call for both emulators that accepts a button sequence and plays it back with a delay between presses.

## Goals

1. Add a discoverable `button_combo` method to both emulator extension manifests.
2. Allow callers to provide a sequence of button steps and a shared delay between step starts.
3. Run combos using scheduled timers so emulator time continues to advance while the combo is executing.
4. Reuse each extension's existing button press/release path instead of creating a second control implementation.

## Non-goals

1. Making browser extension methods asynchronous in the Rust bridge.
2. Adding macro recording, looping combos, or persisted input scripts.
3. Generalizing combo playback to non-emulator browser extensions.

## Scope

1. Define a shared `button_combo` contract for `game-boy` and `jsnes`.
2. Implement timer-backed combo scheduling in each extension.
3. Ensure `release_all_buttons` cancels any pending combo playback for that caller/context before clearing held buttons.
4. Add focused browser-page and integration coverage for discovery and execution.

## Risks and mitigations

1. Risk: blocking delays would freeze the emulator and make input timing meaningless.
   Mitigation: schedule combo steps with `setTimeout` and return immediately.
2. Risk: queued combo steps could conflict with manual button presses or later combo calls.
   Mitigation: maintain explicit pending timer state and cancel prior combo playback before starting a new one for the same control scope.
3. Risk: JSNES ownership rules are per caller tile, while Game Boy is a single shared controller.
   Mitigation: keep one scheduler per Game Boy page and one scheduler per JSNES caller-owned player.

## Acceptance criteria

1. Both extension manifests advertise `button_combo`.
2. `button_combo` accepts a required `sequence` object-array argument and optional `delay_ms` / `hold_ms` integer arguments.
3. A combo triggers the same button state transitions as repeated `set_button` / `release_all_buttons` calls.
4. Starting a new combo or calling `release_all_buttons` cancels pending steps in the same control scope.
5. Integration coverage confirms every advertised controller button can be pressed and released through `extension_call`.
6. Targeted browser-page and integration tests pass.

## Phased Plan (Red/Green)

### Phase 0

1. Objective
   - Lock the public API shape with failing tests.
2. Red
   - Add page-level tests expecting `button_combo` in both manifests.
   - Add unit/browser tests expecting combos to update button state over time.
   - Add integration assertions expecting `button_combo` to be discoverable and callable through `extension_call`.
   - Expected failure signal: missing manifest method, unknown extension method, or unchanged button state after combo playback.
3. Green
   - Implement only the timer-backed combo scheduling and manifest updates needed to satisfy the tests.
   - Verification commands:
     - `npx vitest run extensions/browser/game-boy/game-boy.test.ts extensions/browser/jsnes/jsnes.test.ts`
     - `npx vitest run --config vitest.integration.config.ts tests/integration/worker-root-mcp.test.ts -t "exposes game boy extension metadata and bundled ROM controls|exposes jsnes extension metadata and multiplayer controls"`
4. Exit criteria
   - Tests fail first for the missing combo API, then pass with the intended manifest and playback behavior.

### Phase 1

1. Objective
   - Confirm cancellation semantics and adjacent regressions.
2. Red
   - Add assertions that a new combo or `release_all_buttons` cancels pending timer-backed playback in the same control scope.
   - Expected failure signal: stale timer steps continue mutating button state after cancellation.
3. Green
   - Implement explicit pending-timer cleanup in each extension and re-run focused tests.
   - Verification commands:
     - `npx vitest run extensions/browser/game-boy/game-boy.test.ts extensions/browser/jsnes/jsnes.test.ts`
4. Exit criteria
   - Pending combo playback no longer leaks past cancellation boundaries.

### Phase 2

1. Objective
   - Finalize status and evidence.
2. Red
   - N/A beyond regression verification.
3. Green
   - Update PRD status/checklist and capture exact command outcomes.
   - Verification commands:
     - Re-run focused passing commands from earlier phases.
4. Exit criteria
   - Checklist is complete and the PRD is marked completed.

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
2. `sed -n '1,240p' /Users/skryl/.codex/skills/phased-prd-red-green/references/prd_red_green_template.md`
   - result: pass
   - notes: loaded PRD template
3. `rg -n "button_combo|set_button|release_all_buttons|manifest|methods|HerdBrowserExtension|extension_call" extensions/browser/game-boy extensions/browser/jsnes tests/integration/worker-root-mcp.test.ts`
   - result: pass
   - notes: located current emulator extension API surfaces and tests
4. `npx vitest run extensions/browser/game-boy/game-boy.test.ts extensions/browser/jsnes/jsnes.test.ts`
   - result: fail
   - notes: red phase confirmed missing `button_combo` methods and unsupported controller call paths
5. `npx vitest run --config vitest.integration.config.ts tests/integration/worker-root-mcp.test.ts -t "exposes game boy extension metadata and bundled ROM controls|exposes jsnes extension metadata and multiplayer controls"`
   - result: fail
   - notes: red phase confirmed `extension_call` metadata did not advertise `button_combo`
6. `npx vitest run extensions/browser/game-boy/game-boy.test.ts extensions/browser/jsnes/jsnes.test.ts`
   - result: pass
   - notes: page-level and controller tests verified manifest discovery, combo playback, and cancellation semantics
7. `npx vitest run --config vitest.integration.config.ts tests/integration/worker-root-mcp.test.ts -t "exposes game boy extension metadata and bundled ROM controls|exposes jsnes extension metadata and multiplayer controls"`
   - result: pass
   - notes: integration coverage verified `button_combo` discovery plus per-button `extension_call` press/release coverage for both emulators
