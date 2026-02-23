# TUI Runtime Split PRD

## Status

Completed (2026-02-23)

## Context

`src/tui/runtime.rs` currently combines multiple concerns:

1. Rule evaluation/dispatch orchestration.
2. Session discovery/filtering helpers.
3. Pane content cache update and trimming logic.
4. UI-session construction and status-source assignment.

This creates a broad hotspot and makes runtime changes harder to review safely.

## Goals

1. Split runtime logic into focused modules by concern.
2. Preserve all runtime behavior and public call surfaces.
3. Keep existing tests fully green.

## Non-goals

1. No rule-engine behavior changes.
2. No session status semantics changes.
3. No UI/UX changes.

## Phased Plan (Red/Green)

### Phase 1: Baseline and extraction boundary

Red:
1. Run targeted baseline tests for runtime/TUI/integration behavior.
2. Identify exact boundaries for runtime submodules.

Green:
1. Freeze extraction plan:
   - `runtime_rules` for herd-rule evaluation/dispatch.
   - `runtime_sessions` for discovery/cache/ui-session construction helpers.

Refactor:
1. Preserve function signatures and call order.

Exit criteria:
1. Baseline green and boundaries finalized.

### Phase 2: Extract runtime rules module

Red:
1. Move rule-dispatch helpers incrementally and compile.

Green:
1. Add `src/tui/runtime_rules.rs`.
2. Move rule-related helper functions from `runtime.rs`.
3. Re-export or import as needed without API drift.

Refactor:
1. Keep helper visibility constrained to `pub(crate)`/private.

Exit criteria:
1. Rule logic is no longer implemented directly in `runtime.rs`.

### Phase 3: Extract runtime sessions module

Red:
1. Move session/cache/ui-session builders incrementally and compile.

Green:
1. Add `src/tui/runtime_sessions.rs`.
2. Move session discovery/filter/cache/ui-session helper functions.
3. Keep `runtime.rs` as a focused aggregator.

Refactor:
1. Keep shared data types (`PaneContentCacheEntry`) in stable location.

Exit criteria:
1. Session/cache/ui-session helpers are no longer implemented directly in `runtime.rs`.

### Phase 4: Validation and completion

Red:
1. Run targeted and full regression gates.

Green:
1. Fix regressions and rerun until green.

Refactor:
1. Final import cleanup and formatting.

Exit criteria:
1. `cargo test --test tui_app` passes.
2. `cargo test --tests` passes.
3. `./scripts/run-integration-tests.sh --tier fast` passes.
4. `./scripts/run-integration-tests.sh --tier full` passes.

## Exit Criteria Per Phase

1. Phase 1: baseline + boundaries confirmed.
2. Phase 2: rule module extracted.
3. Phase 3: session/cache module extracted.
4. Phase 4: all required gates green.

## Acceptance Criteria

1. Runtime code is modularized by concern into dedicated files.
2. Behavior remains unchanged under existing test suite.
3. PRD checklist and status reflect completion.

## Risks and Mitigations

1. Risk: subtle runtime ordering drift.
   Mitigation: preserve function signatures and invocation order exactly.
2. Risk: visibility/import breakages across sibling modules.
   Mitigation: compile after each extraction chunk.
3. Risk: regression in status-source/caching behavior.
   Mitigation: run full integration tiers after targeted checks.

## Implementation Checklist

- [x] Phase 1 baseline boundaries identified
- [x] Phase 2 `runtime_rules` module extracted and rewired
- [x] Phase 3 `runtime_sessions` module extracted and rewired
- [x] Phase 4 `cargo test --test tui_app` green
- [x] Phase 4 `cargo test --tests` green
- [x] Phase 4 `./scripts/run-integration-tests.sh --tier fast` green
- [x] Phase 4 `./scripts/run-integration-tests.sh --tier full` green
- [x] PRD status updated to Completed with date
