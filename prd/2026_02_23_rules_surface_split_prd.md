# Rules Surface Split PRD

## Status

Completed (2026-02-23)

## Context

`src/rules.rs` remains a high-churn file that combines:

1. Rule schema/types and constants.
2. Rule-file load/default helpers.
3. LLM decision JSON parsing and input-scope helpers.
4. Public API wiring and tests.

This coupling makes changes riskier and obscures ownership boundaries.

## Goals

1. Split `src/rules.rs` into smaller focused modules with stable external APIs.
2. Keep behavior unchanged for rule loading, parsing, and execution.
3. Preserve existing call sites through explicit re-exports.

## Non-goals

1. No rule evaluation semantic changes.
2. No schema changes for rule JSON.
3. No CLI/TUI behavior changes.

## Phased Plan (Red/Green)

### Phase 1: Baseline and extraction map

Red:
1. Run rule-focused tests and capture baseline.
2. Freeze extraction boundaries for type/file/decision helpers.

Green:
1. Confirm module boundaries and stable export list.

Refactor:
1. Keep names/signatures stable at `crate::rules` surface.

Exit criteria:
1. Baseline tests are green and extraction map is explicit.

### Phase 2: Module extraction

Red:
1. Move helper groups incrementally and compile after each step.

Green:
1. Add `src/rules/types.rs` for constants and schema/runtime types.
2. Add `src/rules/file_io.rs` for load/default file helpers.
3. Add `src/rules/decision.rs` for LLM decision parse + input slicing helper.
4. Re-export moved items from `src/rules.rs`.

Refactor:
1. Minimize visibility (`pub(crate)`/private) where possible.
2. Remove obsolete imports from `src/rules.rs`.

Exit criteria:
1. `src/rules.rs` is primarily API wiring + tests.

### Phase 3: Validation and completion

Red:
1. Run targeted and broad regression gates.

Green:
1. Fix regressions and rerun until green.

Refactor:
1. Final formatting/import cleanup.

Exit criteria:
1. `cargo test --lib` passes.
2. `cargo test --tests` passes.
3. `./scripts/run-integration-tests.sh --tier fast` passes.
4. `./scripts/run-integration-tests.sh --tier full` passes.

## Exit Criteria Per Phase

1. Phase 1: baseline captured and boundaries finalized.
2. Phase 2: modules extracted and re-exported with stable behavior.
3. Phase 3: required test gates green and PRD finalized.

## Acceptance Criteria

1. Rules concerns are split into focused modules under `src/rules/`.
2. External imports from `crate::rules` remain valid.
3. Full test and integration gates are green.
4. PRD status/checklist reflects completion.

## Risks and Mitigations

1. Risk: accidental visibility breakage after extraction.
   Mitigation: re-export moved symbols and compile early/often.
2. Risk: subtle JSON parse behavior drift.
   Mitigation: preserve function bodies and keep existing tests unchanged.
3. Risk: downstream imports depending on internal layout.
   Mitigation: keep public API anchored at `src/rules.rs`.

## Implementation Checklist

- [x] Phase 1 baseline captured
- [x] Phase 2 `types.rs` extracted
- [x] Phase 2 `file_io.rs` extracted
- [x] Phase 2 `decision.rs` extracted
- [x] Phase 2 re-exports wired and compile green
- [x] Phase 3 `cargo test --lib` green
- [x] Phase 3 `cargo test --tests` green
- [x] Phase 3 `./scripts/run-integration-tests.sh --tier fast` green
- [x] Phase 3 `./scripts/run-integration-tests.sh --tier full` green
- [x] PRD status updated to Completed with date
