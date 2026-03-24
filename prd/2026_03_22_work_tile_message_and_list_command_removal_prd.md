# Work Tile Message Routing And List Command Removal PRD

## Status

Completed

## Date

2026-03-22

## Context

Herd still exposes multiple list-style command families that duplicate the generic tile discovery surface: `shell_list`, `agent_list`, `tile_list`, and `work_list`. The socket server also still handles work lifecycle commands directly instead of routing existing-work operations through the work tile receiver path. The goal for this slice is to collapse discovery onto `session_list` and `network_list` with `tile_type` filters, and to make work item lookup/mutation follow the same message-passing model used by other tile-targeted commands.

## Goals

1. Remove `shell_list`, `agent_list`, `tile_list`, and `work_list` from socket, CLI, MCP, docs, and tests.
2. Use `session_list` and `network_list` with `tile_type` filtering as the only list/discovery surface.
3. Route existing-work commands through the work tile receiver/message path.
4. Keep structured tile-message logging for the work command wrappers.
5. Preserve the current permission model while removing redundant command surfaces.

## Non-goals

1. Reworking the session/network response shape beyond what is needed for command removal.
2. Expanding worker permissions for work tiles.
3. Introducing a new generic agent receiver architecture in this slice.

## Assumptions

1. `work_create` remains the one session-scoped creation wrapper because no persisted work tile exists before creation.
2. `work_get`, `work_stage_start`, `work_stage_complete`, `work_review_approve`, and `work_review_improve` are the work commands that should route through the work tile receiver path.

## Risks And Mitigations

1. Removing the list commands could leave stale parser/help/docs references.
   - Mitigation: update protocol, CLI parsing/tests, MCP tool registration/tests, integration helpers, and docs in one change.
2. Work wrappers could bypass the receiver again if the server maps directly to `work::*` helpers.
   - Mitigation: add work-specific message names to the receiver and make wrappers translate to those names.
3. The work receiver could drift from the existing work item response shape.
   - Mitigation: keep wrapper responses compatible by extracting the work details from the receiver result where needed.

## Acceptance Criteria

1. `shell_list`, `agent_list`, `tile_list`, and `work_list` no longer exist in the socket protocol, CLI, MCP tools, docs, or tests.
2. `session_list` and `network_list` with `tile_type` filtering cover the removed list use cases.
3. `work_get`, `work_stage_start`, `work_stage_complete`, `work_review_approve`, and `work_review_improve` route through the work tile receiver path before touching the work store.
4. Those work command wrappers still return the expected work-item payloads and still write tile-message logs.
5. Targeted Rust, MCP, TS, and integration checks are green.

## Phased Plan

### Phase 1: Red Surface Updates

#### Objective

Make the redundant list commands fail in tests and make the work receiver expectations explicit.

#### Red

1. Update CLI/MCP/integration expectations to remove the legacy list commands.
2. Add failing expectations for work-tile `responds_to` entries and work-command wrapper routing.

Expected failure signal:
- legacy list commands still appear in protocol/tool surfaces
- work tiles do not advertise or handle the work message names used by wrappers

#### Green

1. Remove the legacy list command variants and surfaces.
2. Update callers to use `session_list` or `network_list` with `tile_type`.

Verification commands:
- `cargo test --manifest-path src-tauri/Cargo.toml cli::tests`
- `npx vitest run --root mcp-server src/index.test.ts`

#### Exit Criteria

1. No removed list command is reachable through public surfaces.
2. Tests reference only the generic filtered list surfaces.

### Phase 2: Work Receiver Routing

#### Objective

Move existing-work wrappers onto the tile receiver/message path.

#### Red

1. Add failing Rust/integration expectations for work receiver messages and work command logging.

Expected failure signal:
- work wrappers still directly call `work::*` helpers
- work tiles do not support the required work message names

#### Green

1. Add work message names to the work tile receiver.
2. Translate the work wrappers to receiver calls and preserve existing response shapes.
3. Keep `work_create` as the session-scoped creation wrapper and document that exception.

Verification commands:
- `cargo test --manifest-path src-tauri/Cargo.toml network::tests`
- `cargo test --manifest-path src-tauri/Cargo.toml cli::tests`
- `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "lists current-session tiles for root and supports tile-type filters"`

#### Exit Criteria

1. Existing-work wrappers reach the work store only via the receiver/message path.
2. Work command results and logs remain correct.

### Phase 3: Docs And Final Verification

#### Objective

Remove stale references and verify the full slice.

#### Red

1. Keep docs/help/tests failing until the removed list commands are fully gone and work routing is verified.

#### Green

1. Update README and socket docs to describe the generic filtered list surfaces and work-tile routing.
2. Run the final targeted checks and record the results.

Verification commands:
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `npm run check`
- focused `npm run test:integration -- ...`

#### Exit Criteria

1. Docs match the implemented surface.
2. PRD status can be marked `Completed`.

## Implementation Checklist

- [x] PRD saved
- [x] Phase 1 surface removal complete
- [x] Phase 2 work receiver routing complete
- [x] Phase 3 docs and verification complete

## Command Log

1. `sed -n '1,220p' /Users/skryl/.codex/skills/phased-prd-red-green/SKILL.md`
   - result: pass
   - notes: confirmed the required phased PRD and red/green workflow for this slice
2. `rg -n "shell_list|agent_list|tile_list|work_list|work_get|work_create|work_stage_start|work_stage_complete|work_review_approve|work_review_improve|session_list|network_list|tile_type" src-tauri/src mcp-server/src src/lib tests README.md docs`
   - result: pass
   - notes: mapped the removal and rerouting touchpoints across socket, CLI, MCP, tests, and docs
3. `cargo check --manifest-path src-tauri/Cargo.toml`
   - result: pass with pre-existing warnings
   - notes: confirmed the protocol, server, CLI, and receiver refactor compiled after removing the legacy list commands
4. `npx vitest run --root mcp-server src/index.test.ts`
   - result: pass
   - notes: verified the MCP root tool surface after removing the redundant list tools
5. `cargo test --manifest-path src-tauri/Cargo.toml cli::tests`
   - result: pass
   - notes: verified the CLI no longer serializes the removed list commands and now relies on filtered `session_list` / `network_list`
6. `cargo test --manifest-path src-tauri/Cargo.toml network::tests`
   - result: pass
   - notes: verified the updated work-tile `responds_to` surface
7. `npm run check`
   - result: pass
   - notes: verified the TypeScript and frontend integration helper updates
8. `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "enforces worker local-network permissions at the backend"`
   - result: pass
   - notes: verified the removed socket list commands now fail as unknown commands and the worker tile boundary still holds
9. `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "lists, gets, moves, and resizes tiles for root"`
   - result: pass
   - notes: verified root discovery now works through `session_list` and that the generic tile APIs still behave correctly
10. `npm run test:integration -- tests/integration/work-registry.test.ts -t "keeps agent, topic, chatter, and work views private to the caller session"`
   - result: pass
   - notes: verified filtered `session_list` replaced the removed `agent_list` / `work_list` cases without crossing session boundaries
11. `npm run test:integration -- tests/integration/work-registry.test.ts -t "derives owner-only work updates from the port graph and enforces the full stage review lifecycle"`
   - result: pass
   - notes: verified `work_get`, stage mutations, review mutations, and tile-message logging all route through the work tile path
12. `git diff --check`
   - result: pass
   - notes: confirmed there are no whitespace or patch hygiene issues in the final change set
