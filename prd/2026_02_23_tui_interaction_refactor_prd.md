# TUI Interaction Refactor PRD

## Status

Completed (2026-02-23)

## Context

After runtime loop and log/status extraction, `src/tui/state_navigation.rs` still combines multiple concerns:

1. key/input handling and focus transitions,
2. herd interaction actions,
3. session reconciliation and content scroll state.

The key/input handling branch is still dense and a frequent change surface.

## Goals

1. Extract key/input handling and herd interaction actions into a dedicated module.
2. Preserve existing keybinding behavior and state transitions.
3. Keep public model APIs stable.

## Non-goals

1. No new keybindings.
2. No behavior changes for herd assignment or input mode handling.
3. No rendering/runtime changes.

## Phased Plan (Red/Green)

### Phase 1: Key handling extraction

Red:
1. Confirm baseline tests.
2. Isolate key/input and herd action method boundaries.

Green:
1. Add `src/tui/key_handling.rs`.
2. Move `handle_key` and related key/focus/herd action helpers.
3. Keep shared methods used by sibling modules available via `pub(super)` as needed.

Refactor:
1. Remove moved methods/imports from `src/tui/state_navigation.rs`.
2. Keep session reconciliation and content scroll methods in `state_navigation`.

Exit criteria:
1. `src/tui/state_navigation.rs` no longer directly owns key/input handling logic.
2. Behavior remains unchanged.

### Phase 2: Validation and cleanup

Red:
1. Run full test gates.

Green:
1. Fix extraction regressions only.
2. Re-run all gates to green.

Refactor:
1. Final import and visibility cleanup.

Exit criteria:
1. `cargo test --tests` passes.
2. `./scripts/run-integration-tests.sh --tier fast` passes.
3. `./scripts/run-integration-tests.sh --tier full` passes.

## Exit Criteria Per Phase

1. Phase 1: key/input handling extracted.
2. Phase 2: all required gates green.

## Acceptance Criteria

1. `src/tui/key_handling.rs` exists and is wired.
2. `src/tui/state_navigation.rs` is smaller and focused.
3. Existing tests pass unchanged.

## Risks and Mitigations

1. Risk: subtle keybinding behavior drift.
   Mitigation: extraction-only changes and full TUI integration tests.
2. Risk: method visibility breakage across sibling modules.
   Mitigation: adjust to `pub(super)` only where required and compile/test immediately.

## Implementation Checklist

- [x] Phase 1 key/input handling extraction completed
- [x] Phase 2 `cargo test --tests` green
- [x] Phase 2 `./scripts/run-integration-tests.sh --tier fast` green
- [x] Phase 2 `./scripts/run-integration-tests.sh --tier full` green
- [x] PRD status updated to Completed with date
