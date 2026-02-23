# Config IO/Merge Split PRD

## Status

Completed (2026-02-23)

## Context

`src/config.rs` still contains two larger concerns that remain coupled:

1. Settings file IO and herd-mode file materialization/normalization.
2. Merge/normalization logic for partial config input and accessor helpers.

Splitting these concerns will reduce risk when evolving settings storage or validation behavior.

## Goals

1. Extract config-file IO responsibilities into a dedicated submodule.
2. Extract merge/normalization/accessor responsibilities into a dedicated submodule.
3. Preserve the existing external `AppConfig` API and runtime behavior.

## Non-goals

1. No schema or default-value changes.
2. No config path behavior changes.
3. No changes to rule engine logic.

## Phased Plan (Red/Green)

### Phase 1: Baseline and boundaries

Red:
1. Run config-focused baseline tests.
2. Freeze extraction map for IO vs merge/normalization logic.

Green:
1. Confirm stable public method list and module boundaries.

Refactor:
1. Keep function signatures and call sites unchanged.

Exit criteria:
1. Baseline is green and boundaries are explicit.

### Phase 2: Extract config IO module

Red:
1. Move IO methods incrementally and compile after each move.

Green:
1. Add `src/config/io.rs`.
2. Move `load_from_path`, `save_to_path`, herd-mode file materialization and normalization helpers.
3. Keep behavior and error messaging stable.

Refactor:
1. Keep helper visibility narrow (`pub(super)`/private).

Exit criteria:
1. IO responsibilities are no longer implemented directly in `src/config.rs`.

### Phase 3: Extract merge/normalization module

Red:
1. Move merge/accessor logic and compile after each step.

Green:
1. Add `src/config/merge.rs`.
2. Move `merged` and related normalization/accessor helpers.
3. Keep API stable through unchanged `AppConfig` methods.

Refactor:
1. Remove stale imports and keep root module focused on type/constants/re-exports.

Exit criteria:
1. `src/config.rs` is substantially smaller and focused on core types/constants.

### Phase 4: Validation and completion

Red:
1. Run broad regression gates.

Green:
1. Resolve regressions and rerun to green.

Refactor:
1. Final cleanup and formatting.

Exit criteria:
1. `cargo test --tests` passes.
2. `./scripts/run-integration-tests.sh --tier fast` passes.
3. `./scripts/run-integration-tests.sh --tier full` passes.

## Exit Criteria Per Phase

1. Phase 1: baseline + extraction boundaries confirmed.
2. Phase 2: IO extraction complete and compiled.
3. Phase 3: merge/normalization extraction complete and compiled.
4. Phase 4: all required test gates green and PRD finalized.

## Acceptance Criteria

1. New `src/config/io.rs` and `src/config/merge.rs` modules exist and are wired.
2. External `AppConfig` behavior and APIs are unchanged.
3. Full regression gates are green.
4. PRD status/checklist reflects completion.

## Risks and Mitigations

1. Risk: config migration behavior drift.
   Mitigation: preserve method bodies and run config/integration tests.
2. Risk: private-field visibility breakage across modules.
   Mitigation: keep modules under `config` and compile incrementally.
3. Risk: unnoticed regressions in rule-file normalization side effects.
   Mitigation: run full integration tiers after targeted config tests.

## Implementation Checklist

- [x] Phase 1 baseline captured
- [x] Phase 2 `io.rs` extracted and wired
- [x] Phase 3 `merge.rs` extracted and wired
- [x] Phase 4 `cargo test --tests` green
- [x] Phase 4 `./scripts/run-integration-tests.sh --tier fast` green
- [x] Phase 4 `./scripts/run-integration-tests.sh --tier full` green
- [x] PRD status updated to Completed with date
