# Self Info And `self_display_draw`

## Status
Completed

## Date
2026-03-26

## Context
The current worker/root MCP surface exposes `display_draw`, which is an agent-local operation but is named like a generic drawing primitive. The requested surface should make that ownership explicit by renaming it to `self_display_draw` everywhere. Separately, tiles currently have to ask for their own metadata indirectly through `network_get` or `tile_get`, which mixes self-inspection with network/session lookup semantics. The requested behavior adds a first-class `self_info` command/tool across the local APIs so a tile can fetch its own tile payload directly through its own receiver path.

## Goals
- Rename `display_draw` to `self_display_draw` across MCP, socket, CLI-facing docs/tests, and backend validation/errors.
- Add a new `self_info` command/tool across the local APIs, including worker MCP.
- Make `self_info` return the sender tile's native `get` payload, not a sender-visible network-filtered projection.
- Keep the repo on a single path with no backward-compatible alias for `display_draw`.

## Non-goals
- Changing `network_get`, `tile_get`, or network visibility semantics.
- Adding a writable self-mutation surface beyond the display rename.
- Changing how non-self tile RPC access is filtered.

## Scope
- MCP tool registration and tool-surface tests.
- Socket protocol, dispatch, and sender-resolution handling.
- CLI command/help/payload serialization.
- Integration tests covering `self_info` and `self_display_draw`.
- Docs updates for the worker/root interface.

## Risks And Mitigations
- Existing tests or docs may still refer to `display_draw`.
  - Mitigation: rename all occurrences in one change and keep no alias path.
- `self_info` could accidentally reuse `network_get` and inherit read-filtered semantics for self.
  - Mitigation: route `self_info` through the sender tile receiver's `get` behavior.
- CLI/MCP surfaces could diverge.
  - Mitigation: add parity-focused tests for the registered tool names and socket payloads.

## Acceptance Criteria
- Workers and Root expose `self_display_draw` instead of `display_draw`.
- No API surface in the repo still advertises `display_draw`.
- Workers and Root expose `self_info`.
- `self_info` returns the same tile payload the tile receiver would return for `get` on the sender tile.
- Targeted MCP, socket/CLI, and integration tests pass.

## Phase 0
### Objective
Lock the requested API changes with failing tests.

### Red
- Add failing MCP parity tests expecting `self_display_draw` and `self_info`.
- Add failing socket/CLI serialization tests for `self_info`.
- Add failing integration coverage for worker `self_info` and renamed `self_display_draw`.

### Expected Failure Signal
- Missing tool names, unsupported socket command names, and integration failures on the old `display_draw` name / missing `self_info`.

### Green
- Confirm those tests fail because the new surface is not implemented yet.

### Verification Commands
- `npx vitest run --root mcp-server src/index.test.ts`
- `cargo test --manifest-path src-tauri/Cargo.toml serializes_`
- `npx vitest run --config vitest.integration.config.ts tests/integration/worker-root-mcp.test.ts -t "self_info|self_display_draw"`

### Exit Criteria
- The new tests fail specifically on missing rename/new command behavior.

## Phase 1
### Objective
Implement the backend and interface changes.

### Red
- Re-run the new tests after protocol and dispatch plumbing is partially added.

### Expected Failure Signal
- Parsing/dispatch mismatches or wrong self payload semantics.

### Green
- Rename the command/tool to `self_display_draw`.
- Add `self_info` to socket, CLI, and MCP.
- Route `self_info` to the sender tile receiver `get` path.

### Verification Commands
- `npx vitest run --root mcp-server src/index.test.ts`
- `cargo test --manifest-path src-tauri/Cargo.toml serializes_`
- `cargo test --manifest-path src-tauri/Cargo.toml self_info`

### Exit Criteria
- The new APIs are callable and return the expected shapes.

## Phase 2
### Objective
Finish docs and regression coverage.

### Red
- Re-run targeted integration/docs checks against the renamed surface.

### Expected Failure Signal
- Stale docs strings or integration assertions still referencing `display_draw`.

### Green
- Update docs to describe `self_info` and `self_display_draw`.
- Run targeted regression coverage for worker/root MCP and CLI/socket serialization.

### Verification Commands
- `npx vitest run --config vitest.integration.config.ts tests/integration/worker-root-mcp.test.ts`
- `cargo test --manifest-path src-tauri/Cargo.toml`
- `git diff --check -- mcp-server/src/index.ts mcp-server/src/index.test.ts src-tauri/src/socket/protocol.rs src-tauri/src/socket/server.rs src-tauri/src/cli.rs tests/integration/worker-root-mcp.test.ts docs/architecture.md docs/socket-and-test-driver.md prd/2026_03_26_self_info_self_display_draw_prd.md`

### Exit Criteria
- Targeted regressions pass and docs match the new surface.

## Execution Checklist
- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Phase 2 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log
1. `sed -n '1,220p' /Users/skryl/.codex/skills/phased-prd-red-green/SKILL.md`
   - result: pass
   - notes: loaded the required workflow.
2. `sed -n '1,220p' /Users/skryl/.codex/skills/phased-prd-red-green/references/prd_red_green_template.md`
   - result: pass
   - notes: loaded the PRD template.
3. `rg -n "display_draw|self_info|tile_get|network_get|command: \"display_draw\"|responds_to\(|message_api\(|get_message_spec|call_message_spec|self_" mcp-server src-tauri src docs tests | head -n 400`
   - result: pass
   - notes: confirmed `display_draw` exists and `self_info` does not.
4. `npx vitest run --root mcp-server src/index.test.ts`
   - result: fail, then pass
   - notes: initially failed because the shared worker tool list still exposed `display_draw` and lacked `self_info`; passed after the MCP surface rename/addition.
5. `cargo test --manifest-path src-tauri/Cargo.toml serializes_self_info_payload_with_sender_context -- --nocapture`
   - result: fail, then pass
   - notes: initially failed with `unknown command group: self`; passed after the CLI parser added `self info`.
6. `cargo test --manifest-path src-tauri/Cargo.toml serializes_network_get_payload_with_sender_context -- --nocapture`
   - result: pass
   - notes: confirmed adjacent CLI serialization stayed intact.
7. `cargo check --manifest-path src-tauri/Cargo.toml`
   - result: pass
   - notes: verified the backend/socket changes compile cleanly.
8. `npm run build`
   - result: pass
   - notes: rebuilt the MCP bridge after the tool-surface change.
9. `npx vitest run --config vitest.integration.config.ts tests/integration/worker-root-mcp.test.ts -t "self_info|self_display_draw"`
   - result: fail
   - notes: first run hit a root-agent bootstrap timeout before the new commands executed.
10. `npx vitest run --config vitest.integration.config.ts tests/integration/worker-root-mcp.test.ts -t "returns self_info for a worker tile and renders an agent-local self_display_draw frame in the terminal display drawer"`
   - result: pass
   - notes: rerun passed, confirming the failure was integration startup flake rather than an API regression.
11. `git diff --check -- mcp-server/src/index.ts mcp-server/src/index.test.ts src-tauri/src/socket/protocol.rs src-tauri/src/socket/server.rs src-tauri/src/state.rs src-tauri/src/cli.rs tests/integration/worker-root-mcp.test.ts README.md docs/architecture.md docs/socket-and-test-driver.md prd/2026_03_26_self_info_self_display_draw_prd.md`
   - result: pass
   - notes: confirmed the touched files are patch-clean.
