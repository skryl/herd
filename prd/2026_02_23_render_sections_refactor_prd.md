# Render Sections Refactor PRD

## Status

Completed (2026-02-23)

## Context

`src/tui/render_surface.rs` still contains a single large `render` function that combines layout orchestration with all pane-specific rendering logic (sessions, herds, details, content, herder log, status bar). This makes UI changes high-risk and hard to review.

## Goals

1. Extract pane-specific rendering into focused modules/functions.
2. Keep `render_surface` focused on top-level layout orchestration.
3. Preserve current behavior and TUI output semantics.

## Non-goals

1. No visual redesign.
2. No keybinding or state-management behavior changes.
3. No changes to settings overlay rendering behavior.

## Phased Plan (Red/Green)

### Phase 1: Baseline and extraction boundary

Red:
1. Run existing TUI tests as baseline for current rendering behavior.
2. Confirm exact extraction boundaries for pane-specific rendering blocks.

Green:
1. Freeze extraction plan for sessions, herds, details, content, herder log, and status bar sections.

Refactor:
1. Keep call order and model mutation points identical.

Exit criteria:
1. Baseline tests are green and boundaries are documented.

### Phase 2: Extract pane renderers

Red:
1. Move one pane section at a time while preserving behavior.
2. Compile after each move to catch visibility/borrow issues.

Green:
1. Add `src/tui/render_sections.rs`.
2. Move pane rendering code into section functions.
3. Rewire `src/tui/render_surface.rs` to call section functions.

Refactor:
1. Remove duplicated style-building code where practical.
2. Keep all APIs `pub(super)` scoped.

Exit criteria:
1. `render_surface.rs` no longer contains monolithic pane rendering blocks.
2. Build succeeds.

### Phase 3: Validation and completion

Red:
1. Run targeted TUI test suite.
2. Run full regression gates used by repo process.

Green:
1. Fix any regressions.
2. Re-run gates until fully green.

Refactor:
1. Final import cleanup and file-size sanity check.

Exit criteria:
1. `cargo test --test tui_app` passes.
2. `cargo test --tests` passes.
3. `./scripts/run-integration-tests.sh --tier fast` passes.
4. `./scripts/run-integration-tests.sh --tier full` passes.

## Exit Criteria Per Phase

1. Phase 1: baseline and boundaries confirmed.
2. Phase 2: pane renderers extracted and rewired.
3. Phase 3: all test gates green.

## Acceptance Criteria

1. Pane rendering logic is modularized in a dedicated render-sections module.
2. `src/tui/render_surface.rs` is substantially smaller and easier to reason about.
3. No behavior regressions in TUI or integration tests.
4. PRD checklist and status reflect completed work.

## Risks and Mitigations

1. Risk: subtle rendering regressions from move/copy changes.
   Mitigation: keep logic order intact and run existing render-focused tests.
2. Risk: borrow/visibility issues with `AppModel` mutable access.
   Mitigation: isolate mutable operations to content/log section functions and compile iteratively.
3. Risk: style regressions due to refactoring shared styles.
   Mitigation: centralize style computation in one helper and re-use unchanged values.

## Implementation Checklist

- [x] Phase 1 baseline TUI tests run and extraction boundaries confirmed
- [x] Phase 2 render sections module added
- [x] Phase 2 `render_surface` rewired
- [x] Phase 3 `cargo test --test tui_app` green
- [x] Phase 3 `cargo test --tests` green
- [x] Phase 3 `./scripts/run-integration-tests.sh --tier fast` green
- [x] Phase 3 `./scripts/run-integration-tests.sh --tier full` green
- [x] PRD status updated to Completed with date
