# Render Helpers Split PRD

## Status

Completed (2026-02-23)

## Context

`src/tui/render_helpers.rs` still mixes:

1. Left-pane row assembly/state presentation.
2. Shared style/label helpers.
3. Time/text formatting helpers.
4. Input preview and newline normalization helpers.

This combines distinct concerns in one file and keeps it as a large hotspot.

## Goals

1. Extract text/time/preview formatting helpers into a dedicated module.
2. Keep call sites stable via `render_helpers` re-exports.
3. Preserve render behavior.

## Non-goals

1. No visual changes.
2. No status semantics changes.
3. No keybinding/input behavior changes.

## Phased Plan (Red/Green)

### Phase 1: Baseline and boundaries

Red:
1. Run TUI baseline tests.
2. Finalize extraction boundary.

Green:
1. Freeze extraction boundary to formatting/preview/newline helpers.

Refactor:
1. Keep function names/signatures unchanged.

Exit criteria:
1. Baseline green and extraction map confirmed.

### Phase 2: Extract formatting helper module

Red:
1. Move helper functions incrementally and compile.

Green:
1. Add `src/tui/render_text_utils.rs`.
2. Move formatting/preview helpers from `render_helpers.rs`.
3. Re-export from `render_helpers.rs` to keep call sites stable.

Refactor:
1. Keep helper visibility scoped to `pub(super)`.

Exit criteria:
1. `render_helpers.rs` focuses on row-building/layout helpers.

### Phase 3: Validation and completion

Red:
1. Run targeted and full regression gates.

Green:
1. Fix regressions and rerun until green.

Refactor:
1. Final import cleanup and formatting.

Exit criteria:
1. `cargo test --test tui_app` passes.
2. `cargo test --tests` passes.
3. `./scripts/run-integration-tests.sh --tier fast` passes.
4. `./scripts/run-integration-tests.sh --tier full` passes.

## Exit Criteria Per Phase

1. Phase 1: baseline + boundaries confirmed.
2. Phase 2: formatting helper module extracted and rewired.
3. Phase 3: required gates green.

## Acceptance Criteria

1. Render helper concerns are more modular with stable call sites.
2. Behavior remains unchanged.
3. PRD checklist/status reflects completion.

## Risks and Mitigations

1. Risk: formatting behavior drift.
   Mitigation: move function bodies intact and rerun render-focused tests.
2. Risk: import/re-export visibility mistakes.
   Mitigation: compile immediately after extraction.

## Implementation Checklist

- [x] Phase 1 baseline captured
- [x] Phase 2 `render_text_utils` extracted and rewired
- [x] Phase 3 `cargo test --test tui_app` green
- [x] Phase 3 `cargo test --tests` green
- [x] Phase 3 `./scripts/run-integration-tests.sh --tier fast` green
- [x] Phase 3 `./scripts/run-integration-tests.sh --tier full` green
- [x] PRD status updated to Completed with date
