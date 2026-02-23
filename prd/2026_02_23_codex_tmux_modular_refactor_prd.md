# Codex/Tmux Modular Refactor PRD

## Status

Completed (2026-02-23)

## Context

The TUI surface has been modularized, but core runtime dependencies still have large single-file modules:

1. `src/codex.rs` mixes process-state assessment logic with app-server transport and JSON-RPC parsing.
2. `src/tmux.rs` mixes control-mode process management, tmux command execution, and output parsing.

This makes boundary ownership unclear and raises change risk for future status and tmux behavior work.

## Goals

1. Extract cohesive submodules for `codex` and `tmux` while preserving behavior.
2. Keep public APIs stable for existing callers.
3. Reduce top-level module size and isolate parsing/transport concerns.

## Non-goals

1. No feature changes to session status logic.
2. No tmux command semantics changes.
3. No config format changes.

## Phased Plan (Red/Green)

### Phase 1: Codex extraction

Red:
1. Run baseline tests to confirm current behavior.
2. Identify extraction boundaries for app-server client/DTO parsing vs process assessment logic.

Green:
1. Add `src/codex/app_server.rs` for app-server transport and wire protocol DTOs.
2. Keep `CodexSessionStateProvider` behavior unchanged while delegating to the extracted client.
3. Keep `assessment_from_codex_state` and command detection behavior unchanged.

Refactor:
1. Minimize visibility to `pub(super)` where possible.
2. Keep function signatures used outside the module stable.

Exit criteria:
1. `src/codex.rs` no longer directly implements the app-server client internals.
2. Tests remain green.

### Phase 2: Tmux extraction

Red:
1. Isolate control-mode parsing/process helpers and list-panes parsing boundaries.
2. Confirm expected parser behavior via existing tests.

Green:
1. Add `src/tmux/control.rs` for control-mode client lifecycle and output decode.
2. Add `src/tmux/parser.rs` for list-panes/control-line parsing helpers.
3. Rewire `SystemTmuxAdapter`/multiplexer to call extracted modules.

Refactor:
1. Preserve existing `TmuxAdapter` API.
2. Keep tmux option-setting behavior unchanged.

Exit criteria:
1. `src/tmux.rs` retains orchestration and adapter surface only.
2. Parser/client internals are in dedicated submodules.
3. Tests remain green.

### Phase 3: Validation and cleanup

Red:
1. Run targeted tests and integration gates.

Green:
1. Fix regressions from extraction only.
2. Re-run tests until all pass.

Refactor:
1. Remove stale imports and dead code.
2. Keep modules clearly named and documented via code layout.

Exit criteria:
1. `cargo test --tests` passes.
2. `./scripts/run-integration-tests.sh --tier fast` passes.
3. `./scripts/run-integration-tests.sh --tier full` passes.

## Exit Criteria Per Phase

1. Phase 1: codex app-server internals extracted.
2. Phase 2: tmux parser/control internals extracted.
3. Phase 3: full test gates green.

## Acceptance Criteria

1. New `src/codex/app_server.rs` exists and is wired.
2. New `src/tmux/control.rs` and `src/tmux/parser.rs` exist and are wired.
3. Existing public behavior is preserved.
4. All test gates pass and checklist is complete.

## Risks and Mitigations

1. Risk: silent behavior drift in status assessment.
   Mitigation: keep assessment logic in place and run existing status tests.
2. Risk: tmux parser regressions.
   Mitigation: move parser logic as-is and preserve parser tests.
3. Risk: visibility/import breakage across modules.
   Mitigation: use `pub(super)` and compile/test at each step.

## Implementation Checklist

- [x] Phase 1 baseline and codex extraction completed
- [x] Phase 2 baseline and tmux extraction completed
- [x] Phase 3 `cargo test --tests` green
- [x] Phase 3 `./scripts/run-integration-tests.sh --tier fast` green
- [x] Phase 3 `./scripts/run-integration-tests.sh --tier full` green
- [x] PRD status updated to Completed with date
