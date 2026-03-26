# Remove Browser Test APIs And Drive Games Through Visible UI Only

## Status
In Progress

## Date
2026-03-24

## Context
The browser games currently expose `window.__HERD_GAME__` and runtime helpers such as `snapshot`, `loadSnapshotForTest`, and `resetForTest`. Both the browser-level game tests and the Herd integration tests depend on those hooks instead of interacting with the visible page controls.

That violates the intended model for these pages. The games should be treated like third-party browser content: no special test API, no hidden state injection, and no direct page-method driving. Tests must use the same visible UI surfaces that a user or browser-driving agent would use.

## Goals
- Remove the public `window.__HERD_GAME__` test API from all four games.
- Remove dead runtime support that exists only for those test APIs.
- Rewrite the browser-level game tests to use visible UI controls and visible DOM state only.
- Rewrite the scripted Herd integration tests so fixture Root/workers use browser controls, not hidden page methods.
- Keep the “game reaches terminal completion” requirement for all four integration tests.

## Non-goals
- Keeping compatibility fallbacks for the removed test APIs.
- Adding replacement hidden endpoints or alternate test-only DOM controls.
- Converting the games away from browser tiles or away from the fixture-agent harness.

## Scope
- `extensions/browser/game-runtime.js`
- all four game `app.js` files
- browser-level game tests under `extensions/browser/*/*.test.ts`
- browser test helpers in `tests/browser-game-helpers.ts`
- fixture-agent helpers in `tests/integration/fixture-agents.ts`
- browser-game integration suite in `tests/integration/browser-games.test.ts`

## Risks And Mitigations
- Checkers currently relies on seeded endgame state for a short completion path.
  - Mitigation: derive and script a deterministic full-game move sequence from the standard opening position, then drive it through board clicks.
- Integration tests may still drift into hidden DOM/script usage.
  - Mitigation: move common fixture helpers to click/type/dom-query primitives and remove browser snapshot helpers that depend on page APIs.
- Browser tests may become slower after moving to real UI actions.
  - Mitigation: keep selectors stable, reuse deterministic seeds, and script minimal winning lines.

## Acceptance Criteria
- No game page exposes `window.__HERD_GAME__`.
- No browser tests call hidden page APIs or inject game state with eval.
- No Herd integration test uses hidden page APIs for game setup, play, or assertions.
- All browser-game tests use visible controls and visible DOM state.
- All four Herd browser-game integration tests still end with an actual winner.

## Phase 0
### Objective
Create red coverage that proves the public test API is gone and tests can no longer rely on it.

### Red
- Add/modify browser-level tests so they fail while still trying to use the old API.
- Add targeted integration assertions/helpers that fail if `window.__HERD_GAME__` is present or required.

### Expected Failure Signal
- Browser tests fail because no API is available.
- Integration helpers fail because readiness/snapshot code still expects `window.__HERD_GAME__`.

### Green
- Remove `window.__HERD_GAME__` from all game pages.
- Remove runtime methods used only by those hooks.

### Verification Commands
- `npx vitest run extensions/browser/**/*.test.ts`
- targeted TypeScript checks for integration helpers

### Exit Criteria
- No page exposes the hidden test API and the codebase no longer references it on the game path.

## Phase 1
### Objective
Rewrite browser-level tests to use only visible page controls and DOM state.

### Red
- Replace helper usage in browser tests with UI-driving steps and visible-state assertions; expect failures until helpers and scripts are updated.

### Expected Failure Signal
- Tests fail because current helpers and assertions still depend on hidden page methods or internal snapshot objects.

### Green
- Add browser test helpers for typing, clicking, waiting on text, and reading visible board/arena/player state from the DOM.
- Rewrite each game’s browser tests to use UI actions only.

### Verification Commands
- `npx vitest run extensions/browser/**/*.test.ts`

### Exit Criteria
- All browser-level game tests are green with no hidden page API usage.

## Phase 2
### Objective
Rewrite Herd fixture-agent integration tests to use browser controls only and still reach terminal game completion.

### Red
- Replace fixture helper usage and browser-game integration steps with control-surface-only interactions; expect failures until the harness and scenarios are updated.

### Expected Failure Signal
- Fixture helpers still need hidden snapshot/readiness functions.
- Game-completion scenarios fail because the tests still depend on state injection or internal page methods.

### Green
- Refactor fixture-agent helpers around browser `click`, `type`, and DOM-query primitives.
- Update Root/worker scripts to:
  - type room/name/seed values
  - click Join and Start
  - click visible game controls for all moves/actions
  - assert winners/status from visible DOM
- Replace the seeded checkers shortcut with a deterministic full-game click sequence from the standard opening.

### Verification Commands
- `npm run test:integration -- tests/integration/fixture-agents.test.ts`
- `npm run test:integration -- tests/integration/browser-games.test.ts`

### Exit Criteria
- All four integration tests are green and every interaction occurs through visible browser controls only.

## Execution Checklist
- [ ] Phase 0 complete
- [ ] Phase 1 complete
- [ ] Phase 2 complete
- [ ] Integration/regression checks complete
- [ ] Documentation/status updated

## Command Log
1. `rg -n "__HERD_GAME__|resetForTest|loadSnapshotForTest|createRoom\\(|joinRoom\\(|startGame\\(|perform\\(|snapshot\\(" extensions/browser tests -S`
   - result: pass
   - notes: confirmed the hidden test API is wired through all games and both browser/integration test layers.
2. `sed -n '1,220p' /Users/skryl/.codex/skills/phased-prd-red-green/SKILL.md`
   - result: pass
   - notes: confirmed phased red/green workflow for the refactor.
