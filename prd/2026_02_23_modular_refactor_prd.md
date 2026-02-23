# Modular Refactor PRD

## Status

Completed (2026-02-23)

## Context

The codebase had strong behavior coverage but had grown less modular in two areas:

1. `src/tui.rs` mixed UI rendering/state logic with runtime orchestration/session-build/rule-dispatch plumbing in one large file.
2. Integration tests duplicated Codex app-server stub utilities across multiple test targets.

This refactor improves structure without behavior changes.

## Goals

1. Extract TUI runtime/session orchestration into a dedicated module.
2. Remove duplicated Codex stub helpers across integration tests.
3. Keep behavior unchanged and preserve all existing test gates.

## Non-goals

1. Redesigning UX or keybindings.
2. Changing rule-engine semantics.
3. Splitting all TUI rendering/state code in this pass.

## Phased Plan (Red/Green)

### Phase 1: TUI runtime extraction

Red:
1. Capture baseline with full test run before structural changes.
2. Isolate the runtime-oriented block in `src/tui.rs` (session loading, cache updates, rule dispatch, codex status sourcing).

Green:
1. Move runtime/session orchestration functions into `src/tui/runtime.rs`.
2. Wire `src/tui.rs` to consume the new module APIs.
3. Keep interfaces local (`pub(crate)`) and behavior identical.

Refactor:
1. Remove now-unused imports from `src/tui.rs`.
2. Keep `run_tui` flow readable by separating concerns.

Exit criteria:
1. `src/tui.rs` no longer owns runtime orchestration helper implementations.
2. Runtime flow still compiles and tests remain green.

### Phase 2: Shared Codex test helper extraction

Red:
1. Identify duplicated helper logic in `tests/cli_sessions.rs` and `tests/integration_tmux_runtime.rs` for codex stub/path setup.

Green:
1. Introduce `tests/helpers/codex_stub.rs` with shared helper functions.
2. Update test targets to import helper via path module and remove duplication.

Refactor:
1. Keep helper API narrow and deterministic.
2. Avoid pulling unrelated helper modules into tests that don’t need them.

Exit criteria:
1. No duplicated codex-stub script writer/path resolver logic remains in the updated tests.

### Phase 3: Validation and cleanup

Red:
1. Run full test suite and observe any warnings/regressions after modular changes.

Green:
1. Resolve import/wiring issues and keep behavior unchanged.
2. Re-run integration and full test gates.

Refactor:
1. Ensure no unnecessary warnings are introduced by the refactor paths.

Exit criteria:
1. `cargo test --tests` green.
2. Integration tests remain green with no functional regressions.

## Exit Criteria Per Phase

1. Phase 1: runtime module extraction complete and wired.
2. Phase 2: codex helper duplication removed from target tests.
3. Phase 3: full test suite green post-refactor.

## Acceptance Criteria

1. Runtime/session orchestration code for TUI is modularized under `src/tui/runtime.rs`.
2. Duplicated codex integration helper logic is centralized in `tests/helpers/codex_stub.rs`.
3. Existing behavior remains unchanged.
4. Test gates pass after refactor.

## Risks and Mitigations

1. Risk: behavior drift during function extraction.
   Mitigation: move logic intact and validate with existing integration tests.
2. Risk: helper modularization introduces test coupling.
   Mitigation: path-import helper only where needed.
3. Risk: module boundary changes create compile/import churn.
   Mitigation: keep APIs `pub(crate)` and clean imports immediately.

## Implementation Checklist

- [x] Phase 1 complete (extract runtime orchestration to `src/tui/runtime.rs`)
- [x] Phase 1 cleanup complete (import cleanup in `src/tui.rs`)
- [x] Phase 2 complete (add `tests/helpers/codex_stub.rs`)
- [x] Phase 2 complete (remove duplicated codex helper code from integration tests)
- [x] Phase 3 complete (`cargo test --tests` green)
- [x] PRD status updated to Completed with date
