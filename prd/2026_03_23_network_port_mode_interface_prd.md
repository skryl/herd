## Title
Port-Aware Network Tile Interfaces

## Status
Completed

## Date
2026-03-23

## Context
`network_list`, `network_get`, and `network_call` currently treat every visible tile in a connected component as exposing the same interface. That loses the distinction between direct control through a target tile's read/write port and passive visibility through a read-only or indirect network path. The user wants the network-scoped interface and enforcement to reflect the actual port relationship between sender and target.

## Goals
- Make `network_list` and `network_get` filter each target tile's `responds_to` based on the sender tile's effective access.
- Split each tile kind's network-visible interface into read vs read/write.
- Make `network_call` enforce the same port-aware access rules used by `network_list` and `network_get`.
- Apply the same backend restriction to non-root `tile_call` so raw socket callers cannot bypass the new network access rules.

## Non-goals
- Changing root session-wide `tile_call` behavior.
- Changing session-scoped `tile_get` / `tile_list` discovery.
- Reworking the port graph model or connection rules themselves.

## Scope
- Rust network access helpers
- Rust socket session/tile dispatch
- Focused network and integration tests
- Focused docs for network-scoped discovery/calling

## Risks and mitigations
- Risk: browser `drive` mixes read and write sub-actions under one RPC name.
  - Mitigation: keep the read-only network interface conservative and only advertise always-safe read RPCs there.
- Risk: worker raw socket callers could still bypass the new access model through `tile_call`.
  - Mitigation: apply the same read vs read/write enforcement to non-root `tile_call`.

## Acceptance criteria
- A sender directly connected to a target tile's read/write port sees the full `responds_to` list for that tile through `network_list` / `network_get`.
- A sender connected only through a read-only target port or only indirectly through the network sees only the read interface for that tile.
- `network_call` rejects mutating RPCs when the sender only has read access.
- Non-root `tile_call` uses the same backend access checks as `network_call`.
- Focused Rust and integration checks pass.

## Phased Plan (Red/Green)

### Phase 0
Objective: Capture the port-aware interface differences in tests.

Red:
- Extend the worker network-permissions integration to cover:
  - direct read/write access to a browser tile
  - direct read-only access to that same browser tile from a different worker
  - indirect read-only access to a shell tile through the shared component
- Add unit expectations for read vs read/write `responds_to` lists.
- Expected failure signal:
  - `network_list` / `network_get` still return the same full interface regardless of port relationship
  - `network_call` still allows writes from read-only/indirect senders

Green:
- Keep the new expectations in place and implement the minimal network access helpers needed to make them pass.

Verification commands:
- `cargo test --manifest-path src-tauri/Cargo.toml network::tests`
- `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "enforces worker local-network permissions at the backend"`

Exit criteria:
- The targeted network discovery and permission expectations pass.

### Phase 1
Objective: Apply the same model consistently across backend entry points and docs.

Red:
- Run focused compile and regression checks after the access-model refactor and capture any breakage in nearby command paths.
- Expected failure signal:
  - mismatches between network discovery and non-root `tile_call`

Green:
- Route non-root `tile_call` through the same port-aware message authorization logic.
- Update docs describing `network_list`, `network_get`, and `network_call` to explain read vs read/write visibility.

Verification commands:
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `npm run check`
- `git diff --check`

Exit criteria:
- The backend uses one consistent access model for network-scoped discovery/calling and docs match it.

## Execution Checklist
- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log
1. `cargo test --manifest-path src-tauri/Cargo.toml network::tests`
   - result: pass
   - notes: unit coverage now verifies read vs read/write `responds_to` lists and sender-to-target access derivation.
2. `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "enforces worker local-network permissions at the backend"`
   - result: fail
   - notes: red signal confirmed the stale behavior. The observer still saw full browser RPCs instead of the read-only interface.
3. `cargo check --manifest-path src-tauri/Cargo.toml`
   - result: pass
   - notes: access-model refactor compiled cleanly aside from pre-existing dead-code warnings.
4. `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "enforces worker local-network permissions at the backend"`
   - result: pass
   - notes: worker discovery and `network_call` now respect direct read/write vs read-only/indirect access.
5. `npm run check`
   - result: pass
   - notes: no Svelte or TypeScript regressions.
6. `git diff --check`
   - result: pass
   - notes: no whitespace or patch formatting issues.
