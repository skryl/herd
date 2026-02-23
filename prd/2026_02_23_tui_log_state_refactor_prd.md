# TUI Log/Status State Refactor PRD

## Status

Completed (2026-02-23)

## Context

After extracting the TUI runtime loop, `src/tui/state_navigation.rs` still bundled herder-log state management, status message state, and tmux server status state with navigation/input handling.

## Goals

1. Separate herder-log/status state concerns from navigation/input handling.
2. Preserve all existing public behavior and key handling semantics.
3. Keep module boundaries clearer for future iteration.

## Non-goals

1. No UX changes.
2. No rule evaluation behavior changes.
3. No tmux runtime behavior changes.

## Phased Plan (Red/Green)

### Phase 1: Extract log/status state methods

Red:
1. Confirm baseline tests before extraction.
2. Identify method boundaries for log/status state.

Green:
1. Add `src/tui/log_status_state.rs`.
2. Move herder-log filter/scroll/append methods and status/tmux server message methods.
3. Keep method signatures and visibility compatible for sibling module usage.

Refactor:
1. Remove moved methods/imports from `src/tui/state_navigation.rs`.
2. Wire new module in `src/tui.rs`.

Exit criteria:
1. `src/tui/state_navigation.rs` no longer owns herder-log/status state internals.
2. Behavior remains unchanged.

### Phase 2: Validation and cleanup

Red:
1. Run full test gates.

Green:
1. Fix any extraction regressions.
2. Re-run gates to green.

Refactor:
1. Final import cleanup.

Exit criteria:
1. `cargo test --tests` passes.
2. `./scripts/run-integration-tests.sh --tier fast` passes.
3. `./scripts/run-integration-tests.sh --tier full` passes.

## Exit Criteria Per Phase

1. Phase 1: methods extracted and module wired.
2. Phase 2: full gates green.

## Acceptance Criteria

1. `src/tui/log_status_state.rs` exists and is used.
2. State/navigation code is cleaner and more modular.
3. Full test gates pass.

## Risks and Mitigations

1. Risk: visibility breakages for methods used by sibling modules.
   Mitigation: use `pub(super)` for cross-module methods.
2. Risk: subtle log scroll/filter behavior drift.
   Mitigation: extraction-only move with full integration gates.

## Implementation Checklist

- [x] Phase 1 log/status state extraction completed
- [x] Phase 2 `cargo test --tests` green
- [x] Phase 2 `./scripts/run-integration-tests.sh --tier fast` green
- [x] Phase 2 `./scripts/run-integration-tests.sh --tier full` green
- [x] PRD status updated to Completed with date
