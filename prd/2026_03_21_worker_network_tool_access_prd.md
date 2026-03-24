## Title

Worker Local-Network Tool Access

## Status

Completed

## Date

2026-03-21

## Context

Herd currently keeps worker agents on a narrow MCP surface: messages plus `network_list`. Workers can discover other tiles on their local network, but they cannot operate visible `shell` or `browser` tiles directly. Any real action still requires Root.

The agreed target behavior for this slice is:

1. Workers keep direct access to message tools and local network inspection.
2. Workers gain direct access to visible local-network `shell` and `browser` tiles only.
3. The interaction model is generic:
   - `network_list` and `network_get` advertise a tile's allowed action set
   - `tile_call` executes an allowed action against a visible local-network tile
4. The authority rule is shared access:
   - any worker on the same local network may invoke allowed actions
   - there is no lease or exclusive controller in this change
5. `work` tiles stay out of scope for worker direct operation.
6. Root keeps the full privileged surface and remains responsible for all session/topology/work mutations.

## Goals

1. Add a worker-safe local-network tool interaction surface.
2. Keep worker access session-local and network-local.
3. Preserve Root-only control for layout, lifecycle, topology, and work mutation.
4. Make per-tile allowed actions discoverable instead of implicit.
5. Keep the change additive to existing Root shell/browser commands.

## Non-goals

1. Worker direct interaction with `work` tiles.
2. Changing the port/network model or work ownership model.
3. Adding leases, locks, or exclusive controllers for shared tools.
4. Replacing Root's existing shell/browser/session command surface.

## Scope

In scope:

1. New socket commands for `network_get` and `tile_call`.
2. Worker MCP tools for `network_get` and `tile_call`.
3. CLI support for `herd network get` and `herd tile call`.
4. Capability metadata returned from `network_list` and `network_get`.
5. Backend permission checks for worker-safe shell/browser access.
6. Tests and doc/skill updates for the new behavior.

Out of scope:

1. Worker direct work-stage or work-file operations.
2. New browser capabilities beyond existing navigate/load behavior.
3. Non-network session reads for workers.

## Risks And Mitigations

1. A generic `tile_call` can become an unbounded escape hatch.
   - Mitigation: backend owns the allowlist by tile kind and action name; workers never call raw root commands directly.
2. Shared access can create concurrent writes to the same shell or browser.
   - Mitigation: accept shared access intentionally for v1 and keep the allowed action set narrow.
3. Capability drift between MCP docs and backend checks can confuse agents.
   - Mitigation: derive `allowed_actions` from one backend source and expose it through `network_list`, `network_get`, CLI, MCP, and docs.
4. Expanding worker MCP could weaken the root/worker boundary.
   - Mitigation: keep worker tools limited to network-local `network_get` and `tile_call`; all session/global and mutating admin actions remain root-only.

## Acceptance Criteria

1. Worker MCP exposes:
   - `message_direct`
   - `message_public`
   - `message_network`
   - `message_root`
   - `sudo`
   - `network_list`
   - `network_get`
   - `tile_call`
2. `network_list` returns `allowed_actions` for visible local-network tiles.
3. `network_get` returns one visible local-network tile plus its `allowed_actions`.
4. Workers can use `tile_call` only on visible local-network `shell` and `browser` tiles.
5. V1 worker `tile_call` actions are:
   - shell: `output_read`, `input_send`, `exec`
   - browser: `navigate`, `load`
6. Workers cannot use `tile_call` on:
   - tiles outside their local network
   - other sessions
   - `work`, `agent`, `root_agent`, or `output` tiles
   - disallowed actions such as destroy, resize, move, title/role/read-only changes, or work actions
7. Root retains full existing shell/browser/session control behavior.
8. CLI exposes:
   - `herd network get <tile_id>`
   - `herd tile call <tile_id> <action> [json_args]`

## Phased Plan

### Phase 0: PRD And Failing Surface Checks

#### Objective

Create the PRD and add failing checks for worker-visible `network_get`, capability metadata, and worker-safe `tile_call`.

#### Red

1. Add failing tests for:
   - missing `network_get` socket/MCP/CLI surface
   - missing `allowed_actions` on `network_list`
   - missing worker `tile_call`
   - worker permission failures for visible local-network shell/browser interaction

Expected failure signal:

1. worker MCP has no direct tool interaction surface
2. `network_list` payloads do not describe callable actions
3. worker `tile_call` does not exist or is rejected as root-only

#### Green

1. Create this PRD.
2. Land the failing checks needed for later phases.

Verification commands:

1. `npx vitest run --config mcp-server/vitest.config.ts`
2. `cargo test --manifest-path src-tauri/Cargo.toml cli::tests`

#### Exit Criteria

1. The PRD exists in `prd/`.
2. The red checks fail for the expected reasons.

### Phase 1: Backend Capability Model And Socket Surface

#### Objective

Add a backend-owned capability model and worker-safe socket commands for local-network tool access.

#### Red

1. Add failing Rust tests for:
   - capability derivation by tile kind
   - `network_get`
   - worker `tile_call` on allowed shell/browser actions
   - rejection of non-local, other-session, and unsupported tile/action combinations

Expected failure signal:

1. no capability metadata exists
2. `network_get` is unsupported
3. `tile_call` is unsupported or too permissive

#### Green

1. Add backend types for per-tile allowed actions.
2. Extend session/network tile payloads to expose `allowed_actions`.
3. Add socket commands:
   - `network_get`
   - `tile_call`
4. Implement backend authorization:
   - sender must be live
   - tile must be in sender session
   - tile must be in sender component
   - tile kind and action must be on the allowlist
5. Map worker-safe calls onto existing shell/browser backend behavior without exposing root-only actions.

Verification commands:

1. `cargo test --manifest-path src-tauri/Cargo.toml network::tests`
2. `cargo test --manifest-path src-tauri/Cargo.toml`

#### Exit Criteria

1. Backend advertises capability data from one source of truth.
2. Worker-safe socket commands exist and enforce the intended boundary.

### Phase 2: MCP And CLI Surface

#### Objective

Expose the new local-network tool interactions to workers through MCP and CLI.

#### Red

1. Add failing tests for:
   - worker MCP missing `network_get` and `tile_call`
   - root MCP parity retaining the full surface
   - CLI serialization for `herd network get` and `herd tile call`

Expected failure signal:

1. worker MCP remains message-only plus `network_list`
2. CLI has no supported path for the new commands

#### Green

1. Add worker MCP tools:
   - `network_get`
   - `tile_call`
2. Keep Root MCP unchanged except for parity with the new shared tools.
3. Add CLI commands:
   - `herd network get <tile_id>`
   - `herd tile call <tile_id> <action> [json_args]`
4. Update worker/root tool descriptions so agents understand that:
   - `network_list` and `network_get` are discoverability paths
   - `tile_call` is restricted to the advertised action set
   - anything outside that set still goes through Root

Verification commands:

1. `npx vitest run --config mcp-server/vitest.config.ts`
2. `cargo test --manifest-path src-tauri/Cargo.toml cli::tests`

#### Exit Criteria

1. Worker MCP exposes the new worker-safe interaction tools.
2. CLI and MCP match the backend contract.

### Phase 3: Integration, Docs, And Skill Updates

#### Objective

Lock the behavior with end-to-end tests and update the operator/agent docs.

#### Red

1. Add failing integration tests for:
   - worker using `network_list` to discover allowed actions
   - worker using `network_get` on visible vs non-visible tiles
   - worker `tile_call` success for local shell/browser
   - worker `tile_call` rejection for unsupported tiles/actions
   - shared access from multiple workers on one network

Expected failure signal:

1. end-to-end worker access still requires Root
2. capability metadata is absent or inconsistent
3. docs still describe workers as message-only

#### Green

1. Add/update targeted integration tests.
2. Update README, socket docs, architecture docs, and `/herd` skill to describe:
   - worker local-network tool access
   - v1 tile kinds and action set
   - continued Root-only scope for everything else
3. Mark this PRD `Completed` once targeted verification is green.

Verification commands:

1. `npx vitest run --config vitest.integration.config.ts tests/integration/worker-root-mcp.test.ts --reporter=verbose`
2. `npm run check`
3. `cargo check --manifest-path src-tauri/Cargo.toml`

#### Exit Criteria

1. End-to-end worker tool access works as specified.
2. Docs and skill text match the shipped model.

## Execution Checklist

- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Phase 2 complete
- [x] Phase 3 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log

1. `sed -n '1,260p' /Users/skryl/.codex/skills/phased-prd-red-green/references/prd_red_green_template.md`
   - result: `pass`
   - notes: confirmed PRD skeleton
2. `sed -n '1,240p' src-tauri/src/socket/protocol.rs`
   - result: `pass`
   - notes: confirmed current socket surface lacks `network_get` and `tile_call`
3. `sed -n '2000,2310p' src-tauri/src/socket/server.rs`
   - result: `pass`
   - notes: confirmed current worker boundary and list/network handlers
4. `sed -n '440,760p' mcp-server/src/index.ts`
   - result: `pass`
   - notes: confirmed worker MCP currently exposes only messages plus `network_list`
5. `cargo test --manifest-path src-tauri/Cargo.toml`
   - result: `pass`
   - notes: backend capability, socket, work, and CLI regression suites passed
6. `cargo check --manifest-path src-tauri/Cargo.toml`
   - result: `pass`
   - notes: Rust compile check green after backend/socket updates
7. `npx vitest run --config mcp-server/vitest.config.ts`
   - result: `pass`
   - notes: worker/root MCP surface parity reflects `network_get` and `tile_call`
8. `npm run check`
   - result: `pass`
   - notes: frontend/shared type checks green with the expanded `SessionTileInfo` shape
9. `npx vitest run --config vitest.integration.config.ts tests/integration/worker-root-mcp.test.ts -t "enforces worker local-network permissions at the backend|allows shared shell access from multiple workers on one local network" --reporter=verbose`
   - result: `pass`
   - notes: targeted end-to-end worker local-network shell/browser access passed
