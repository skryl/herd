# Core Fixture Integration Tests PRD

## Status

Completed (2026-02-21)

## Context

The repository has phase-based tests that validate individual modules and selected end-to-end tmux paths, but there is no dedicated fixture-driven integration suite that composes core runtime behavior across worker output classification, herder rule evaluation, and herd dispatch state updates.

We need deterministic integration tests that use captured worker and herder fixture outputs so core behavior can be validated without relying on external APIs or brittle runtime setup.

## Goals

1. Add fixture-backed integration tests that cover core runtime flows from worker output to herder action.
2. Use worker output fixtures to validate classification and status-transition semantics.
3. Use herder output fixtures to validate regex/LLM rule evaluation and command templating.
4. Validate herd dispatch behavior and registry updates using fixture-driven sessions/assessments.
5. Keep tests deterministic and local-only (no external network calls).

## Non-goals

1. Replacing existing phase tests.
2. Adding live provider API integration tests.
3. Refactoring production modules beyond what tests require.

## Phased Plan (Red/Green)

### Phase 1: Fixture scaffolding and loader helpers

Red:
1. Add tests that attempt to load worker and herder fixtures and fail when fixtures/helpers are missing.

Green:
1. Add fixture directory structure for worker and herder outputs.
2. Add shared test helpers for loading fixture JSON/text and building domain/runtime objects.

Refactor:
1. Keep fixture loading code centralized in one helper module.

Exit criteria:
1. Fixture helpers can load all declared worker/herder fixture assets.

### Phase 2: Worker status + rules integration scenarios

Red:
1. Add failing integration tests for worker classification scenarios loaded from fixtures.
2. Add failing integration tests for regex rule evaluation and LLM rule evaluation from herder fixtures.

Green:
1. Implement fixture-based classification matrix assertions.
2. Implement fixture-based rule execution assertions, including template variables and ordered evaluation behavior.

Refactor:
1. Reduce duplicated setup with helper constructors.

Exit criteria:
1. Classification and rule-evaluation integration tests pass using fixture data only.

### Phase 3: Herd dispatch + persistence integration scenarios

Red:
1. Add failing integration test that loads fixture registry/session state and expects command dispatch + state updates.

Green:
1. Implement monitor-cycle integration assertions for send-keys behavior, nudge accounting, and persisted assessment metadata.
2. Add config-path integration assertion that round-trips fixture-like settings and materializes herd-mode rule files.

Refactor:
1. Keep assertions focused on behavioral contracts, not implementation internals.

Exit criteria:
1. Herd dispatch/persistence/config integration tests pass and remain deterministic.

## Acceptance Criteria

1. New fixture-backed integration test suite exists under `tests/`.
2. Worker fixture outputs are used to drive classification assertions.
3. Herder fixture outputs are used to drive regex/LLM rule assertions.
4. Herd monitor cycle behavior is validated with fixture-derived session/registry state.
5. No external API calls are required by the new tests.
6. Targeted integration tests and full `cargo test` pass.

## Risks and Mitigations

1. Risk: Fixture schemas drift from production structs.
   Mitigation: Use serde-compatible fixture shapes and typed loaders.
2. Risk: Overlap with existing phase tests causes maintenance duplication.
   Mitigation: Keep this suite focused on cross-module composition paths.
3. Risk: Flaky timing assumptions in status logic.
   Mitigation: Use fixed fixture timestamps and explicit prior-state fixtures.
4. Risk: Future changes break many tests at once.
   Mitigation: Keep fixtures scenario-based and assertions scoped to stable contracts.

## Implementation Checklist

- [x] Phase 1 complete (fixtures + helper loaders)
- [x] Phase 2 complete (classification + rules integrations)
- [x] Phase 3 complete (herd dispatch + config integrations)
- [x] Targeted integration tests green
- [x] Full `cargo test` green
- [x] PRD status updated to Completed with date
