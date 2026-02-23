# Rules/Agent Modular Refactor PRD

## Status

Completed (2026-02-23)

## Context

Recent refactors decomposed TUI, codex, and tmux modules. The next cross-cutting hotspots are:

1. `src/rules.rs` combines rule types, template rendering, regex/LLM evaluation internals, and top-level orchestration.
2. `src/agent.rs` combines process-state model types, heuristic classifier internals, and command classification helpers.

These files are maintainable but still dense and carry mixed concerns.

## Goals

1. Extract cohesive `rules` submodules for evaluation and template/parse internals.
2. Extract cohesive `agent` submodules for heuristic classification and command helper behavior.
3. Preserve all external APIs and runtime behavior.

## Non-goals

1. No changes to rule semantics, status semantics, or herd triggering behavior.
2. No config or persistence schema changes.
3. No UX/UI behavior changes.

## Phased Plan (Red/Green)

### Phase 1: Rules extraction

Red:
1. Baseline current behavior via tests.
2. Identify internals to extract (`evaluate_*`, variable binding, template rendering, and decision parsing helpers).

Green:
1. Add `src/rules/evaluator.rs` for regex/LLM evaluation internals.
2. Add `src/rules/template.rs` for command template rendering internals.
3. Keep root `src/rules.rs` as types + stable public API surface via delegation/re-exports.

Refactor:
1. Keep visibility scoped to `pub(super)` where possible.
2. Keep existing public function names available to callers.

Exit criteria:
1. `src/rules.rs` no longer contains low-level evaluation internals.
2. Behavior unchanged.

### Phase 2: Agent extraction

Red:
1. Baseline process classifier and command helper behavior via tests.
2. Identify extraction boundaries for classifier internals vs command helper functions.

Green:
1. Add `src/agent/classifier.rs` for heuristic classifier implementation helpers.
2. Add `src/agent/command_helpers.rs` for command detection/display helpers.
3. Keep root `src/agent.rs` as model types + public API surface.

Refactor:
1. Keep trait and struct signatures unchanged.
2. Avoid functional rewrites while moving code.

Exit criteria:
1. `src/agent.rs` primarily defines domain types and public entrypoints.
2. Behavior unchanged.

### Phase 3: Validation and cleanup

Red:
1. Run targeted and integration test gates.

Green:
1. Fix extraction regressions only.
2. Re-run all gates to green.

Refactor:
1. Remove stale imports/dead code.
2. Ensure module boundaries are clear and minimal.

Exit criteria:
1. `cargo test --tests` passes.
2. `./scripts/run-integration-tests.sh --tier fast` passes.
3. `./scripts/run-integration-tests.sh --tier full` passes.

## Exit Criteria Per Phase

1. Phase 1: rules internals extracted.
2. Phase 2: agent internals extracted.
3. Phase 3: all test gates green.

## Acceptance Criteria

1. New module files exist under `src/rules/` and `src/agent/` and are wired.
2. Existing public behavior is preserved.
3. Test gates pass.
4. PRD status/checklist reflect final state.

## Risks and Mitigations

1. Risk: subtle rule evaluation drift.
   Mitigation: extraction-only approach and existing integration tests covering rule behavior.
2. Risk: classifier transition logic drift.
   Mitigation: preserve logic verbatim and validate through classifier + TUI/runtime integration tests.
3. Risk: visibility/import breakage.
   Mitigation: stage extraction with compile/test between phases.

## Implementation Checklist

- [x] Phase 1 rules extraction completed
- [x] Phase 2 agent extraction completed
- [x] Phase 3 `cargo test --tests` green
- [x] Phase 3 `./scripts/run-integration-tests.sh --tier fast` green
- [x] Phase 3 `./scripts/run-integration-tests.sh --tier full` green
- [x] PRD status updated to Completed with date
