# Settings Modular Refactor PRD

## Status

Completed (2026-02-23)

## Context

After earlier modularization passes, `src/tui.rs` still embeds a large settings surface area:

1. Settings-specific `AppModel` behaviors (overlay lifecycle, editing, dropdowns, herd mode editing).
2. Settings overlay rendering helpers and dialogs.

This keeps unrelated concerns tightly coupled and makes TUI changes riskier.

## Goals

1. Extract settings behavior methods into a dedicated module.
2. Extract settings rendering functions into a dedicated module.
3. Preserve all existing behavior and key bindings.

## Non-goals

1. No UX changes.
2. No changes to settings schema or persistence format.
3. No changes to runtime rule evaluation behavior.

## Phased Plan (Red/Green)

### Phase 1: Baseline and scope

Red:
1. Capture baseline tests for current behavior.
2. Map all settings-related methods/functions and dependencies.

Green:
1. Confirm extraction boundary limited to settings behavior + settings rendering.

Refactor:
1. Keep public API changes minimal (`pub(super)` only where needed).

Exit criteria:
1. Clear extraction list finalized before code movement.

### Phase 2: Settings behavior extraction

Red:
1. Isolate settings-focused methods currently in `impl AppModel`.

Green:
1. Create `src/tui/settings_actions.rs`.
2. Move settings methods into a dedicated `impl AppModel` block in that module.
3. Rewire `src/tui.rs` with module import only.

Refactor:
1. Keep method signatures and key handling behavior unchanged.
2. Remove moved implementations from `src/tui.rs`.

Exit criteria:
1. Settings behavior is no longer implemented directly in `src/tui.rs`.

### Phase 3: Settings rendering extraction

Red:
1. Isolate settings render functions (`render_settings_overlay` and child dialogs).

Green:
1. Create `src/tui/settings_render.rs`.
2. Move settings render helpers/functions to that module.
3. Rewire `render()` to call into module exports.

Refactor:
1. Keep render data flow unchanged.
2. Remove now-duplicate helpers from `src/tui.rs`.

Exit criteria:
1. Settings UI render functions no longer live in `src/tui.rs`.

### Phase 4: Validation and completion

Red:
1. Run targeted + broad tests to detect regressions.

Green:
1. Fix regressions and rerun gates.

Refactor:
1. Final import cleanup and `cargo fmt`.

Exit criteria:
1. `cargo test --tests` passes.
2. `./scripts/run-integration-tests.sh --tier fast` passes.
3. `./scripts/run-integration-tests.sh --tier full` passes.

## Exit Criteria Per Phase

1. Phase 1: baseline + extraction boundaries defined.
2. Phase 2: settings behavior moved to module.
3. Phase 3: settings rendering moved to module.
4. Phase 4: full test gates green and PRD updated.

## Acceptance Criteria

1. Settings behavior logic lives in `src/tui/settings_actions.rs`.
2. Settings rendering logic lives in `src/tui/settings_render.rs`.
3. `src/tui.rs` is materially smaller and clearer.
4. All test gates are green.

## Risks and Mitigations

1. Risk: behavior drift in key handling.
   Mitigation: copy method bodies intact and verify with TUI integration tests.
2. Risk: private visibility/module access issues.
   Mitigation: use sibling submodules with `super::` references and compile quickly.
3. Risk: regressions in settings workflows.
   Mitigation: run full test tiers and preserve existing tests unchanged.

## Implementation Checklist

- [x] Phase 1 baseline and extraction boundary captured
- [x] Phase 2 settings behavior extracted to `settings_actions`
- [x] Phase 3 settings rendering extracted to `settings_render`
- [x] Phase 4 `cargo test --tests` green
- [x] Phase 4 `./scripts/run-integration-tests.sh --tier fast` green
- [x] Phase 4 `./scripts/run-integration-tests.sh --tier full` green
- [x] PRD status updated to Completed with date
