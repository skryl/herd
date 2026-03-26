## Title
Browser-Tile Multiplayer Game Pack With Live-Agent Play

## Status
Completed

## Date
2026-03-24

## Context
Herd can already create browser tiles, load local files into them, and drive them through Root `browser_drive` or worker-safe `network_call` browser `drive`. There are currently no browser extensions under `extensions/browser/`, and there is no end-to-end coverage for agents collaborating through browser tiles on a shared local game.

The requested scope is four simple multiplayer browser games that run inside browser tiles:
- a slow 2-player game: checkers
- a fast 2-player game: pong
- a slow 4-player game: five-card draw poker
- a fast 4-player game: snake arena

The games must be browser-only, not backed by a new local server. They also need deterministic tests and one live Herd integration test per game where Root coordinates a team of agents that play through the existing MCP/socket surface.

## Goals
- Add four browser games under `extensions/browser/`.
- Keep multiplayer browser-only through shared browser profile primitives.
- Expose a stable in-page automation surface so tests and agents can inspect and drive the games.
- Make the fast games playable through pure live agent control by designing around tool latency instead of adding autopilot behavior.
- Add deterministic browser-level tests and live Herd integration tests.

## Non-goals
- Adding a new backend game server or new Herd socket/MCP commands.
- Supporting host migration if the authoritative browser tile closes.
- Building human-arcade-speed twitch games that require per-frame reflexes.
- Shipping production-grade gambling logic, persistence, or security hardening beyond local deterministic play.

## Scope
- New browser game assets under `extensions/browser/`
- A shared browser-only room/snapshot pattern for local multiplayer
- Browser-level automated tests for each game
- One live agent integration test per game
- PRD/status tracking for phased red/green delivery

## Risks and mitigations
- Risk: browser tiles in separate windows drift or desync.
  - Mitigation: one host tile owns canonical state; peers send actions and receive full snapshots on every accepted update.
- Risk: fast games are too quick for agent/MCP latency.
  - Mitigation: use sticky live inputs and slow deterministic tick loops instead of autopilot or queued policies.
- Risk: live agent integration is flaky.
  - Mitigation: use deterministic seeds, short role prompts, scripted objectives, and assert final browser state rather than free-form agent prose.
- Risk: game rules sprawl.
  - Mitigation: keep rules intentionally compact and explicit in each game implementation.

## Acceptance criteria
- `extensions/browser/` contains four runnable game directories: `checkers`, `pong`, `draw-poker`, and `snake-arena`.
- Each game can be loaded in a browser tile through `browser_load`.
- Each game exposes `window.__HERD_GAME__` with room lifecycle, action, snapshot, and test reset helpers.
- Multiplayer sync works across multiple default-profile browser tiles without a backend server.
- Checkers, draw poker, pong, and snake arena each have deterministic browser tests covering core gameplay and room sync.
- There is one live Herd integration test per game using Root plus one worker agent per player.
- Fast games are controlled by explicit agent-issued live inputs only; no hidden autopilot loop is introduced.

## Phased Plan (Red/Green)

### Phase 0
Objective: Establish the browser-only room contract and test harness.

Red:
- Add failing browser tests for:
  - room creation and join across multiple pages
  - host-authoritative snapshot propagation
  - persisted room reload through `localStorage`
  - abandoned-room behavior after host teardown
- Expected failure signal:
  - no game runtime exists
  - browser pages and shared snapshot API are missing

Green:
- Add a shared browser runtime module for room identity, deterministic seeds, BroadcastChannel messaging, storage snapshots, and `window.__HERD_GAME__` bootstrapping.
- Add a small reusable Playwright helper layer for local file pages and multi-page assertions.

Verification commands:
- `npx vitest run extensions/browser/**/*.test.ts`

Exit criteria:
- Browser pages can host a deterministic shared room and expose a common automation surface.

### Phase 1
Objective: Implement the slow-turn games first.

Red:
- Add failing tests for:
  - checkers legal move flow, forced capture, multi-jump, kinging, and win detection
  - draw poker deal, betting order, draw replacement, showdown ranking, and multi-player room sync
- Expected failure signal:
  - legal action reducers and snapshot shapes do not exist

Green:
- Implement `checkers` and `draw-poker` using the shared room runtime.
- Add stable DOM controls for joining, starting, and making legal moves/actions.

Verification commands:
- `npx vitest run extensions/browser/checkers/*.test.ts extensions/browser/draw-poker/*.test.ts`

Exit criteria:
- Both slow games are deterministic, playable in separate browser tiles, and green at the browser-test layer.

### Phase 2
Objective: Implement the latency-aware fast games.

Red:
- Add failing tests for:
  - pong score flow, serve/reset, and live sticky paddle input
  - snake arena direction latching, no-reverse enforcement, food growth, collision outcomes, and timeout winner resolution
- Expected failure signal:
  - no tick-loop host runtime exists for the fast games
  - live input semantics are not modeled

Green:
- Implement `pong` as a slow deterministic discrete-step 2-player paddle game with latched `up` / `down` / `stop` control.
- Implement `snake-arena` as a deterministic 4-player grid game with persistent heading until changed.
- Keep both games purely live-controlled: every input change must still be explicitly issued by the player agent.

Verification commands:
- `npx vitest run extensions/browser/pong/*.test.ts extensions/browser/snake-arena/*.test.ts`

Exit criteria:
- Both fast games are playable through live browser actions despite agent/tool latency.

### Phase 3
Objective: Prove end-to-end Herd collaboration through live agents.

Red:
- Add failing integration tests for each game that:
  - create an isolated tab
  - spawn the required browser tiles and worker agents
  - have Root wire the local networks and load the game
  - message the players with deterministic roles and instructions
  - assert the final browser state from the real runtime
- Expected failure signal:
  - no game pages exist
  - agents cannot complete the setup or match flow

Green:
- Implement four live integration tests:
  - two-player checkers
  - two-player pong
  - four-player draw poker
  - four-player snake arena
- Keep worker play on `network_list` / `network_get` / `network_call` only.

Verification commands:
- `npm run test:integration -- tests/integration/browser-games.test.ts`
- targeted `-t` runs for each game while iterating

Exit criteria:
- Every game has a passing live-agent scenario with final state asserted from browser tiles.

## Execution Checklist
- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Phase 2 complete
- [x] Phase 3 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log
1. `sed -n '1,260p' src-tauri/src/browser.rs`
   - result: pass
   - notes: confirmed local file loading and `browser_drive` support for `click`, `type`, `dom_query`, and `eval`.
2. `sed -n '1,320p' tests/integration/client.ts`
   - result: pass
   - notes: confirmed the integration socket client already exposes `browser_load`, `browserDrive`, `networkCall`, and tile/network helpers.
3. `sed -n '1,260p' tests/integration/runtime.ts`
   - result: pass
   - notes: confirmed the live runtime boot path for Tauri integration tests.
4. `sed -n '1360,1525p' tests/integration/worker-root-mcp.test.ts`
   - result: pass
   - notes: confirmed local browser fixtures and browser-tile automation work in the current test harness.
5. `npx vitest run extensions/browser/checkers/checkers.test.ts`
   - result: fail -> pass
   - notes: first red signal exposed that `file://` browser pages cannot boot ES module scripts in Chromium; green fix converted the browser extensions to classic-script globals and the room-sync test passed.
6. `npx vitest run extensions/browser/**/*.test.ts`
   - result: pass
   - notes: all four browser games and their room-sync/rules tests are green.
7. `npm run check`
   - result: pass
   - notes: repo typecheck and Svelte checks stay green after adding the browser game pack.
8. `npx tsc --noEmit --target ES2023 --lib ES2023 --module ESNext --moduleResolution bundler --allowImportingTsExtensions --verbatimModuleSyntax --strict --skipLibCheck --types node,vitest/globals tests/integration/*.ts tests/browser-game-helpers.ts`
   - result: pass
   - notes: the browser helper and new live-agent integration tests typecheck cleanly.
9. `npm run test:integration -- tests/integration/browser-games.test.ts -t "coordinates a scripted checkers opening through worker agents"`
   - result: fail -> pass
   - notes: initial red exposed two issues: worker prompts were over-exploring instead of obeying exact Root dispatches, and the live integration harness needed more deterministic stepwise orchestration. After updating worker Herd guidance and moving the live tests to Root-coordinated one-shot browser actions, the targeted checkers scenario passed.
10. `git diff --check`
   - result: pass
   - notes: no whitespace or patch-format issues remain.
11. `npx vitest run extensions/browser/checkers/checkers.test.ts`
   - result: pass
   - notes: added a background-host regression to catch false abandoned-room detection while the host browser tile stays alive in a background tab.
12. `npx vitest run extensions/browser/draw-poker/draw-poker.test.ts`
   - result: pass
   - notes: added a fold-turn regression after fixing draw-poker turn advancement when the acting seat folds out of the hand.
13. `npm run test:integration -- tests/integration/browser-games.test.ts -t "plays a deterministic pong match through worker agents"`
   - result: pass
   - notes: Root now seeds the browser pages for pong, while workers still drive the live paddle intents.
14. `npm run test:integration -- tests/integration/browser-games.test.ts -t "runs a scripted four-player draw poker hand through worker agents"`
   - result: pass
   - notes: fixed the turn-order bug in draw poker and kept the betting actions on the worker agents.
15. `cargo test --manifest-path src-tauri/Cargo.toml role_specific_herd_skills`
   - result: pass
   - notes: prompt/skill-file assertions remain green after updating the worker guidance for explicit Root dispatches.
16. `npm run test:integration -- tests/integration/browser-games.test.ts`
   - result: pass
   - notes: the full live-agent browser-games suite is now green with fresh runtimes per test and browser storage reset on page load.
