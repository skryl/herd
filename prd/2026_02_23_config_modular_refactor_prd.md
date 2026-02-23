# Config Modular Refactor PRD

## Status

Completed (2026-02-23)

## Context

After recent modularization, `src/config.rs` still mixes:

1. config model definitions and merge behavior,
2. home-directory path helpers,
3. herd mode defaults/sanitization and legacy migration helpers.

This coupling increases change risk around settings evolution.

## Goals

1. Extract path helpers and herd-mode helper logic into dedicated submodules.
2. Preserve existing `config` public APIs and file formats.
3. Keep runtime/config behavior unchanged.

## Non-goals

1. No schema changes for `settings.json`.
2. No behavior changes for default values or migration handling.
3. No rule engine semantic changes.

## Phased Plan (Red/Green)

### Phase 1: Helper boundary extraction

Red:
1. Baseline tests.
2. Identify extraction boundaries for path helpers and herd-mode helper utilities.

Green:
1. Add `src/config/paths.rs` for config/state path resolution.
2. Add `src/config/herd_modes.rs` for mode defaults/sanitization/legacy-file helpers.
3. Rewire `src/config.rs` to use extracted helpers while preserving API.

Refactor:
1. Keep helper visibility narrow (`pub(super)` where possible).
2. Keep external function names stable via wrapper/re-export.

Exit criteria:
1. `src/config.rs` no longer contains all helper implementations inline.
2. Behavior unchanged.

### Phase 2: Validation and cleanup

Red:
1. Run full test gates.

Green:
1. Fix regressions from extraction only.
2. Re-run all required gates to green.

Refactor:
1. Remove stale imports and dead code.
2. Confirm module boundaries are clear.

Exit criteria:
1. `cargo test --tests` passes.
2. `./scripts/run-integration-tests.sh --tier fast` passes.
3. `./scripts/run-integration-tests.sh --tier full` passes.

## Exit Criteria Per Phase

1. Phase 1: config helper modules extracted and wired.
2. Phase 2: full test gates green.

## Acceptance Criteria

1. New `src/config/paths.rs` and `src/config/herd_modes.rs` are added and used.
2. Public config behavior remains unchanged.
3. All required tests pass.
4. PRD status/checklist reflect completion.

## Risks and Mitigations

1. Risk: subtle default/sanitization drift.
   Mitigation: extraction-only move with existing config and integration tests.
2. Risk: migration behavior regressions.
   Mitigation: preserve legacy markdown checks and normalization paths as-is.
3. Risk: path resolution regressions.
   Mitigation: preserve HOME-based path logic and run config resilience tests.

## Implementation Checklist

- [x] Phase 1 helper extraction completed
- [x] Phase 2 `cargo test --tests` green
- [x] Phase 2 `./scripts/run-integration-tests.sh --tier fast` green
- [x] Phase 2 `./scripts/run-integration-tests.sh --tier full` green
- [x] PRD status updated to Completed with date
