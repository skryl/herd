# Render Surface Refactor PRD

## Status

Completed (2026-02-23)

## Context

`src/tui.rs` still contains a very large render surface function (`render`) that mixes pane layout/rendering for sessions, herds, details, content, log, and status bar. This keeps `tui.rs` as a broad change hotspot despite previous modularization.

## Goals

1. Move render-surface orchestration out of `src/tui.rs` into a focused module.
2. Preserve all rendering behavior and key UX semantics.
3. Keep APIs stable for tests (`render_to_string`).

## Non-goals

1. No visual redesign.
2. No keybinding changes.
3. No logic changes to state management or runtime loop.

## Phased Plan (Red/Green)

### Phase 1: Baseline and extraction boundary

Red:
1. Capture baseline tests.
2. Identify render-only dependencies and call sites.

Green:
1. Lock extraction boundary to `render` and `render_to_string` surfaces.

Refactor:
1. Keep ownership and state mutations exactly as-is.

Exit criteria:
1. Clear extraction map finalized before edits.

### Phase 2: Extract render surface module

Red:
1. Isolate current render function and associated direct imports.

Green:
1. Add `src/tui/render_surface.rs`.
2. Move `render` and `render_to_string` logic into the new module.
3. Rewire `src/tui.rs` to call/import module functions.

Refactor:
1. Keep visibility narrow (`pub(super)`).
2. Remove duplicate code from `src/tui.rs`.

Exit criteria:
1. `src/tui.rs` no longer defines the full render function body.
2. Render behavior remains unchanged.

### Phase 3: Cleanup and validation

Red:
1. Compile and catch import/visibility issues.

Green:
1. Run `cargo fmt`.
2. Run required test gates and resolve regressions.

Refactor:
1. Trim unused imports from `src/tui.rs`.

Exit criteria:
1. `cargo test --tests` passes.
2. `./scripts/run-integration-tests.sh --tier fast` passes.
3. `./scripts/run-integration-tests.sh --tier full` passes.

## Exit Criteria Per Phase

1. Phase 1: scope confirmed.
2. Phase 2: render surface moved + rewired.
3. Phase 3: all test gates green.

## Acceptance Criteria

1. Render surface logic is modularized under `src/tui/render_surface.rs`.
2. `src/tui.rs` is materially smaller and cleaner.
3. Behavior and tests remain green.

## Risks and Mitigations

1. Risk: subtle render regressions.
   Mitigation: move logic intact and run existing TUI + integration tests.
2. Risk: private visibility breakages.
   Mitigation: keep module as `tui` child with `super::` references.
3. Risk: state mutation ordering changes.
   Mitigation: preserve original sequencing and function body order.

## Implementation Checklist

- [x] Phase 1 baseline and extraction boundary confirmed
- [x] Phase 2 render surface extracted to `src/tui/render_surface.rs`
- [x] Phase 2 call sites rewired in `src/tui.rs`
- [x] Phase 3 `cargo test --tests` green
- [x] Phase 3 `./scripts/run-integration-tests.sh --tier fast` green
- [x] Phase 3 `./scripts/run-integration-tests.sh --tier full` green
- [x] PRD status updated to Completed with date
