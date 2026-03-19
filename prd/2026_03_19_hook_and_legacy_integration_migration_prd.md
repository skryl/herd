# Hook Coverage And Legacy Integration Migration PRD

## Status
Completed

## Date
2026-03-19

## Context
Herd already has a typed in-app integration driver and live coverage for the active Claude hook scripts, but the migration off the old `test-e2e.ts` harness is incomplete.

Current gaps:
1. The supported integration suite does not cover the external tmux-created teammate path that the legacy script used as its Claude/tmux flow.
2. One supported integration test still exercises the debug-only `test_dom_query` / `test_dom_keys` path.
3. The legacy `test-e2e.ts` script is still present and still referenced in the README.

The target is to make the typed test driver the only supported automated integration surface, keep the DOM commands only for manual debugging, and cover both configured PreToolUse hooks plus the tmux-driven teammate path in the managed integration suite.

## Goals
1. Cover the active Claude `PreToolUse` hooks through the supported integration suite.
2. Add live integration coverage for tmux-created teammate windows using the managed runtime and typed test driver assertions.
3. Migrate remaining legacy integration coverage off raw DOM debug commands.
4. Delete `test-e2e.ts` and remove it from supported documentation.

## Non-goals
1. Launching the real `claude` CLI in automated integration tests.
2. Making `test_dom_query` or `test_dom_keys` part of the supported automated suite.
3. Reworking tmux topology behavior beyond the minimum needed for reliable coverage.

## Scope
1. Integration test files under `tests/integration/`.
2. Minimal runtime or helper changes needed to drive tmux-backed scenarios.
3. Documentation updates in `README.md`.
4. Removal of the legacy `test-e2e.ts` script.

## Risks And Mitigations
1. Risk: tmux-backed tests can flake on asynchronous snapshot propagation.
   Mitigation: use bounded polling helpers plus `wait_for_idle` and assert against the state projection rather than the DOM.
2. Risk: the active Claude hook coverage can drift from `.claude/settings.json`.
   Mitigation: resolve the configured hook command paths from the settings file in the integration test.
3. Risk: removing the legacy script could drop behavior coverage.
   Mitigation: explicitly map the legacy behaviors to new typed-driver tests before deletion.

## Acceptance Criteria
1. The active `PreToolUse` `Agent` hook is covered through the supported integration suite.
2. The active `PreToolUse` background `Bash` hook is covered through the supported integration suite.
3. A tmux-driven teammate/window creation path is covered through the managed integration runtime and asserted through the typed test driver projection/state.
4. No supported automated integration test relies on `test_dom_query` or `test_dom_keys`.
5. `test-e2e.ts` is deleted.
6. `README.md` no longer presents `test-e2e.ts` as a runnable test path.

## Phased Plan

### Phase 1: Settings-driven hook coverage
#### Objective
Make the active hook coverage explicitly track the configured `PreToolUse` hooks rather than hardcoded script names.

#### Red
- Update the integration suite to resolve the configured `PreToolUse` hook commands from `.claude/settings.json`.
- Expected failure signal:
  - the existing hook tests no longer compile or fail because helper coverage is still hardcoded to script paths.

#### Green
- Refactor the Claude hook integration test to read `.claude/settings.json`, resolve the configured `Agent` and `Bash` hook command paths, and drive those hooks through the managed runtime.
- Verification commands:
  - `npm run test:integration -- tests/integration/claude-hooks.test.ts`

#### Exit Criteria
1. The hook suite uses the configured hook commands for `Agent` and `Bash`.
2. The hook suite still verifies read-only state, lineage, titles, and visible output.

### Phase 2: Replace legacy teammate coverage with typed-driver tmux coverage
#### Objective
Replace the old Claude/tmux flow from `test-e2e.ts` with a managed integration test that covers externally tmux-created teammates/windows and asserts the app state through the typed driver.

#### Red
- Add a new integration test that creates a second pane/window through the isolated runtime's tmux server and expects Herd to surface it as a new tile with parent lineage.
- Add typed-driver assertions for the remaining legacy keyboard/workflow behaviors currently only covered in `test-e2e.ts`.
- Expected failure signal:
  - new tmux-backed coverage is missing or flaky under the current helper set.

#### Green
- Add a tmux-backed integration test and any minimal helper/runtime code needed to drive the isolated tmux server cleanly.
- Replace any remaining automated test usage of `test_dom_query` / `test_dom_keys` with typed-driver requests and projection assertions.
- Verification commands:
  - `npm run test:integration`

#### Exit Criteria
1. The managed integration suite covers the tmux-created teammate/window path.
2. The supported automated suite no longer uses the debug DOM commands.
3. The legacy behaviors have equivalent typed-driver coverage.

### Phase 3: Remove the legacy harness
#### Objective
Delete the old script and clean up docs so the typed integration suite is the only supported automated path.

#### Red
- Remove `test-e2e.ts` references from docs and the repo.
- Expected failure signal:
  - docs still reference the deleted script or the integration suite no longer covers a legacy behavior.

#### Green
- Delete `test-e2e.ts`.
- Update `README.md` to point only at `npm run test:integration` for automated live coverage and note that `test_dom_*` remains debug-only.
- Verification commands:
  - `npm run check`
  - `npm run test:integration`

#### Exit Criteria
1. `test-e2e.ts` is removed.
2. README test instructions align with the new supported path.
3. All targeted checks pass.

## Implementation Checklist
- [x] Phase 1 complete
- [x] Phase 2 complete
- [x] Phase 3 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log
1. `rg -n "claude|hook|test-e2e|test_dom_|test_driver|PreToolUse|tmux hook" -S .`
   - result: pass
   - notes: confirmed current hook coverage, legacy test location, and remaining DOM-debug references
2. `sed -n '1,220p' /Users/skryl/.codex/skills/phased-prd-red-green/SKILL.md`
   - result: pass
   - notes: loaded the workflow and PRD rules before authoring this migration PRD
3. `npm run test:integration -- tests/integration/test-driver.test.ts`
   - result: pass
   - notes: typed-driver replacement coverage passed without using the debug DOM commands
4. `npm run test:integration -- tests/integration/tmux-hook.test.ts`
   - result: pass
   - notes: tmux-created teammate/window coverage passed through the managed runtime
5. `npm run test:integration -- tests/integration/claude-hooks.test.ts`
   - result: fail -> pass
   - notes: initial settings-driven hook launcher differed from the old direct exec path; direct exec for plain hook commands restored transcript coverage
6. `npm run test:unit && npm run test:integration && npm run check`
   - result: pass
   - notes: full JS/unit/integration/typecheck regression suite passed after deleting `test-e2e.ts`
