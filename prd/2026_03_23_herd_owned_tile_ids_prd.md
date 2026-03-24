## Title
Herd-Owned Stable Tile IDs Must Replace Tmux Pane IDs

## Status
In Progress

## Date
2026-03-23

## Context
Herd currently treats tmux pane IDs as tile IDs for shell, browser, and agent tiles. The backend emits `tile_id = pane_id` in session/network payloads, the agent registry stores `tile_id` as the pane ID, and several UI paths assume `terminal.id === pane.id`. This makes tile identity volatile, leaks tmux internals through the public API, and creates stale-record bugs when panes are reused.

Relevant current-state examples:
- `SessionTileInfo.tile_id` is emitted as the pane ID for tmux-backed tiles in [src-tauri/src/socket/server.rs](/Users/skryl/Dev/herd/src-tauri/src/socket/server.rs#L1436).
- UI tile identity currently uses `id: pane.id` and `paneId: pane.id` in [src/lib/stores/appState.ts](/Users/skryl/Dev/herd/src/lib/stores/appState.ts#L2140).
- Non-work network descriptors resolve `tile_id` by looking up tmux panes directly in [src-tauri/src/commands.rs](/Users/skryl/Dev/herd/src-tauri/src/commands.rs#L86).
- Persisted layout state is still documented and stored as tmux-keyed state in [src-tauri/src/persist.rs](/Users/skryl/Dev/herd/src-tauri/src/persist.rs#L20).

The desired model is:
- every tile gets a Herd-owned stable ID at creation time
- tmux pane/window IDs are only backing references
- the public API, network graph, logs, and agent records use Herd tile IDs
- tmux-to-Herd mapping is used during startup reconciliation when Herd reconnects to an existing tmux session

## Goals
- Make `tile_id` a Herd-generated stable identifier for every tile kind.
- Keep `pane_id` and `window_id` as backing metadata, not identity.
- Route socket, MCP, network graph, logs, and agent state by Herd tile ID.
- Use a bootstrap reconciliation step to reattach persisted Herd tile records to live tmux panes/windows when Herd starts.
- Remove pane-ID-as-tile-ID assumptions instead of adding compatibility aliases.

## Non-goals
- Preserving the current behavior where any newly discovered tmux pane automatically becomes a first-class Herd tile after bootstrap.
- Supporting both stable Herd tile IDs and pane-ID tile IDs long-term.
- Changing work tile ownership semantics beyond bringing them under the same tile registry shape.
- Reworking tmux window/pane management beyond what is necessary for stable tile identity.

## Scope
- Backend tile registry and ID generation
- Agent registry updates to track both Herd tile ID and backing pane/window IDs
- Session/network/socket/MCP payload updates to use Herd tile IDs
- Frontend tile identity updates so tile interactions key off Herd tile IDs
- Startup reconciliation from persisted Herd tiles to live tmux panes/windows
- Regression and migration coverage

## Proposed Model
- Introduce a persisted `tile` registry table owned by Herd.
- Each tmux-backed tile record stores:
  - `tile_id`
  - `session_id`
  - `kind`
  - `backing_window_id`
  - `backing_pane_id`
  - optional title / creation metadata
  - live status as needed for reconciliation
- Each work tile record continues to use a Herd-owned ID and should also be represented through the same tile-registry abstraction, even if backed by work-specific tables.
- All public tile payloads return:
  - `tile_id` as the Herd-owned stable ID
  - `pane_id` and `window_id` as backing references when present
- Agent registration must carry both:
  - `tile_id` as the Herd tile ID
  - `pane_id` as the current tmux backing pane
- New tmux-backed tiles are created in this order:
  1. generate/persist Herd tile record
  2. create tmux window/pane
  3. bind the new backing pane/window IDs into that tile record
  4. continue routing by Herd tile ID only
- Startup reconciliation must:
  1. load persisted Herd tile records
  2. scan the tmux snapshot
  3. reattach known Herd tiles to their live pane/window backings
  4. mark tiles detached/dead when they cannot be matched
- Post-bootstrap, runtime code should resolve by Herd tile ID first. Direct tmux IDs are backing metadata, not public identity.

## ID Format Recommendation
- Do not use 5 mixed-case letters as the only collision strategy.
- `52^5 = 380,204,032` possibilities, which gives about:
  - `0.13%` collision probability by `1,000` lifetime IDs
  - `12.3%` collision probability by `10,000` lifetime IDs
- `6` mixed-case letters is materially safer:
  - `52^6 = 19,770,609,664`
  - about `0.25%` collision probability by `10,000` lifetime IDs before retry
- Recommendation:
  - use `6` random mixed-case letters minimum
  - enforce DB uniqueness and retry on collision

## Architectural Decisions
- `tile_id` is the only identity used for:
  - network connections
  - tile logs and activity
  - agent ownership and sender/receiver routing
  - UI selection and canvas/network operations
- `pane_id` remains necessary for:
  - terminal IO
  - browser webview lookup
  - tmux respawn/rename/kill operations
  - initial bootstrap reconciliation
- `window_id` remains necessary for:
  - tmux lineage and restore hints
  - layout attachment for tmux-backed tiles
- Ongoing implicit tmux discovery after bootstrap should be removed or converted into an explicit adoption flow. Otherwise tmux remains a shadow source of truth.

## Risks and mitigations
- Risk: the refactor is cross-cutting and easy to break in routing, layout, or UI selection.
  - Mitigation: land it in phases with failing tests first for backend identity, reconnect, and UI/store assumptions.
- Risk: existing persisted DB state uses pane IDs in `tile_state`, `agent.tile_id`, and `network_connection`.
  - Mitigation: add an explicit one-time migration to a new tile registry rather than dual-reading forever.
- Risk: browser tiles and shell tiles need pane IDs for runtime operations.
  - Mitigation: keep `pane_id` in public payloads as backing metadata and resolve operation targets through tile registry lookup.
- Risk: agent startup currently passes `HERD_PANE_ID` and `TMUX_PANE` but not a Herd tile ID.
  - Mitigation: add `HERD_TILE_ID` and require agent registration to bind the stable tile ID to the runtime pane.
- Risk: implicit tmux-created teammate panes currently appear as tiles without an explicit Herd create path.
  - Mitigation: decide explicitly whether bootstrap-only adoption is the intended product rule. If yes, remove ongoing automatic discovery in the same change.

## Acceptance criteria
- Every shell, browser, agent, and work tile has a stable Herd `tile_id` that is distinct from tmux pane identity.
- `tile_list`, `tile_get`, `network_list`, `network_get`, `network_call`, `tile_call`, `network_connect`, and `network_disconnect` all use Herd tile IDs only.
- `pane_id` and `window_id` remain available as backing metadata where relevant.
- Agent state stores both Herd tile identity and tmux backing identity, and sender resolution no longer depends on pane ID equality with tile ID.
- Layout persistence is keyed by Herd tile identity for all tile kinds.
- Startup reconciliation can reattach persisted Herd tile records to an existing tmux session without exposing tmux IDs as tile IDs.
- The old pane-ID-as-tile-ID path is removed rather than preserved as a fallback.

## Phased Plan (Red/Green)

### Phase 0
Objective: Lock down the desired identity contract before implementation.

Red:
- Add failing backend tests asserting that tmux-backed tiles expose `tile_id != pane_id`.
- Add failing UI/store tests asserting that `TerminalInfo.id` is the Herd tile ID while `paneId` stays the tmux pane ID.
- Add failing agent registration tests asserting that `tile_id` and `pane_id` are both required and distinct.
- Expected failure signal:
  - current code still emits pane IDs as `tile_id`

Green:
- Introduce tile registry types and a stable ID generator.
- Thread stable tile IDs through core DTOs without yet cutting over every caller.

Verification commands:
- `cargo test --manifest-path src-tauri/Cargo.toml`
- `npm run test -- src/lib/stores/appState.test.ts`

Exit criteria:
- The contract tests exist and prove the current pane-ID coupling.

### Phase 1
Objective: Make the backend route by Herd tile IDs instead of tmux IDs.

Red:
- Add failing coverage around:
  - `tile_list` / `tile_get`
  - `network_list` / `network_get`
  - `network_call` / `tile_call`
  - `network_connect` / `network_disconnect`
- Expected failure signal:
  - routes still require or emit tmux pane IDs as tile IDs

Green:
- Add a persisted tile registry and tile lookup helpers:
  - `tile_id -> backing pane/window`
  - `pane/window -> tile_id` for bootstrap and sender resolution
- Move `agent.tile_id`, `network_connection.*_tile_id`, and tile-message logging to stable Herd tile IDs.
- Keep browser/shell execution helpers resolving through backing pane ID.

Verification commands:
- `cargo test --manifest-path src-tauri/Cargo.toml`
- `npm run test:integration -- tests/integration/worker-root-mcp.test.ts`

Exit criteria:
- Backend routes and network graph are stable-ID-based end to end.

### Phase 2
Objective: Rework create/destroy/reconnect around Herd-owned identity.

Red:
- Add failing tests covering:
  - tile creation returns a Herd tile ID immediately
  - agent spawn/registration binds stable tile ID to runtime pane
  - startup reconciliation reattaches persisted tiles to an existing tmux snapshot
  - stale pane IDs do not create identity drift
- Expected failure signal:
  - startup/reconnect depends on pane IDs remaining identical

Green:
- Create tmux-backed tiles through the registry-first flow.
- Pass `HERD_TILE_ID` alongside `HERD_PANE_ID` / `HERD_SESSION_ID`.
- Implement bootstrap reconciliation and remove tmux-first identity assumptions.

Verification commands:
- `cargo test --manifest-path src-tauri/Cargo.toml`
- focused integration/startup restore tests

Exit criteria:
- Herd owns tile identity before tmux comes online, and restart/reconnect works.

### Phase 3
Objective: Cut the frontend and docs over to stable tile IDs.

Red:
- Add failing store/component tests around:
  - tile selection
  - network drag/connect
  - tile activity aggregation
  - browser/shell tile rendering with `tile_id != pane_id`
- Expected failure signal:
  - UI still assumes `tile.id === paneId`

Green:
- Use Herd tile IDs for tile selection, network edges, activity, and canvas interactions.
- Keep pane IDs only where terminal/browser runtime calls need them.
- Update MCP/socket/docs to describe `tile_id` as Herd-owned and `pane_id` as backing metadata.

Verification commands:
- `npm run test`
- `npm run check`
- targeted integration coverage

Exit criteria:
- UI behavior is stable with distinct Herd tile IDs and tmux pane IDs.

## Execution Checklist
- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Phase 2 complete
- [x] Phase 3 complete
- [ ] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log
1. `rg -n "tile_id|pane_id|window_id|tile_create|network_list|tile_list" src-tauri src tests mcp-server README.md docs`
   - result: pass
   - notes: confirmed tmux pane/window identifiers are still used as primary tile identity across backend and frontend.
2. `sed -n '1,260p' src-tauri/src/persist.rs`
   - result: pass
   - notes: confirmed persisted tile state is still tmux-keyed.
3. `sed -n '1076,1495p' src-tauri/src/socket/server.rs`
   - result: pass
   - notes: confirmed session tiles for tmux-backed tiles still emit `tile_id = pane_id`.
4. `sed -n '1,240p' src/lib/types.ts`
   - result: pass
   - notes: confirmed public DTOs already separate `tile_id` from `pane_id` structurally, but the implementation does not.
5. `node -e 'const N5=52**5,N6=52**6; ...'`
   - result: pass
   - notes: calculated collision risk for 5-char vs 6-char mixed-case IDs.
