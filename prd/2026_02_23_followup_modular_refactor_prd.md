# Follow-up Modular Refactor PRD

## Status

Completed (2026-02-23)

## Context

`src/tui.rs` remains the largest and most cross-cutting file in the codebase. Prior refactors extracted runtime orchestration, but rendering helpers and settings-file IO logic are still co-located with event handling/state transitions, which increases cognitive load and change risk.

## Goals

1. Improve maintainability by extracting additional behavior-preserving modules from `src/tui.rs`.
2. Keep module boundaries clear: settings persistence helpers vs render-time helper logic.
3. Preserve existing runtime behavior and integration coverage.

## Non-goals

1. No UX redesign or new keybindings.
2. No changes to rule evaluation semantics.
3. No broad renaming/reorganization outside touched modules.

## Phased Plan (Red/Green)

### Phase 1: Settings IO helper extraction

Red:
1. Record baseline with test suite before structural change.
2. Identify settings/rule-file helper functions in `src/tui.rs` and their call graph.

Green:
1. Create `src/tui/settings_io.rs`.
2. Move settings/rule-file helper functions into the new module.
3. Rewire `src/tui.rs` to import and call these helpers.

Refactor:
1. Keep helper API narrow and `pub(super)` where possible.
2. Remove now-unused imports from `src/tui.rs`.

Exit criteria:
1. Settings helper logic no longer implemented directly in `src/tui.rs`.
2. Behavior remains unchanged and compiles cleanly.

### Phase 2: Render helper extraction

Red:
1. Identify pure rendering/text/layout helper functions currently in `src/tui.rs`.
2. Confirm no state mutation semantics change in extraction.

Green:
1. Create `src/tui/render_helpers.rs`.
2. Move pure helper structs/functions used by `render` into module.
3. Rewire `render` usage through imported helpers.

Refactor:
1. Keep rendering-specific helpers grouped together.
2. Remove duplicate/unused imports and keep naming consistent.

Exit criteria:
1. `src/tui.rs` primarily contains model/event/render orchestration, not helper implementations.
2. Extracted render helper module builds and tests pass.

### Phase 3: Validation and completion

Red:
1. Run targeted tests around TUI/runtime integration.
2. Run broad integration gates for tmux/runtime workflows.

Green:
1. Fix any regressions discovered during gate execution.
2. Re-run failed gates until all are green.

Refactor:
1. Final import cleanup and small readability pass.

Exit criteria:
1. `cargo test --tests` passes.
2. `./scripts/run-integration-tests.sh --tier fast` passes.
3. `./scripts/run-integration-tests.sh --tier full` passes.

## Exit Criteria Per Phase

1. Phase 1: settings IO helpers extracted and wired.
2. Phase 2: render helper functions extracted and wired.
3. Phase 3: all required test gates pass and PRD status updated.

## Acceptance Criteria

1. New modular helper files exist under `src/tui/` for settings IO and render helpers.
2. `src/tui.rs` is smaller and clearer with unchanged behavior.
3. Test gates are green after refactor.
4. PRD checklist reflects final completion state.

## Risks and Mitigations

1. Risk: behavior drift during function moves.
   Mitigation: move code with minimal edits and preserve signatures where possible.
2. Risk: visibility/privacy breakages between sibling modules.
   Mitigation: use `pub(super)` exports and keep types in parent module.
3. Risk: regressions missed by narrow tests.
   Mitigation: run full integration tiers after targeted compile/test pass.

## Implementation Checklist

- [x] Phase 1 baseline checked and helper move completed
- [x] Phase 1 cleanup completed
- [x] Phase 2 helper move completed
- [x] Phase 2 cleanup completed
- [x] Phase 3 test gates (`cargo test --tests`) green
- [x] Phase 3 test gates (`./scripts/run-integration-tests.sh --tier fast`) green
- [x] Phase 3 test gates (`./scripts/run-integration-tests.sh --tier full`) green
- [x] PRD status set to Completed with date
