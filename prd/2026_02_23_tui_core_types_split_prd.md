# TUI Core Types Split PRD

## Status

Completed (2026-02-23)

## Context

`src/tui.rs` remains the largest file and still contains:

1. Core TUI domain types (`UiSession`, focus/input enums, status source, log/server internals).
2. `AppModel` storage plus constructor/core getters.
3. Top-level runtime/render wrapper functions and module wiring.

Separating core types/model data from module wiring will reduce coupling and improve maintainability.

## Goals

1. Extract core TUI data types into a dedicated module.
2. Extract `AppModel` struct + constructor/core accessors into a dedicated module.
3. Preserve the existing `crate::tui` API and behavior.

## Non-goals

1. No runtime behavior changes.
2. No UI/UX changes or keybinding changes.
3. No rule-engine semantic changes.

## Phased Plan (Red/Green)

### Phase 1: Baseline and boundaries

Red:
1. Run TUI-focused baseline tests.
2. Freeze extraction boundaries for types vs model-core methods.

Green:
1. Confirm stable export/visibility plan for sibling modules.

Refactor:
1. Keep names/signatures unchanged at `crate::tui` surface.

Exit criteria:
1. Baseline green with explicit extraction boundaries.

### Phase 2: Extract core type definitions

Red:
1. Move type groups incrementally and compile after each step.

Green:
1. Add `src/tui/types.rs`.
2. Move core enum/struct type definitions from `src/tui.rs`.
3. Re-export public and internal types from `src/tui.rs`.

Refactor:
1. Use `pub(super)` only for internal-only types.

Exit criteria:
1. Core type definitions no longer implemented directly in `src/tui.rs`.

### Phase 3: Extract `AppModel` core struct/methods

Red:
1. Move `AppModel` struct and constructor/getters incrementally and compile.

Green:
1. Add `src/tui/model_core.rs`.
2. Move `AppModel` definition and core methods from `src/tui.rs`.
3. Re-export from `src/tui.rs` for stable call sites.

Refactor:
1. Keep helper visibility minimal and imports tidy.

Exit criteria:
1. `src/tui.rs` mainly contains module wiring and top-level wrapper functions.

### Phase 4: Validation and completion

Red:
1. Run targeted and broad test gates.

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
2. Phase 2: core type extraction complete and wired.
3. Phase 3: `AppModel` core extraction complete and wired.
4. Phase 4: required gates green and PRD finalized.

## Acceptance Criteria

1. New `src/tui/types.rs` and `src/tui/model_core.rs` are added and used.
2. Existing `crate::tui` API remains stable.
3. Full test/integration gates are green.
4. PRD status/checklist reflects completion.

## Risks and Mitigations

1. Risk: visibility breakage across sibling modules.
   Mitigation: explicit `pub use`/`pub(super) use` in `tui.rs`.
2. Risk: behavior drift in constructor/default initialization.
   Mitigation: move function bodies intact and run TUI-focused tests first.
3. Risk: import cycles or unresolved paths.
   Mitigation: compile after each extraction step and keep root module as wiring point.

## Implementation Checklist

- [x] Phase 1 baseline captured
- [x] Phase 2 `types.rs` extracted and wired
- [x] Phase 3 `model_core.rs` extracted and wired
- [x] Phase 4 `cargo test --test tui_app` green
- [x] Phase 4 `cargo test --tests` green
- [x] Phase 4 `./scripts/run-integration-tests.sh --tier fast` green
- [x] Phase 4 `./scripts/run-integration-tests.sh --tier full` green
- [x] PRD status updated to Completed with date
