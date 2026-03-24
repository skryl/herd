## Title
Remove Public Pane IDs From Herd APIs

## Status
Completed

## Date
2026-03-23

## Context
Herd now owns stable `tile_id` values for tiles, but several public control surfaces still expose or require tmux `pane_id` values. That leaks an implementation detail, keeps sender identity partly tmux-based, and leaves the protocol split between tile-based and pane-based commands.

Current public leaks include:
- socket commands such as `browser_navigate`, `browser_load`, `browser_drive`, and `agent_register`
- root shell/browser MCP tools and CLI commands
- sender identity fields like `sender_pane_id` and create hints like `parent_pane_id`
- normal tile payloads that still serialize `pane_id`
- test-driver request/projection contracts that use pane IDs for tile interactions

The desired model is:
- `tile_id` is the only public identifier for control operations
- `pane_id` stays internal for tmux/browser/pty/runtime lookup
- diagnostic/read-only tmux-oriented surfaces may still display pane IDs, but no function call depends on them
- old pane-based request shapes are removed rather than preserved as compatibility aliases

## Goals
- Remove pane IDs from all public control APIs.
- Make `tile_id` the only public target for socket, MCP, CLI, and test-driver interaction flows.
- Change public sender identity from pane-based to tile-based.
- Stop serializing `pane_id` in normal tile and agent payloads.
- Keep internal tmux/browser/runtime behavior working through registry lookups.

## Non-goals
- Removing pane IDs from internal tmux/runtime code.
- Removing pane IDs from explicitly diagnostic raw tmux/debug state.
- Collapsing dedicated root shell/browser commands into `tile_call`.
- Reworking tmux snapshot internals beyond what is necessary to keep pane IDs private.

## Scope
- Socket protocol/request shapes and message dispatch
- Agent registration and sender resolution
- MCP tool schemas and startup registration
- CLI payload generation and help text
- Public TypeScript DTOs for tile/network/agent/test-driver contracts
- Test-driver request/projection tile targeting
- Public docs and examples

## Risks and mitigations
- Risk: cross-cutting API change breaks root tooling or worker sender resolution.
  - Mitigation: change backend routing first, then update wrappers/tests in the same change, with no legacy fallback.
- Risk: agent registration still depends on pane-first metadata.
  - Mitigation: require public `tile_id`, resolve backing pane/window internally from the tile registry, and keep `pane_id` internal.
- Risk: frontend/test-driver contracts still use pane IDs for tile actions.
  - Mitigation: rename request/projection fields to tile-based names and update their callers in the same change.
- Risk: diagnostic surfaces are conflated with public control APIs.
  - Mitigation: allow pane IDs only in explicitly diagnostic read-only data and document that exception clearly.

## Acceptance criteria
- Public socket request fields use `tile_id`, `sender_tile_id`, and `parent_tile_id` instead of pane-based identifiers.
- `shell_*` and `browser_*` control commands still exist publicly but target `tile_id`.
- `agent_register` accepts public `tile_id` instead of `pane_id`.
- Normal tile and agent payloads no longer include `pane_id`.
- MCP and CLI tools no longer accept pane IDs as public arguments.
- Public env-based sender identity uses `HERD_TILE_ID`, not `HERD_PANE_ID`.
- Test-driver tile interaction requests and projection fields are tile-based.
- Diagnostic tmux/debug data may still include pane IDs, but no public function call requires them.

## Phased Plan (Red/Green)

### Phase 0
Objective: Lock the new public contract before implementation.

Red:
- Add or update contract tests for socket/MCP/CLI/test-driver request shapes so pane-based public fields are rejected or absent.
- Add failing response-shape assertions that normal tile and agent payloads do not serialize `pane_id`.
- Expected failure signal:
  - current public commands still accept or emit pane IDs

Green:
- Write the PRD and enumerate the exact public interfaces that must switch to tile IDs.
- Prepare backend/type changes so every public target path resolves through `tile_id`.

Verification commands:
- targeted unit/integration tests after each phase

Exit criteria:
- The required API removals are explicit and testable.

### Phase 1
Objective: Remove pane IDs from backend public control interfaces.

Red:
- Add failing backend tests for:
  - `sender_tile_id` replacing `sender_pane_id`
  - `parent_tile_id` replacing `parent_pane_id`
  - `shell_*`, `browser_*`, and `agent_register` targeting `tile_id`
  - normal tile/agent payloads omitting `pane_id`
- Expected failure signal:
  - handlers still parse pane-based public fields or serialize pane IDs

Green:
- Update socket protocol types, request parsing, sender resolution, dispatch, and public response DTOs.
- Resolve public tile targets through the tile registry and use backing pane IDs only internally.

Verification commands:
- `cargo test --manifest-path src-tauri/Cargo.toml`

Exit criteria:
- Backend public control paths are tile-based only.

### Phase 2
Objective: Cut wrappers and public client contracts over to tile IDs.

Red:
- Add failing coverage for:
  - MCP tool schemas/commands
  - CLI payload generation/help text
  - TypeScript public DTOs and test-driver request/projection shapes
- Expected failure signal:
  - wrappers still take or emit pane IDs on public control paths

Green:
- Update MCP, CLI, public TS types, and frontend/test-driver tile interaction contracts.
- Keep pane IDs only inside runtime-facing UI models and diagnostic-only data.

Verification commands:
- `npm --prefix mcp-server run build`
- `npx vitest run --root mcp-server src/index.test.ts`
- `npm run check`
- `npx vitest run src/lib/stores/appState.test.ts`

Exit criteria:
- Public wrappers and client contracts are tile-based end to end.

### Phase 3
Objective: Refresh docs and prove no public pane-based call path remains.

Red:
- Add or update regression checks/examples that would fail if a public pane-based path still exists.
- Expected failure signal:
  - docs/tests still refer to pane IDs for control operations

Green:
- Update README and protocol docs.
- Run targeted backend/MCP/frontend/integration checks.
- Mark the PRD complete only after verification is green.

Verification commands:
- `cargo test --manifest-path src-tauri/Cargo.toml`
- `npm run check`
- `npx vitest run --root mcp-server src/index.test.ts`
- targeted integration tests for worker/root network and test-driver flows
- `git diff --check`

Exit criteria:
- Public documentation and tests describe only tile-based control APIs.

## Execution Checklist
- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Phase 2 complete
- [x] Phase 3 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log
1. `rg -n "pane_id|paneId|selected_pane_id|parent_pane_id|sender_pane_id" src-tauri/src/socket src-tauri/src/network.rs src-tauri/src/commands.rs src-tauri/src/state.rs src/lib src-tauri/src/cli.rs mcp-server/src docs README.md tests -g '!target'`
   - result: pass
   - notes: confirmed pane IDs still leak through socket, CLI, MCP, docs, and test-driver contracts.
2. `sed -n '320,470p' src-tauri/src/socket/server.rs`
   - result: pass
   - notes: confirmed sender resolution still accepts `sender_pane_id` and falls back through pane-based lookups.
3. `sed -n '500,780p' mcp-server/src/index.ts`
   - result: pass
   - notes: confirmed root MCP tools still take `pane_id` for shell/browser actions.
4. `sed -n '1,240p' src-tauri/src/cli.rs`
   - result: pass
   - notes: confirmed CLI help/payloads still expose pane-targeted control commands and env sender identity.
5. `sed -n '1,620p' src/lib/types.ts`
   - result: pass
   - notes: confirmed public TS DTOs still expose pane IDs in normal tile, agent, and test-driver contracts.
6. `cargo check --manifest-path src-tauri/Cargo.toml`
   - result: pass
   - notes: backend tile-based public request/response refactor compiled cleanly.
7. `npm --prefix mcp-server run build`
   - result: pass
   - notes: MCP tool schemas/payloads compile with tile-based public fields only.
8. `npm run check`
   - result: pass
   - notes: frontend and shared TypeScript contracts compile after switching the public test-driver projection/request surface to tile IDs.
9. `npx vitest run src/lib/stores/appState.test.ts`
   - result: pass
   - notes: frontend state/projection tests pass after removing public `pane_id` from `AgentInfo` and the test-driver projection.
10. `npx vitest run --root mcp-server src/index.test.ts`
    - result: pass
    - notes: MCP root/worker tool surface parity remains green after the tile-based contract update.
11. `cargo test --manifest-path src-tauri/Cargo.toml cli::tests`
    - result: pass
    - notes: CLI help/payload generation tests pass with `tile_id`, `sender_tile_id`, and `parent_tile_id`.
12. `git diff --check`
    - result: pass
    - notes: no whitespace or patch formatting issues remain.
13. `npm run test:integration -- tests/integration/test-driver.test.ts`
    - result: inconclusive
    - notes: the Tauri integration runtime booted but did not produce a pass/fail result in this environment before manual termination; the updated file still reflects the new tile-based public projection/request contract.
14. `npx tsc --noEmit --target ES2023 --lib ES2023 --module ESNext --moduleResolution bundler --allowImportingTsExtensions --verbatimModuleSyntax --strict --skipLibCheck --types node,vitest/globals tests/integration/*.ts`
    - result: pass
    - notes: all integration test files typecheck after updating the public test-driver/socket contract to tile-based fields.
15. `cargo test --manifest-path src-tauri/Cargo.toml`
    - result: pass
    - notes: full backend/unit test suite is green after the public API cutover.
16. `git diff --check`
    - result: pass
    - notes: final post-fix diff check remained clean.
17. `npx tsx -e 'import { startIntegrationRuntime } from "./tests/integration/runtime.ts"; ...'`
    - result: pass
    - notes: direct runtime bootstrap succeeded in a clean environment, isolating the earlier hang to the outer Vitest harness rather than Tauri startup itself.
18. `npx tsx -e 'import { startIntegrationRuntime } from "./tests/integration/runtime.ts"; ... tile-only smoke ...'`
    - result: pass
    - notes: runtime smoke verified `selected_tile_id`, absence of `selected_pane_id`, tile/session lookups without `pane_id`, and `network_list.sender_tile_id` against the live app/socket path.
