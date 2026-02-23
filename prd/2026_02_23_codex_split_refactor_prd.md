# Codex Module Split Refactor PRD

## Status

Completed (2026-02-23)

## Context

`src/codex.rs` currently combines:

1. App-server-backed session state provider and cache refresh logic.
2. Codex turn-status parsing and process-assessment mapping.
3. Codex session CWD discovery and command helpers.
4. Module-level tests.

This is a broad file-level hotspot and makes codex changes harder to isolate.

## Goals

1. Split codex logic into focused modules by concern.
2. Keep all existing public APIs and behavior unchanged.
3. Keep test coverage and full integration gates green.

## Non-goals

1. No behavior changes to status mapping.
2. No app server protocol changes.
3. No runtime decision policy changes.

## Phased Plan (Red/Green)

### Phase 1: Baseline and boundaries

Red:
1. Run codex-focused baseline tests.
2. Identify clear module boundaries (`provider` vs `assessment`).

Green:
1. Freeze extraction boundaries and public re-export plan.

Refactor:
1. Preserve function/type names and signatures.

Exit criteria:
1. Baseline green and extraction map finalized.

### Phase 2: Extract assessment helpers

Red:
1. Move assessment/status parsing/cwd helper logic incrementally and compile.

Green:
1. Add `src/codex/assessment.rs`.
2. Move `CodexTurnStatus`, `CodexThreadState`, command/cwd helpers, assessment mapping.
3. Re-export from `src/codex.rs`.

Refactor:
1. Keep internal helper visibility minimal.

Exit criteria:
1. Assessment helper logic is no longer implemented in `src/codex.rs`.

### Phase 3: Extract provider logic

Red:
1. Move provider state machine and refresh logic incrementally and compile.

Green:
1. Add `src/codex/provider.rs`.
2. Move `CodexSessionStateProvider` implementation.
3. Re-export from `src/codex.rs` and keep call sites stable.

Refactor:
1. Keep `app_server` integration unchanged.

Exit criteria:
1. Provider logic is no longer implemented in `src/codex.rs`.

### Phase 4: Validation and completion

Red:
1. Run targeted codex/TUI/runtime tests.
2. Run full regression gates.

Green:
1. Fix regressions and rerun until green.

Refactor:
1. Final cleanup and formatting.

Exit criteria:
1. `cargo test --test tui_app` passes.
2. `cargo test --tests` passes.
3. `./scripts/run-integration-tests.sh --tier fast` passes.
4. `./scripts/run-integration-tests.sh --tier full` passes.

## Exit Criteria Per Phase

1. Phase 1: baseline + boundaries confirmed.
2. Phase 2: assessment module extracted.
3. Phase 3: provider module extracted.
4. Phase 4: all required test gates green.

## Acceptance Criteria

1. Codex logic is modularized into focused modules with stable API.
2. Existing behavior remains unchanged.
3. PRD status/checklist reflects completion.

## Risks and Mitigations

1. Risk: subtle status-mapping regressions.
   Mitigation: keep code movement literal and preserve tests.
2. Risk: provider refresh/backoff behavior drift.
   Mitigation: preserve provider state fields/branching exactly.
3. Risk: visibility/import cycles.
   Mitigation: keep re-export layer in `codex.rs` and compile incrementally.

## Implementation Checklist

- [x] Phase 1 baseline captured
- [x] Phase 2 `assessment` module extracted and rewired
- [x] Phase 3 `provider` module extracted and rewired
- [x] Phase 4 `cargo test --test tui_app` green
- [x] Phase 4 `cargo test --tests` green
- [x] Phase 4 `./scripts/run-integration-tests.sh --tier fast` green
- [x] Phase 4 `./scripts/run-integration-tests.sh --tier full` green
- [x] PRD status updated to Completed with date
