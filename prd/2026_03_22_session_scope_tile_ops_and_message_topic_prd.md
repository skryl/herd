# Session-Scope Tile Ops And Message Topic API

## Status
Completed

## Date
2026-03-22

## Context
The socket API still exposes a mix of tile-instance and session-level operations through inconsistent prefixes and receiver scopes. Some commands are shell-specific even though the behavior is generic, some topic operations live outside the message namespace, and `agent_log_append` exposes internal logging as public API.

## Goals
- Move `network_get`, `tile_move`, and `tile_resize` to the session receiver.
- Replace `shell_title_set` with `tile_rename` and make it work for any tile.
- Remove `shell_read_only_set` from the public API and tile capability surface.
- Remove `agent_log_append` from the public API.
- Rename topic commands to `message_topic_list`, `message_topic_subscribe`, and `message_topic_unsubscribe`.
- Update CLI, MCP, docs, and tests to the new API without leaving compatibility paths behind.

## Non-goals
- Reworking typed test-driver commands.
- Replacing agent log storage or debug-state internals.
- Changing existing message delivery semantics beyond the requested command renames and scope moves.

## Scope
- Socket protocol definitions and handler routing.
- Session/tile message receiver capability tables.
- CLI command parsing and tests.
- MCP tool registration and tests.
- Integration tests and docs that reference the renamed or removed commands.

## Risks And Mitigations
- Risk: tests still expect removed commands.
  - Mitigation: update all client helpers, MCP tool names, and targeted integration assertions in the same change.
- Risk: `tile_rename` semantics diverge across tile kinds.
  - Mitigation: implement one rename path based on resolved tile kind and reuse existing title update logic where possible.
- Risk: removing `agent_log_append` breaks MCP-side logging assumptions.
  - Mitigation: remove the MCP dependency on that API and keep socket message logs as the supported structured trace.

## Acceptance Criteria
- `network_get`, `tile_move`, and `tile_resize` dispatch through `SessionMessageReceiver`.
- `tile_rename` exists, works for shell/browser/agent/work tiles, and `shell_title_set` no longer exists.
- `shell_read_only_set` and `agent_log_append` are gone from socket/CLI/MCP/docs/tests.
- Topic operations use only the `message_topic_*` command names.
- Tile `responds_to` no longer advertises session-scoped operations removed from the tile bus.
- Targeted Rust, MCP, and integration checks pass.

## Phased Plan

### Phase 0
Objective
- Capture the current failing references and define the replacement surface.

Red
- Search for all usages of `shell_title_set`, `shell_read_only_set`, `agent_log_append`, `topics_list`, `topic_subscribe`, `topic_unsubscribe`, `network_get`, `tile_move`, and `tile_resize`.
- Expected failure signal: stale references remain after the API cut unless updated.

Green
- Create this PRD and map the affected files before editing.
- Verification commands:
  - `rg -n "shell_title_set|shell_read_only_set|agent_log_append|topics_list|topic_subscribe|topic_unsubscribe|network_get|tile_move|tile_resize" src-tauri/src mcp-server src tests README.md docs`

Exit Criteria
- All affected protocol, receiver, CLI, MCP, doc, and test touchpoints are identified.

### Phase 1
Objective
- Refactor the socket protocol and receiver routing to the new command surface.

Red
- Run focused Rust tests after protocol edits to expose broken routing or serialization.
- Expected failure signal: compile errors or command mismatches in CLI/server tests.

Green
- Add `tile_rename` and `message_topic_*`.
- Remove `shell_title_set`, `shell_read_only_set`, and `agent_log_append`.
- Move `network_get`, `tile_move`, and `tile_resize` onto the session receiver and out of tile `responds_to`.
- Verification commands:
  - `cargo test --manifest-path src-tauri/Cargo.toml cli::tests`
  - `cargo test --manifest-path src-tauri/Cargo.toml network::tests`
  - `cargo check --manifest-path src-tauri/Cargo.toml`

Exit Criteria
- Rust builds with the new protocol and receiver split.

### Phase 2
Objective
- Update CLI, MCP, docs, and integration tests to the new API names.

Red
- Run focused MCP and integration tests after the API cut.
- Expected failure signal: removed command names still referenced by tests or tool registration.

Green
- Update CLI help/payload tests, MCP tools/tests, integration clients/tests, and docs.
- Verification commands:
  - `npx vitest run --root mcp-server src/index.test.ts`
  - `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "routes session-scoped socket commands through the session receiver"`
  - `npm run check`

Exit Criteria
- No stale references remain in shipped entrypoints or targeted tests/docs.

## Implementation Checklist
- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Phase 2 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log
1. `rg -n "shell_title_set|shell_read_only_set|agent_log_append|topics_list|topic_subscribe|topic_unsubscribe|network_get|tile_move|tile_resize" src-tauri/src mcp-server src tests README.md docs`
   - result: pass
   - notes: captured all current touchpoints before refactor.
2. `cargo test --manifest-path src-tauri/Cargo.toml cli::tests`
   - result: pass
   - notes: CLI payload and command-surface tests passed after the rename/removal cut.
3. `cargo test --manifest-path src-tauri/Cargo.toml network::tests`
   - result: pass
   - notes: `responds_to` expectations were updated to the reduced tile-instance surface.
4. `cargo check --manifest-path src-tauri/Cargo.toml`
   - result: pass
   - notes: builds with pre-existing dead-code warnings only.
5. `npx vitest run --root mcp-server src/index.test.ts`
   - result: pass
   - notes: MCP tool parity matches the new root surface.
6. `npm --prefix mcp-server run build`
   - result: pass
   - notes: MCP server TypeScript build succeeded.
7. `npm run check`
   - result: pass
   - notes: frontend/type checks passed with no diagnostics.
8. `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "routes session-scoped socket commands through the session receiver"`
   - result: pass
   - notes: session receiver logging and routing remained correct after the command reshuffle.
9. `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "enforces worker local-network permissions at the backend"`
   - result: pass
   - notes: worker-visible tile capabilities reflect the reduced tile message surface.
10. `npm run test:integration -- tests/integration/work-registry.test.ts -t "keeps agent, topic, chatter, and work views private to the caller session"`
   - result: pass
   - notes: topic list rename and session privacy checks passed.
11. `npm run test:integration -- tests/integration/test-driver.test.ts -t "surfaces agent messaging activity in the per-pane activity projection"`
   - result: pass
   - notes: replaced the removed `agent_log_append` path with stable chatter-driven activity coverage.
12. `git diff --check`
   - result: pass
   - notes: no whitespace or patch-format issues remain.
