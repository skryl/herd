# Key Handling State Refactor PRD

## Status

Completed (2026-02-23)

## Context

`src/tui/key_handling.rs` contained both key-dispatch logic and a large set of state mutation helpers (selection, herd assignment, scroll behavior, herd mode normalization). This mixed responsibilities and made interaction changes harder to reason about.

## Goals

1. Keep key dispatch in `key_handling`.
2. Move interaction state mutation helpers into a dedicated module.
3. Preserve all behavior and key semantics.

## Non-goals

1. No keybinding changes.
2. No render/UI changes.
3. No config/rule behavior changes.

## Phased Plan (Red/Green)

### Phase 1: Baseline and extraction boundary

Red:
1. Run TUI key/interaction tests as baseline.
2. Identify helper methods to move out of key dispatch module.

Green:
1. Freeze extraction boundary to state mutation helpers only.

Refactor:
1. Keep method names and signatures stable.

Exit criteria:
1. Baseline green and method move list finalized.

### Phase 2: Extract interaction state module

Red:
1. Move helper methods incrementally and compile.

Green:
1. Add `src/tui/interaction_state.rs`.
2. Move selection/herd/scroll/normalization methods.
3. Keep `handle_key` and key-specific dispatch in `key_handling.rs`.

Refactor:
1. Use `pub(super)` visibility for cross-module helper calls.

Exit criteria:
1. `key_handling.rs` focuses on dispatch, not state helper implementations.
2. Build succeeds.

### Phase 3: Validation and completion

Red:
1. Run targeted and full regression gates.

Green:
1. Fix any regressions and rerun until green.

Refactor:
1. Final formatting and import cleanup.

Exit criteria:
1. `cargo test --test tui_app` passes.
2. `cargo test --tests` passes.
3. `./scripts/run-integration-tests.sh --tier fast` passes.
4. `./scripts/run-integration-tests.sh --tier full` passes.

## Exit Criteria Per Phase

1. Phase 1: baseline and extraction boundaries confirmed.
2. Phase 2: interaction state module extracted and rewired.
3. Phase 3: required test gates green.

## Acceptance Criteria

1. Key dispatch and state helpers are separated into dedicated modules.
2. Behavior remains unchanged under existing test suite.
3. PRD checklist/status reflects completion.

## Risks and Mitigations

1. Risk: key path regressions from visibility issues.
   Mitigation: preserve method signatures and run TUI integration tests.
2. Risk: accidental behavior drift in scroll/selection helpers.
   Mitigation: move helper bodies with minimal edits and validate via full test gates.

## Implementation Checklist

- [x] Phase 1 baseline `cargo test --test tui_app` green
- [x] Phase 2 `interaction_state` module added and rewired
- [x] Phase 3 `cargo test --test tui_app` green
- [x] Phase 3 `cargo test --tests` green
- [x] Phase 3 `./scripts/run-integration-tests.sh --tier fast` green
- [x] Phase 3 `./scripts/run-integration-tests.sh --tier full` green
- [x] PRD status updated to Completed with date
