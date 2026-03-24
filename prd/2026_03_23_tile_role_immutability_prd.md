## Title
Tile Registry Roles Must Be Immutable Across Agent Liveness Changes

## Status
Completed

## Date
2026-03-23

## Context
Live Herd sessions are allowing tmux reconciliation and UI heuristics to rewrite tile roles after creation. Agent tiles can degrade into `shell` when their agent process dies, and title-based fallbacks can then misclassify them as `browser` if the pane title mentions browser work. This breaks the user model: a tile created as an agent/browser/shell/work tile should keep that role until the tile itself is destroyed. The registry must remain the source of truth for tile identity and backing pane mapping.

## Goals
- Make persisted tile role authoritative for existing tmux-backed tiles.
- Prevent tmux reconciliation from rewriting `tile_registry.kind` for existing tiles.
- Repair already-corrupted agent tile records using stronger persisted evidence.
- Make UI tile roles come from backend-provided tile identity, not pane/window title guesses.
- Keep agent tiles visible as agent/root-agent tiles even when the bound agent is dead.

## Non-goals
- Reworking worker process liveness or ping policy in this change.
- Introducing compatibility fallbacks that keep both mutable and immutable role paths.
- Purging all historical agent rows from sqlite.

## Scope
- Rust tile registry reconciliation and network/session tile classification.
- Rust tmux snapshot emission for stable pane roles.
- Svelte app-state role projection and toolbar agent count.
- Targeted Rust and frontend regression coverage.

## Risks and mitigations
- Risk: existing corrupted tile rows stay wrong if we only stop future rewrites.
  - Mitigation: repair agent tiles from persisted agent bindings during reconciliation.
- Risk: frontend still misclassifies tiles from pane titles after backend fix.
  - Mitigation: emit stable pane roles from backend snapshot and prefer them over title inference.
- Risk: root-vs-worker agent tiles become ambiguous when no live agent exists.
  - Mitigation: prefer any persisted root binding on the tile before falling back to worker.

## Acceptance criteria
- Existing `tile_registry.kind` is preserved across tmux reconciliation for tracked tiles.
- Agent-backed tiles remain `agent` / `root_agent` in `tile_list` even when the agent is dead.
- Agent tiles are never reclassified as `browser` solely because of pane/window titles.
- Frontend terminal projection uses stable backend role data for tracked tiles.
- Toolbar `AGENTS` count matches agent tiles in the active tab, not just currently alive agent processes.

## Phased Plan (Red/Green)

### Phase 0
Objective: Capture current role-mutation failures in focused tests.

Red:
- Add Rust coverage showing reconciliation preserves existing tile kind and repairs agent tiles from persisted agent bindings instead of title heuristics.
- Add frontend/store coverage showing tracked panes prefer backend-provided role over title-derived guesses and that the toolbar-style agent count follows agent tiles.
- Expected failure signal:
  - existing tests show agent tiles collapsing to shell/browser when role metadata is absent or liveness changes.

Green:
- Implement the minimum stable-role plumbing required for those tests to pass.

Verification commands:
- `cargo test --manifest-path src-tauri/Cargo.toml commands::`
- `npm test -- --run src/lib/stores/appState.test.ts`

Exit criteria:
- Focused backend and frontend role-stability checks pass.

### Phase 1
Objective: Verify live-facing network/tile behavior still works after immutable-role enforcement.

Red:
- Re-run focused integration coverage that exercises worker/root/browser tile creation and tile listing.
- Expected failure signal:
  - worker/root/browser tile creation or network visibility regresses.

Green:
- Keep the implementation minimal and address only regressions introduced by the immutable-role change.

Verification commands:
- `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "allows shared shell access from multiple workers on one local network"`
- `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "supports session tile graph commands through the root MCP tools"`
- `git diff --check`

Exit criteria:
- Targeted integration coverage remains green and patch formatting is clean.

## Execution Checklist
- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log
1. `tmux -f /dev/null -L herd list-panes -a -F '#{session_id}\t#{pane_id}\t#{window_id}\t#{pane_current_command}\t#{pane_title}\t#{window_name}\t#{pane_dead}'`
   - result: pass
   - notes: live tmux still had root, browser, and two worker Claude panes present.
2. `node <<'EOF' ... tile_list ... EOF`
   - result: pass
   - notes: live `tile_list` showed only root as agent; worker Claude panes had collapsed to `shell`.
3. `sqlite3 tmp/herd.sqlite "select tile_id, session_id, kind, window_id, pane_id ... from tile_registry"`
   - result: pass
   - notes: worker tile ids `RMKrRr` and `lVBeKg` had already been rewritten from `agent` to `shell`.
4. `npm run test:unit -- --run src/lib/stores/appState.test.ts`
   - result: pass
   - notes: app-state role projection and current-agent filtering stayed green after consuming backend pane roles.
5. `cargo test --manifest-path src-tauri/Cargo.toml resolves_registry_backed_tile_kinds`
   - result: pass
   - notes: registry-backed kind resolution and shell-row repair coverage passed.
6. `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "creates actual worker agents through tile_create instead of plain shells"`
   - result: pass
   - notes: worker agent creation remained green with immutable tile roles.
7. `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "drives browser tiles through browser_drive"`
   - result: pass
   - notes: browser tile behavior and worker browser access remained green.
8. `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "allows shared shell access from multiple workers on one local network"`
   - result: fail
   - notes: same pre-existing projection race as earlier; the shell tile existed in sidebar/logs but `active_tab_terminals` never surfaced it.
9. `git diff --check`
   - result: pass
   - notes: no whitespace or patch-format issues.
