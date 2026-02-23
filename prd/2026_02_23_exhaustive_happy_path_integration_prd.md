# Exhaustive Happy-Path Integration Suite PRD

## Status

Completed (2026-02-23)

## Context

The project had broad integration coverage but it was organized as `phase*` test targets. That naming and layout made it harder to reason about behavioral ownership and did not provide an explicit fast-vs-full integration execution contract.

The goal for this change is to keep the existing integration coverage, restructure it into a path-based suite, and define deterministic tiered execution for happy-path validation across CLI, TUI, tmux runtime, Codex status sourcing, rules, herd state, config persistence, and fixture-based orchestration.

## Goals

1. Replace `phase*` integration test target names with path/behavior-based names.
2. Preserve and integrate existing test coverage into the new suite (not side-by-side duplication).
3. Provide deterministic fast and full integration tiers for local and container execution.
4. Keep fixture-backed behavior coverage for worker output and herder output.
5. Keep test behavior and assertions focused on happy-path application flows.

## Non-goals

1. Add live external provider API integration tests.
2. Introduce randomized/flaky timing tests.
3. Expand into failure-path chaos testing in this PRD.

## Phased Plan (Red/Green)

### Phase 1: Baseline and target mapping

Red:
1. Capture baseline full test run signal before migration.
2. Identify every `phase*` target and map to a path-based target name.

Green:
1. Confirm target map covers all existing tests.
2. Define fast-tier and full-tier target sets.

Refactor:
1. Remove old naming from test target paths and test fixture identifiers.

Exit criteria:
1. No `phase*` test target files remain under `tests/`.
2. All old targets have explicit replacements.

### Phase 2: Test suite migration

Red:
1. Migrate test files to new path-based targets and run tests expecting any breakages from stale names.

Green:
1. Update all migrated test files to remove stale `phase*` identifiers.
2. Ensure each migrated target compiles and executes under its new name.

Refactor:
1. Keep helper/fixture modules reusable and unchanged unless required for migration.

Exit criteria:
1. `cargo test --tests` passes with only new path-based test targets.

### Phase 3: Tiered execution contract

Red:
1. Add tier support to integration runner and validate unsupported/missing tier handling.

Green:
1. Implement `--tier fast|full` in `scripts/run-integration-tests.sh`.
2. Keep `full` as default and add deterministic target list for `fast`.
3. Ensure Docker test wrapper forwards tier args transparently.

Refactor:
1. Update README examples to reference new test targets and tier usage.

Exit criteria:
1. `scripts/run-integration-tests.sh --tier fast` passes.
2. `scripts/run-integration-tests.sh --tier full` (or default) passes.
3. Docs reflect new target names.

## Exit Criteria Per Phase

1. Phase 1: complete target map and no naming ambiguity.
2. Phase 2: successful migration with green full test suite.
3. Phase 3: documented and validated fast/full integration execution paths.

## Acceptance Criteria

1. The integration suite no longer uses `phase*` test target naming.
2. Existing happy-path coverage is preserved in renamed targets.
3. A fast deterministic tier exists for PR-style runs.
4. A full deterministic tier exists for complete integration verification.
5. Container and local test commands use the same tier contract.
6. Full `cargo test --tests` is green after migration.

## Risks and Mitigations

1. Risk: missed rename leaves dead commands/docs.
   Mitigation: grep for `phase*` across tests/docs/scripts and update references.
2. Risk: migration introduces accidental coverage loss.
   Mitigation: preserve test bodies and assertions while renaming targets only.
3. Risk: tier drift between local and Docker.
   Mitigation: centralize tier parsing in `scripts/run-integration-tests.sh` and pass through from Docker wrapper.

## Implementation Checklist

- [x] Capture baseline with pre-migration full test run
- [x] Rename all `tests/phase*.rs` files to path-based targets
- [x] Remove remaining `phase*` identifiers from migrated tests
- [x] Add `--tier fast|full` contract to `scripts/run-integration-tests.sh`
- [x] Keep deterministic fast target set and full default behavior
- [x] Update README integration examples to new target naming/tier usage
- [x] Add net-new happy-path integrations for settings save/reload, model refresh+dropdown selection, codex app-server source rendering, live rule-dispatch loop, and tracked/codex-enriched `sessions` output
- [x] Run fast tier, full tier, and full `cargo test --tests`
- [x] Mark PRD status as Completed with date
