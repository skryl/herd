# Shared-View Texas Hold'em Browser Extension

## Status
Completed

## Date
2026-03-25

## Context
The current browser poker game (`extensions/browser/draw-poker`) is a shared local-storage room that is practically operated as one browser view per player. The requested replacement behavior is a new game that uses a single shared browser tile as the public table, supports turn-taking across multiple agents, and exposes a browser-tile extension API so seat ownership and private card visibility are bound to the real caller tile identity rather than caller-supplied arguments.

Browser tiles already expose static `get`, `navigate`, `load`, and `drive` message APIs. They do not currently advertise or dispatch extension-specific actions when an extension page is loaded, and browser tile details do not currently describe the loaded extension API.

## Goals
- Add a new shared-view Texas Hold'em browser extension without modifying `draw-poker`.
- Expose loaded browser extension metadata and callable extension methods through browser tile `get` / `network_get` / `tile_get`.
- Bind seat ownership and private card access to the real sender tile id supplied by Herd.
- Support four fixed seats plus one non-playing commentator role.
- Cover the new behavior with logic, browser API, and scripted integration tests.

## Non-goals
- Reworking the existing room-based browser game runtime.
- Adding compatibility fallbacks for the old multi-view poker flow.
- Implementing no-limit betting, side pots, or all-in handling.

## Scope
- Rust browser tile metadata and message dispatch.
- Shared frontend/browser types for extension metadata.
- New `extensions/browser/texas-holdem/` page, logic, and styles.
- Browser/unit/integration test updates that exercise the new extension API and match flow.

## Risks And Mitigations
- Browser extension metadata discovery depends on page-side JS evaluation.
  - Mitigation: keep the page contract small (`window.HerdBrowserExtension.manifest` plus synchronous `call`) and treat missing/invalid manifests as “no extension loaded”.
- Sender-bound authorization could accidentally trust caller-provided args.
  - Mitigation: pass sender context from Rust and ignore any identity fields inside extension method args.
- Dynamic browser APIs could regress normal browser tiles.
  - Mitigation: preserve the existing static browser API for non-extension pages and add targeted regression coverage.

## Acceptance Criteria
- Loading `extensions/browser/texas-holdem/index.html` on a browser tile exposes extension metadata in browser tile details and adds `extension_call` to the browser tile API.
- Loading a normal page keeps the existing browser-only API with no extension metadata/actions.
- `claim_seat`, `register_commentator`, `act`, `reveal_private`, and `reveal_all` all use the real sender tile identity.
- A single browser tile can host a full four-seat shared-view Hold'em match driven by multiple agents plus one commentator.
- Private hole cards are not rendered in the public DOM during active play.

## Phase 0
### Objective
Add failing coverage for dynamic browser extension metadata and sender-bound extension dispatch.

### Red
- Add/adjust tests that expect:
  - non-extension browser pages to keep the existing API
  - loaded extension pages to expose extension metadata and `extension_call`
  - seat-bound/private-card authorization to reject forged access

### Expected Failure Signal
- Browser tiles never expose extension metadata or `extension_call`.
- Extension methods cannot be invoked through the tile API.
- Caller identity is not available to extension dispatch.

### Green
- Add browser extension metadata discovery, dynamic browser API augmentation, and sender-aware `extension_call` dispatch.

### Verification Commands
- `npm run test:integration -- tests/integration/worker-root-mcp.test.ts`

### Exit Criteria
- Browser tiles expose extension metadata/actions only when an extension page is loaded, and extension dispatch receives real sender context.

## Phase 1
### Objective
Implement the shared-view Texas Hold'em page and logic.

### Red
- Add failing logic/browser tests for deterministic hand setup, turn order, showdown evaluation, and authorization-sensitive card reveal behavior.

### Expected Failure Signal
- No Hold'em extension exists, or the game state/API does not satisfy the shared-view and reveal requirements.

### Green
- Implement the new extension page, shared public rendering, Hold'em engine, extension manifest, and extension methods.

### Verification Commands
- `npm run test:unit -- extensions/browser/texas-holdem/texas-holdem.test.ts`

### Exit Criteria
- The new extension page loads, renders a shared public table, and supports the planned API and game flow.

## Phase 2
### Objective
Prove the full single-browser multiplayer flow through scripted integration.

### Red
- Add a failing integration scenario with one browser tile, four worker agents, and one commentator.

### Expected Failure Signal
- The shared browser tile cannot coordinate seat claims, turns, or private reveal semantics across agents.

### Green
- Add/update scripted integration helpers and finish the full Hold'em match scenario against one shared browser tile.

### Verification Commands
- `npm run test:integration -- tests/integration/browser-games.test.ts`
- `npm run test:unit -- extensions/browser/**/*.test.ts`

### Exit Criteria
- The single-browser Hold'em scenario completes deterministically and adjacent browser game coverage remains green.

## Execution Checklist
- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Phase 2 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log
1. `sed -n '1,260p' /Users/skryl/.codex/skills/phased-prd-red-green/references/prd_red_green_template.md`
   - result: pass
   - notes: loaded the PRD template structure.
2. `rg --files`
   - result: pass
   - notes: identified existing browser games and the current poker implementation.
3. `rg -n "get_info|browser api|extension api|browser tile|tile info|extension_api|browserLoad|browser ready|commentator|card reveal|reveal" ../src ../src-tauri ../tests ../docs ../extensions -S`
   - result: pass
   - notes: confirmed browser tiles currently expose only the static browser API and no extension-specific dispatch path.
4. `npm run test:unit -- extensions/browser/texas-holdem/texas-holdem.test.ts`
   - result: pass
   - notes: verified deterministic setup, reveal authorization, fold-order turn selection, showdown ranking, split-pot odd chip, reset behavior, and button rotation across busted seats.
5. `npm run test:integration -- tests/integration/browser-games.test.ts -t "runs a shared-view texas holdem match through one browser tile and turn-taking extension calls"`
   - result: pass
   - notes: proved one shared browser tile can host the full multi-agent Hold'em flow across two hands without exposing private cards in the public DOM.
6. `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "exposes browser extension metadata and enforces sender-bound extension calls"`
   - result: pass
   - notes: verified dynamic browser extension metadata, `extension_call`, seat/commentator authorization, and sender-tile binding. One earlier run flaked during worker-tile attachment before this passing rerun.
7. `npm run test:integration -- tests/integration/test-driver.test.ts -t "shows browser Load submenu entries and suppresses browser webviews while the context menu is open"`
   - result: pass
   - notes: confirmed the browser context menu advertises the new `Texas Holdem` extension entry.
8. `npm run check`
   - result: pass
   - notes: `svelte-check` and TypeScript completed with 0 errors and 0 warnings.
9. `cargo test --manifest-path src-tauri/Cargo.toml`
   - result: pass
   - notes: Rust unit/doc tests stayed green after the browser metadata and dispatch changes.
