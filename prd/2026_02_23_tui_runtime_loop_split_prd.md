# TUI Runtime Loop Split PRD

## Status

Completed (2026-02-23)

## Context

`src/tui/runtime_loop.rs` still contains a large monolithic `run_tui` loop that directly inlines:

1. Streaming control-event application.
2. Refresh-cycle session/codex/rule evaluation pipeline.
3. Input/settings dispatch side effects.

This concentrates too much behavior into one function and increases review risk.

## Goals

1. Extract refresh/control-update loop logic into a focused helper module.
2. Keep `run_tui` behavior unchanged.
3. Maintain full test pass across integration tiers.

## Non-goals

1. No event-loop semantic changes.
2. No status/rule logic changes.
3. No UI behavior changes.

## Phased Plan (Red/Green)

### Phase 1: Baseline and boundaries

Red:
1. Run TUI/runtime baseline tests.
2. Identify extraction boundaries for loop helpers.

Green:
1. Freeze helper boundaries:
   - streamed control update pipeline
   - periodic refresh/rule pipeline

Refactor:
1. Preserve call order and side effects.

Exit criteria:
1. Baseline green and helper boundaries finalized.

### Phase 2: Extract runtime loop helpers

Red:
1. Move helper blocks incrementally and compile.

Green:
1. Add `src/tui/runtime_refresh.rs`.
2. Move extracted loop logic into helper functions.
3. Rewire `run_tui` to call helper functions.

Refactor:
1. Keep helper APIs `pub(super)` and behavior-preserving.

Exit criteria:
1. Large inline refresh/control blocks no longer live directly in `run_tui`.

### Phase 3: Validation and completion

Red:
1. Run targeted and full regression gates.

Green:
1. Fix regressions and rerun until green.

Refactor:
1. Final import and formatting cleanup.

Exit criteria:
1. `cargo test --test tui_app` passes.
2. `cargo test --tests` passes.
3. `./scripts/run-integration-tests.sh --tier fast` passes.
4. `./scripts/run-integration-tests.sh --tier full` passes.

## Exit Criteria Per Phase

1. Phase 1: baseline + boundaries confirmed.
2. Phase 2: helper module extracted and rewired.
3. Phase 3: all required gates green.

## Acceptance Criteria

1. `runtime_loop.rs` is materially smaller and clearer.
2. Runtime behavior remains unchanged.
3. PRD status/checklist reflects completion.

## Risks and Mitigations

1. Risk: accidental refresh-order drift.
   Mitigation: move code blocks intact and preserve order.
2. Risk: mutable borrow/ownership errors in helper signatures.
   Mitigation: compile incrementally and keep argument boundaries explicit.
3. Risk: subtle integration regressions.
   Mitigation: run full integration tiers after targeted tests.

## Implementation Checklist

- [x] Phase 1 baseline captured
- [x] Phase 2 helper module extracted and rewired
- [x] Phase 3 `cargo test --test tui_app` green
- [x] Phase 3 `cargo test --tests` green
- [x] Phase 3 `./scripts/run-integration-tests.sh --tier fast` green
- [x] Phase 3 `./scripts/run-integration-tests.sh --tier full` green
- [x] PRD status updated to Completed with date
