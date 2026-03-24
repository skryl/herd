## Title
Stale Agent Records Must Not Shadow Current Pane Tile Kind

## Status
Completed

## Date
2026-03-23

## Context
In the live Herd tab, `tile_list` and `network_list` were reporting pane `%2` as a dead `agent` tile even though the active projection showed `%2` as a `browser` tile. The root cause was stale dead agent records lingering on reused pane ids. Session/network tile discovery was treating any agent record on a pane as authoritative, which let dead agent records mask the current browser or shell tile kind.

## Goals
- Prevent dead stale agent records from overriding the current browser or shell tile kind for a pane.
- Preserve live agent tiles as agent/root-agent tiles.
- Preserve dead agent tiles as agent/root-agent tiles only when the current tmux pane/window still looks like an Agent or Root tile.
- Keep worker browser discovery and network permissions green.

## Non-goals
- Removing CLI `sudo`.
- Purging all historical dead agent records from the registry.
- Changing manual network graph semantics.

## Scope
- Rust agent-record preference helpers in app state
- Rust pane-kind classification shared by session/network discovery and UI-side network descriptors
- Focused unit coverage for stale dead-agent precedence
- Existing worker network/browser integration coverage

## Risks and mitigations
- Risk: hiding all dead agent records would erase legitimate inactive agent tiles that still exist on the canvas.
  - Mitigation: only fall back to dead-agent classification when the current pane/window title still matches `Agent` or `Root`.
- Risk: multiple agent records on the same pane could still select the wrong record.
  - Mitigation: prefer live agents first, then the most recently seen/registered dead record.

## Acceptance criteria
- A live agent record still classifies a pane as `agent` / `root_agent`.
- A dead stale agent record does not override a pane currently titled/windowed as `Browser`.
- `tile_list` / `network_list` can no longer misreport a browser pane as an agent solely because of stale dead agent state.
- Rust tests and focused worker network/browser integration tests pass.

## Phased Plan (Red/Green)

### Phase 0
Objective: Capture the stale-agent shadowing behavior in focused checks.

Red:
- Reproduce the live mismatch by inspecting the running tab and confirming `%2` is a browser in projection but an agent in `tile_list` / `network_list`.
- Add unit expectations for:
  - live agent wins over browser title
  - dead agent loses to browser title
  - dead agent still wins when the current pane/window still says `Agent`
- Expected failure signal:
  - stale dead agent records continue to classify browser panes as agent tiles

Green:
- Update agent lookup precedence and pane-kind classification to use current pane/window metadata before falling back to dead agent records.

Verification commands:
- `cargo test --manifest-path src-tauri/Cargo.toml`

Exit criteria:
- The new unit coverage passes and the stale browser-shadowing behavior is eliminated in code.

### Phase 1
Objective: Re-verify the worker-facing network/browser behavior.

Red:
- Rerun the focused worker integration coverage after the Rust change.
- Expected failure signal:
  - worker `network_list` or browser access regresses

Green:
- Keep the stale-agent fix minimal and ensure the worker network/browser paths stay green.

Verification commands:
- `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "enforces worker local-network permissions at the backend"`
- `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "drives browser tiles through browser_drive"`
- `git diff --check`

Exit criteria:
- Worker network/browser integration still passes and patch formatting is clean.

## Execution Checklist
- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log
1. `printf '{"command":"test_driver","request":{"type":"get_projection"}}\n' | socat - UNIX-CONNECT:/tmp/herd.sock | jq ...`
   - result: pass
   - notes: live projection showed `%2` as a browser tile in the active tab.
2. `printf '{"command":"tile_list","sender_agent_id":"root:$0","sender_pane_id":"%1"}\n' | socat - UNIX-CONNECT:/tmp/herd.sock | jq ...`
   - result: pass
   - notes: live tile discovery misreported `%2` as a dead agent tile.
3. `printf '{"command":"network_list","sender_agent_id":"7ba89364-22de-4036-9c16-f2ead36140bc","sender_pane_id":"%4"}\n' | socat - UNIX-CONNECT:/tmp/herd.sock | jq .`
   - result: pass
   - notes: live worker network discovery also misreported `%2` as `agent` with dead Agent 7 details.
4. `cargo test --manifest-path src-tauri/Cargo.toml`
   - result: pass
   - notes: full Rust suite passed after adding stale-agent precedence coverage and fixing pane-kind selection.
5. `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "enforces worker local-network permissions at the backend"`
   - result: pass
   - notes: worker network discovery/call permissions remained green after the stale-agent fix.
6. `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "drives browser tiles through browser_drive"`
   - result: pass
   - notes: browser-focused worker coverage stayed green after the stale-agent fix.
7. `git diff --check`
   - result: pass
   - notes: no whitespace or patch-format issues.
