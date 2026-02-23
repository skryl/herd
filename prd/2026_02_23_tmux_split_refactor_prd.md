# Tmux Module Split Refactor PRD

## Status

Completed (2026-02-23)

## Context

`src/tmux.rs` currently combines:

1. Public `TmuxAdapter` trait and shared exports.
2. Control mode multiplexer/session-client coordination.
3. System tmux adapter command execution and send/capture logic.
4. Parsing wrapper and helper/test utilities.

Although parser/control internals already live in submodules, this top-level file remains a broad hotspot.

## Goals

1. Split tmux orchestration into focused modules while preserving API behavior.
2. Keep `TmuxAdapter`, `SystemTmuxAdapter`, and `ControlModeMultiplexer` call surfaces stable.
3. Keep full regression suite green.

## Non-goals

1. No tmux protocol behavior changes.
2. No change to session filtering semantics.
3. No test strategy changes.

## Phased Plan (Red/Green)

### Phase 1: Baseline and extraction boundaries

Red:
1. Run tmux/runtime-focused baseline tests.
2. Identify extraction boundaries.

Green:
1. Freeze split plan:
   - `tmux/system.rs` for system adapter + tmux command helpers.
   - `tmux/multiplexer.rs` for control mode multiplexer.

Refactor:
1. Preserve function/type names and signatures.

Exit criteria:
1. Baseline green and boundaries finalized.

### Phase 2: Extract system adapter module

Red:
1. Move system adapter code incrementally and compile.

Green:
1. Add `src/tmux/system.rs`.
2. Move `SystemTmuxAdapter` and command helper logic.
3. Re-export from `tmux.rs`.

Refactor:
1. Keep helper visibility scoped.

Exit criteria:
1. System adapter logic is no longer implemented in `tmux.rs`.

### Phase 3: Extract multiplexer module

Red:
1. Move multiplexer code incrementally and compile.

Green:
1. Add `src/tmux/multiplexer.rs`.
2. Move `ControlOutputEvent` and `ControlModeMultiplexer`.
3. Re-export from `tmux.rs`.

Refactor:
1. Keep control-session lifecycle behavior unchanged.

Exit criteria:
1. Multiplexer logic is no longer implemented in `tmux.rs`.

### Phase 4: Validation and completion

Red:
1. Run targeted and full regression gates.

Green:
1. Fix regressions and rerun until green.

Refactor:
1. Final import/format cleanup.

Exit criteria:
1. `cargo test --test tui_app` passes.
2. `cargo test --tests` passes.
3. `./scripts/run-integration-tests.sh --tier fast` passes.
4. `./scripts/run-integration-tests.sh --tier full` passes.

## Exit Criteria Per Phase

1. Phase 1: baseline + boundaries confirmed.
2. Phase 2: system adapter extracted.
3. Phase 3: multiplexer extracted.
4. Phase 4: all required gates green.

## Acceptance Criteria

1. Tmux logic is modularized into dedicated `system` and `multiplexer` modules.
2. Existing behavior remains unchanged.
3. PRD status/checklist reflects completion.

## Risks and Mitigations

1. Risk: subtle tmux command behavior drift.
   Mitigation: move logic with minimal edits; run integration tmux tests.
2. Risk: control client lifecycle regressions.
   Mitigation: preserve stop/is_exited/sync ordering exactly.
3. Risk: visibility/import regressions.
   Mitigation: compile incrementally and keep re-export layer stable.

## Implementation Checklist

- [x] Phase 1 baseline captured
- [x] Phase 2 `system` module extracted and rewired
- [x] Phase 3 `multiplexer` module extracted and rewired
- [x] Phase 4 `cargo test --test tui_app` green
- [x] Phase 4 `cargo test --tests` green
- [x] Phase 4 `./scripts/run-integration-tests.sh --tier fast` green
- [x] Phase 4 `./scripts/run-integration-tests.sh --tier full` green
- [x] PRD status updated to Completed with date
