# TUI Runtime Loop Refactor PRD

## Status

Completed (2026-02-23)

## Context

`src/tui.rs` still contains a large runtime/event loop implementation (`run_tui`) and input dispatch function mixed with model/type definitions. The file has improved but remains a broad hotspot.

## Goals

1. Move runtime loop/orchestration out of `src/tui.rs` into a dedicated runtime-loop module.
2. Preserve current external APIs (`run_tui`, `dispatch_submitted_input_to_selected_pane`).
3. Keep behavior unchanged and covered by existing integration tests.

## Non-goals

1. No behavioral changes to refresh cadence, key handling, rule dispatch, or tmux interaction.
2. No changes to UI rendering behavior.
3. No config/schema changes.

## Phased Plan (Red/Green)

### Phase 1: Runtime loop extraction

Red:
1. Baseline tests before extraction.
2. Identify exact runtime-loop blocks to move (`run_tui`, terminal guard lifecycle, input dispatch).

Green:
1. Add `src/tui/runtime_loop.rs`.
2. Move runtime loop and terminal guard internals there.
3. Keep public wrappers in `src/tui.rs` so callers/tests remain stable.

Refactor:
1. Remove now-unused imports from `src/tui.rs`.
2. Keep module boundaries focused (types/model in root, runtime loop in module).

Exit criteria:
1. `src/tui.rs` no longer directly implements runtime loop internals.
2. Public signatures remain unchanged.

### Phase 2: Validation and cleanup

Red:
1. Run full test gates.

Green:
1. Fix extraction regressions only.
2. Re-run all gates to green.

Refactor:
1. Final import cleanup and line-count check.

Exit criteria:
1. `cargo test --tests` passes.
2. `./scripts/run-integration-tests.sh --tier fast` passes.
3. `./scripts/run-integration-tests.sh --tier full` passes.

## Exit Criteria Per Phase

1. Phase 1: runtime loop extracted and API compatibility preserved.
2. Phase 2: all gates green.

## Acceptance Criteria

1. `src/tui/runtime_loop.rs` exists and is wired.
2. `src/tui.rs` remains API-compatible but slimmer.
3. Full test gates pass.
4. PRD status/checklist updated to completion.

## Risks and Mitigations

1. Risk: regressions in event loop behavior.
   Mitigation: move code with minimal edits and run full integration tests.
2. Risk: visibility issues across sibling modules.
   Mitigation: use `pub(super)` and wrapper functions in parent module.
3. Risk: accidental API break for tests.
   Mitigation: retain public wrappers with existing signatures in `src/tui.rs`.

## Implementation Checklist

- [x] Phase 1 runtime loop extraction completed
- [x] Phase 2 `cargo test --tests` green
- [x] Phase 2 `./scripts/run-integration-tests.sh --tier fast` green
- [x] Phase 2 `./scripts/run-integration-tests.sh --tier full` green
- [x] PRD status updated to Completed with date
