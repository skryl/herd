# TUI Sections and Settings Actions Split PRD

## Status

Completed (2026-02-23)

## Context

After recent refactors, two TUI modules remain oversized hotspots:

1. `src/tui/render_sections.rs` (~560 lines) mixes left-pane, right-pane, and status rendering.
2. `src/tui/settings_actions.rs` (~550 lines) mixes overlay lifecycle, model dropdown behavior, herd mode editing, and key dispatch.

The code is behaviorally stable but still dense and harder to evolve safely.

## Goals

1. Split render sections into left-pane and right-pane focused modules while preserving behavior.
2. Split settings actions into focused modules (overlay/model/herd-mode concerns).
3. Keep all existing tests green without UX or semantic changes.

## Non-goals

1. No visual redesign.
2. No keybinding behavior changes.
3. No config/rule schema changes.

## Phased Plan (Red/Green)

### Phase 1: Baseline and boundaries

Red:
1. Run targeted TUI tests to baseline behavior.
2. Confirm extraction boundaries for render and settings actions.

Green:
1. Freeze module split plan before edits.

Refactor:
1. Preserve method/function names and call order.

Exit criteria:
1. Baseline is green and split boundaries are explicit.

### Phase 2: Render section split

Red:
1. Move left-pane and right-pane functions incrementally and compile.

Green:
1. Add `src/tui/render_left_panes.rs` and `src/tui/render_right_panes.rs`.
2. Rewire `render_surface.rs` and `render_sections.rs` imports/exports.

Refactor:
1. Keep shared style/app-bar helpers centralized.

Exit criteria:
1. Render modules are split by concern and compile cleanly.

### Phase 3: Settings actions split

Red:
1. Move settings action method groups incrementally and compile.

Green:
1. Add focused settings action modules.
2. Keep `handle_settings_key` behavior unchanged.

Refactor:
1. Keep method visibility scoped to `pub(super)`/private where possible.

Exit criteria:
1. `settings_actions.rs` no longer holds all settings action logic.

### Phase 4: Validation and completion

Red:
1. Run targeted and full regression gates.

Green:
1. Fix regressions and rerun until green.

Refactor:
1. Final formatting and import cleanup.

Exit criteria:
1. `cargo test --test tui_app` passes.
2. `cargo test --tests` passes.
3. `./scripts/run-integration-tests.sh --tier fast` passes.
4. `./scripts/run-integration-tests.sh --tier full` passes.

## Exit Criteria Per Phase

1. Phase 1: baseline and boundaries confirmed.
2. Phase 2: render modules split and rewired.
3. Phase 3: settings action modules split and rewired.
4. Phase 4: required test gates green.

## Acceptance Criteria

1. Render logic is split into left/right pane modules with unchanged behavior.
2. Settings actions are split into focused modules with unchanged behavior.
3. Existing tests remain green.
4. PRD checklist and status are updated accurately.

## Risks and Mitigations

1. Risk: accidental keybinding drift.
   Mitigation: preserve `handle_settings_key` dispatch flow and run TUI tests.
2. Risk: render hint/style regressions.
   Mitigation: keep shared style/app-bar helpers centralized and unchanged.
3. Risk: module-visibility/borrow errors.
   Mitigation: compile incrementally after each extraction.

## Implementation Checklist

- [x] Phase 1 baseline TUI tests run and boundaries confirmed
- [x] Phase 2 render left/right modules added and rewired
- [x] Phase 3 settings action modules added and rewired
- [x] Phase 4 `cargo test --test tui_app` green
- [x] Phase 4 `cargo test --tests` green
- [x] Phase 4 `./scripts/run-integration-tests.sh --tier fast` green
- [x] Phase 4 `./scripts/run-integration-tests.sh --tier full` green
- [x] PRD status updated to Completed with date
