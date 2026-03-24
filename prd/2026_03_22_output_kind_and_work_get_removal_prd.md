## Title
Output Tile Kind Removal And Work Get Removal

## Status
Completed

## Date
2026-03-22

## Context
The socket/tile API still exposes an `output` tile kind even though output-mode panes should behave like shells, not a separate tile type. The tile discovery surface also exposes internal-only message names like `describe` and currently omits the generic tile API names the user wants visible. Separately, `work_get` still exists as a dedicated public command even though `tile_get` already returns full work tile details.

## Goals
- Remove `output` as a public tile kind from backend, frontend, and tests.
- Make tile `responds_to` advertise the generic tile API names plus the tile-specific messages.
- Remove `work_get` from the socket, CLI, MCP, docs, and tests.
- Keep tile instance execution on the tile message bus.

## Non-goals
- Removing the tmux output buffer feature used by shell reads.
- Reworking non-work tile-specific wrappers beyond the requested API shape.
- Changing worker/root permission boundaries beyond what is required for the new `responds_to` surface.

## Scope
- Rust socket protocol and dispatch
- Tile/network type definitions
- CLI and MCP surfaces
- Frontend/shared type definitions and state mapping
- Focused docs and tests

## Risks and mitigations
- Risk: exposing `call` and `send` in `responds_to` could accidentally be treated as callable tile messages.
  - Mitigation: separate public discovery metadata from internal dispatchable tile messages.
- Risk: removing `output` kind could break UI logic that depends on output-role panes.
  - Mitigation: keep pane role behavior if still needed, but map all such panes to `shell` for tile/network APIs.
- Risk: removing `work_get` could break tests or MCP tooling that still relies on it.
  - Mitigation: replace those callers with `tile_get` on `work:<work_id>` and update docs/tool listings in the same change.

## Acceptance criteria
- No public socket command named `work_get` remains.
- No public `NetworkTileKind` or serialized tile payload includes `output`.
- `responds_to` on each serialized tile includes `get`, `call`, and `send`, plus the tile-specific operations for that kind.
- Internal tile dispatch still only accepts actual tile message names.
- Focused Rust, MCP, frontend, and integration checks pass.

## Phased Plan (Red/Green)

### Phase 0
Objective: Capture the desired discovery surface and removal of `work_get`.

Red:
- Update focused unit/integration expectations to remove `output`, remove `work_get`, and assert the new `responds_to` shape.
- Expected failure signal:
  - stale `output` kind assertions
  - stale `work_get` tool/protocol assertions
  - `responds_to` mismatch

Green:
- Remove `output` from public tile kinds and map output-role panes to `shell` in tile/network APIs.
- Split public `responds_to` metadata from internal dispatchable messages.
- Remove `work_get` from protocol, handlers, CLI, MCP, docs, and test helpers.
- Update tile/work tests to use `tile_get` for work tiles.

Verification commands:
- `cargo test --manifest-path src-tauri/Cargo.toml network::tests`
- `cargo test --manifest-path src-tauri/Cargo.toml cli::tests`
- `npx vitest run --root mcp-server src/index.test.ts`
- `npm run check`
- focused integration tests for worker/root permissions and work lifecycle

Exit criteria:
- The targeted failing expectations turn green and no compatibility path remains for `output` or `work_get`.

### Phase 1
Objective: Refine docs and adjacent regression coverage around the new tile discovery surface.

Red:
- Run focused regression checks after Phase 0 and record any mismatches in docs/tool surfaces.
- Expected failure signal:
  - stale docs/tool lists
  - stale integration expectations around tile metadata

Green:
- Update README and socket docs to reflect the current API surface and `responds_to` contract.
- Update any remaining focused tests that assert the old command list or old tile kind.

Verification commands:
- `npm --prefix mcp-server run build`
- `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "enforces worker local-network permissions at the backend"`
- `npm run test:integration -- tests/integration/work-registry.test.ts -t "derives owner-only work updates from the port graph and enforces the full stage review lifecycle"`
- `npm run test:integration -- tests/integration/test-driver.test.ts -t "supports pane context menus for Claude panes and output-style panes"`
- `git diff --check`

Exit criteria:
- Docs, tool surfaces, and focused regressions all match the new public API.

## Execution Checklist
- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log
1. `rg -n "\\bOutput\\b|\\boutput\\b|work_get|responds_to\\(|describe\\b|tile_get\\b|tile_call\\b|tile_send\\b|NetworkTileKind|PaneKind" src-tauri src mcp-server tests README.md docs -g '!node_modules'`
   - result: pass
   - notes: confirmed lingering `output` tile kind and `work_get` references across backend, frontend, MCP, docs, and tests.
2. `cargo test --manifest-path src-tauri/Cargo.toml network::tests`
   - result: fail
   - notes: red phase failure showed stale `responds_to` values still exposing `describe` instead of the new generic tile API surface.
3. `cargo test --manifest-path src-tauri/Cargo.toml cli::tests`
   - result: fail
   - notes: red phase failure showed `work show` still serializing `work_get`.
4. `npx vitest run --root mcp-server src/index.test.ts`
   - result: fail
   - notes: red phase failure showed the MCP root tool surface still included `work_get`.
5. `cargo test --manifest-path src-tauri/Cargo.toml network::tests`
   - result: pass
   - notes: green after removing `output` from public tile kinds and splitting public `responds_to` from internal dispatchable messages.
6. `cargo test --manifest-path src-tauri/Cargo.toml cli::tests`
   - result: pass
   - notes: green after removing `work show` / `work_get` from the CLI surface.
7. `cargo check --manifest-path src-tauri/Cargo.toml`
   - result: pass
   - notes: full Rust check passed with pre-existing dead-code warnings only.
8. `npx vitest run --root mcp-server src/index.test.ts`
   - result: pass
   - notes: MCP root tool surface matches the new API.
9. `npm --prefix mcp-server run build`
   - result: pass
   - notes: MCP server TypeScript build succeeded.
10. `npm run check`
    - result: pass
    - notes: Svelte and TypeScript checks are clean.
11. `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "enforces worker local-network permissions at the backend"`
    - result: pass
    - notes: worker-visible `responds_to` and local-network restrictions remained correct.
12. `npm run test:integration -- tests/integration/work-registry.test.ts -t "derives owner-only work updates from the port graph and enforces the full stage review lifecycle"`
    - result: pass
    - notes: work lifecycle still works with `tile_get` replacing `work_get`.
13. `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "lists, gets, moves, and resizes tiles for root"`
    - result: pass
    - notes: root tile discovery and generic work tile inspection are correct.
14. `npm run test:integration -- tests/integration/test-driver.test.ts -t "shows Claude commands only for Agent tiles and dispatches execute vs insert correctly"`
    - result: pass
    - notes: output-role UI behavior still works after removing the public `output` tile kind.
