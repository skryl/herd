## Title
Network Call And Browser Drive Discovery

## Status
Completed

## Date
2026-03-23

## Context
The current tile discovery surface still advertises both `call` and `send` even though they are aliases, and browser tiles do not advertise the `drive` capability that already exists through the dedicated `browser_drive` wrapper. Workers also lack a session-level `network_call` command/tool that explicitly scopes generic tile calls to the sender's connected network component.

## Goals
- Remove `send` from tile `responds_to` metadata and leave `call` as the single generic tile invocation surface.
- Add `drive` to browser tile `responds_to` and make generic tile/network calls able to execute it.
- Add a session-level `network_call` socket command that resolves a target tile from the sender's current network component before dispatch.
- Expose `network_list`, `network_get`, and `network_call` to worker MCP mode.

## Non-goals
- Removing the dedicated `browser_drive` wrapper command in this pass.
- Changing root-only session tile operations beyond what is needed for `network_call`.

## Scope
- Rust socket protocol and receiver dispatch
- Shared tile discovery metadata
- CLI command payload building
- MCP tool registration and surface tests
- Focused integration coverage for worker network calling

## Risks and mitigations
- Risk: advertising `drive` without implementing generic dispatch for it would make `responds_to` inaccurate.
  - Mitigation: add the focused integration assertion first, then implement the message handler and permission path together.
- Risk: worker MCP could expose both old and new local-network call surfaces in a confusing way.
  - Mitigation: update the worker/shared tool surface in the same change and remove the redundant alias tool there.

## Acceptance criteria
- Browser tiles advertise `drive` in `responds_to`.
- No tile `responds_to` list includes `send`.
- No public `tile_send` command remains in the socket, CLI, or MCP surfaces.
- `network_call` exists as a session-scoped socket command and only resolves targets from the sender's network component.
- Worker MCP exposes `network_list`, `network_get`, and `network_call`.
- Focused Rust, MCP, frontend, and integration checks pass.

## Phased Plan (Red/Green)

### Phase 0
Objective: Capture the desired discovery surface and worker network-call behavior.

Red:
- Update focused integration and unit expectations for:
  - browser `responds_to` including `drive`
  - removal of `send` from all tile `responds_to` lists
  - worker `network_call` success on a visible tile and failure on a foreign tile
  - worker MCP shared tool list including `network_call`
- Expected failure signal:
  - stale `responds_to` arrays
  - missing `network_call` protocol/tool surface

Green:
- Keep the new expectations in place and implement the minimal protocol/dispatch/tooling changes to make them pass.

Verification commands:
- `cargo test --manifest-path src-tauri/Cargo.toml network::tests`
- `npx vitest run --root mcp-server src/index.test.ts`
- `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "enforces worker local-network permissions at the backend"`

Exit criteria:
- The targeted discovery and worker-network expectations pass.

### Phase 1
Objective: Wire the public command/tool surfaces and adjacent regressions.

Red:
- Run focused compile and type checks after the routing changes and capture any breakage in CLI/MCP typing.
- Expected failure signal:
  - protocol/CLI/MCP mismatches around `network_call`

Green:
- Add `network_call` to the socket protocol, session receiver, CLI, test client, docs, and worker MCP tool surface.
- Keep `browser_drive` as a wrapper, but make generic `call` support the same `drive` operation for browser tiles.

Verification commands:
- `cargo test --manifest-path src-tauri/Cargo.toml cli::tests`
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `npm run check`
- `git diff --check`

Exit criteria:
- Protocol, tooling, docs, and focused checks all match the new API surface.

## Execution Checklist
- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log
1. `cargo test --manifest-path src-tauri/Cargo.toml network::tests`
   - result: fail
   - notes: red phase failed as expected because `responds_to` still advertised `send` and browser tiles still lacked `drive`.
2. `npx vitest run --root mcp-server src/index.test.ts`
   - result: fail
   - notes: red phase failed because worker MCP still exposed `tile_call` / `tile_send` and did not expose `network_call`.
3. `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "enforces worker local-network permissions at the backend"`
   - result: fail
   - notes: red phase failed because worker tile discovery still included `send` and there was no `network_call` path.
4. `cargo test --manifest-path src-tauri/Cargo.toml network::tests`
   - result: pass
   - notes: green after updating tile discovery metadata and browser `drive`.
5. `cargo test --manifest-path src-tauri/Cargo.toml cli::tests`
   - result: pass
   - notes: CLI payloads now cover `network call` and no longer expose `tile send`.
6. `npx vitest run --root mcp-server src/index.test.ts`
   - result: pass
   - notes: worker/root MCP tool surfaces match the new `network_call` and `tile_call` split.
7. `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "enforces worker local-network permissions at the backend"`
   - result: pass
   - notes: worker network-scoped generic calling and browser `drive` via `network_call` passed.
8. `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "lists, gets, moves, and resizes tiles for root"`
   - result: pass
   - notes: adjacent root tile operations still work after removing `tile_send`.
9. `npm run check`
   - result: pass
   - notes: frontend and shared TypeScript checks remained green.
10. `cargo check --manifest-path src-tauri/Cargo.toml`
   - result: pass
   - notes: Rust compile passed with pre-existing dead-code warnings only.
11. `npm --prefix mcp-server run build`
   - result: pass
   - notes: MCP TypeScript build succeeded.
12. `git diff --check`
   - result: pass
   - notes: no whitespace or patch-format issues.
