## Title
Keep Agent Tiles Read-Only on the Network

## Status
Completed

## Date
2026-03-23

## Context
Worker-visible network APIs currently derive tile control rights from direct port connectivity. Because `agent` and `root_agent` tiles expose read/write ports, a directly connected worker can see and invoke control actions like `input_send`, `exec`, and `role_set` against another agent through `network_get` and `network_call`.

That violates the intended model. Agents should be able to message each other, but the network tile RPC surface for agent tiles should remain observational only.

## Goals
- Make `agent` and `root_agent` tiles always read-only through `network_list`, `network_get`, and `network_call`.
- Keep the network-visible agent interface limited to `get`, `call`, and `output_read`.
- Ensure direct network connections between agents do not grant control actions.
- Preserve message-based coordination between agents through the existing message commands.

## Non-goals
- Removing or changing `message_direct`, `message_network`, `message_public`, or `message_root`.
- Changing Root's session-scoped `tile_call` or root command wrappers.
- Changing current shell, browser, or work tile network permissions.

## Scope
- Backend network ACL calculation
- Network-visible `responds_to` and `message_api` for `agent` and `root_agent`
- Integration coverage for direct agent-to-agent connections
- Socket documentation for worker-visible network interfaces

## Risks and mitigations
- Risk: tightening network ACLs accidentally removes Root's session-level control over agent tiles.
  - Mitigation: apply the change only in network access resolution, not in the generic tile message receiver or root session wrappers.
- Risk: docs continue to imply direct agent connections unlock control.
  - Mitigation: update the worker network API docs in the same change.
- Risk: direct root-agent visibility behaves differently from worker-agent visibility.
  - Mitigation: add backend tests for both `Agent` and `RootAgent`.

## Acceptance criteria
- `network_list` and `network_get` show only `get`, `call`, and `output_read` for `agent` and `root_agent` tiles, even when directly connected.
- `network_call` rejects `input_send`, `exec`, and `role_set` for `agent` and `root_agent` tiles.
- Shell, browser, and work network behavior remains unchanged.
- Messaging surfaces between agents remain available and unchanged.
- Docs describe agent/root-agent network visibility as always read-only.

## Phased Plan (Red/Green)

### Phase 0
Objective: Lock the intended behavior and failing signals before implementation.

Red:
- Add failing backend assertions for direct network access to `agent` and `root_agent` tiles.
- Add failing integration assertions for direct worker-to-worker network visibility and `network_call` rejection.
- Expected failure signal:
  - direct network access resolves to read/write for agent tiles
  - `network_get` exposes control actions for directly connected agent tiles
  - `network_call` to `exec` or `input_send` on an agent tile succeeds

Green:
- Capture the contract in this PRD.

Verification commands:
- `cargo test --manifest-path src-tauri/Cargo.toml network::tests`
- targeted integration test after implementation

Exit criteria:
- The failing conditions are explicit and reproducible.

### Phase 1
Objective: Make agent/root-agent network ACLs permanently read-only.

Red:
- Run the new backend tests and capture the direct-access failure.
- Expected failure signal:
  - `rpc_access_for_sender_to_tile` returns `ReadWrite` for direct agent/root-agent connections

Green:
- Change network ACL derivation so `agent` and `root_agent` always resolve to `TileRpcAccess::Read` on the network.
- Let the existing access-filtered `responds_to`, `message_api`, and `network_call` enforcement reuse that policy.

Verification commands:
- `cargo test --manifest-path src-tauri/Cargo.toml network::tests`

Exit criteria:
- Backend access calculation and access-filtered metadata are green for agent/root-agent tiles.

### Phase 2
Objective: Prove the public network API matches the new policy and document it.

Red:
- Run the new integration assertions against the live worker network surface.
- Expected failure signal:
  - directly connected agent tiles still advertise or accept control actions over `network_*`

Green:
- Keep the backend change minimal and update docs to match the new behavior.

Verification commands:
- `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t \"keeps agent tiles read-only over direct worker network connections\"`
- `cargo test --manifest-path src-tauri/Cargo.toml`
- `npm run check`

Exit criteria:
- Public worker-facing network behavior is correct and documented.

## Execution Checklist
- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Phase 2 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log
1. `cargo test --manifest-path src-tauri/Cargo.toml network::tests::keeps_agent_tiles_read_only_over_direct_network_connections -- --exact`
   - result: fail
   - notes: red signal showed direct agent access still resolved to `ReadWrite` instead of `Read`.
2. `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "keeps agent tiles read-only over direct worker network connections"`
   - result: fail
   - notes: red signal showed a directly connected worker agent still advertised `input_send`, `exec`, and `role_set` in `responds_to`.
3. `cargo test --manifest-path src-tauri/Cargo.toml network::tests::keeps_agent_tiles_read_only_over_direct_network_connections -- --exact`
   - result: pass
   - notes: green after forcing `agent` and `root_agent` network access to resolve as read-only.
4. `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "keeps agent tiles read-only over direct worker network connections"`
   - result: pass
   - notes: directly connected agent and root-agent tiles now expose only `get`, `call`, and `output_read`, and `network_call` rejects control actions.
5. `cargo test --manifest-path src-tauri/Cargo.toml`
   - result: pass
   - notes: full Rust regression suite stayed green after fixing one stale read-only connection test fixture.
6. `npm run check`
   - result: pass
   - notes: Svelte and app/node TypeScript checks stayed green.
7. `npx tsc --noEmit --target ES2023 --lib ES2023 --module ESNext --moduleResolution bundler --allowImportingTsExtensions --verbatimModuleSyntax --strict --skipLibCheck --types node,vitest/globals tests/integration/*.ts`
   - result: pass
   - notes: integration TypeScript surfaces remain consistent with the new test coverage.
8. `git diff --check`
   - result: pass
   - notes: no patch formatting or whitespace issues remain.
