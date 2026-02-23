# State Navigation Refactor PRD

## Status

Completed (2026-02-23)

## Context

After settings and render extraction, `src/tui.rs` still contains a large `AppModel` state/navigation block (input mode behavior, focus navigation, herd assignment, content/log scroll, and session set reconciliation).

## Goals

1. Move state-navigation methods into a dedicated module.
2. Keep behavior identical.
3. Further reduce `src/tui.rs` as a change hotspot.

## Non-goals

1. No input behavior changes.
2. No herd/rule semantics changes.
3. No UI redesign.

## Phased Plan (Red/Green)

### Phase 1: Baseline and boundary

Red:
1. Confirm baseline tests are green.
2. Isolate navigation/state method cluster boundaries.

Green:
1. Lock extraction set and dependency map.

Refactor:
1. Keep signatures and visibility unchanged where externally used.

Exit criteria:
1. Extraction map complete before moving code.

### Phase 2: State/navigation extraction

Red:
1. Isolate methods for key handling, herd assignment, scroll state, log filtering, and session reconciliation.

Green:
1. Create `src/tui/state_navigation.rs`.
2. Move methods into `impl AppModel` in that module.
3. Rewire module declarations/imports in `src/tui.rs`.

Refactor:
1. Keep method bodies intact.
2. Remove moved duplicate implementations from `src/tui.rs`.

Exit criteria:
1. State/navigation block is no longer implemented directly in `src/tui.rs`.

### Phase 3: Cleanup and validation

Red:
1. Compile and fix visibility/import issues.

Green:
1. Run `cargo fmt`.
2. Run required test gates and resolve any regressions.

Refactor:
1. Remove stale imports and keep file boundaries clear.

Exit criteria:
1. `cargo test --tests` passes.
2. `./scripts/run-integration-tests.sh --tier fast` passes.
3. `./scripts/run-integration-tests.sh --tier full` passes.

## Exit Criteria Per Phase

1. Phase 1: boundaries confirmed.
2. Phase 2: state/navigation methods extracted and wired.
3. Phase 3: full test gates green.

## Acceptance Criteria

1. State/navigation behavior is modularized under `src/tui/state_navigation.rs`.
2. `src/tui.rs` is materially smaller.
3. Existing tests remain green.

## Risks and Mitigations

1. Risk: regressions in key/input handling.
   Mitigation: preserve method logic verbatim and validate with `tui_app` and integration suites.
2. Risk: private method visibility breakage.
   Mitigation: keep module as child of `tui` and use `super` references.
3. Risk: subtle scroll/filter behavior drift.
   Mitigation: no logic rewrites; extraction-only edits.

## Implementation Checklist

- [x] Phase 1 baseline and extraction boundary confirmed
- [x] Phase 2 state/navigation methods extracted to `src/tui/state_navigation.rs`
- [x] Phase 2 call sites/module wiring updated
- [x] Phase 3 `cargo test --tests` green
- [x] Phase 3 `./scripts/run-integration-tests.sh --tier fast` green
- [x] Phase 3 `./scripts/run-integration-tests.sh --tier full` green
- [x] PRD status updated to Completed with date
