# Tile Signal Strip And Self Controls

## Status
Completed

## Date
2026-03-26

## Context
Terminal tiles already expose a bottom chrome area and an agent-local `self_display_draw` drawer, but there is no lightweight always-visible signal strip that an agent or shell script can use for attention-grabbing status. The requested behavior adds two new self-scoped APIs across socket, CLI, and MCP: `self_led_control` for driving an 8-LED strip with looping command sequences or named patterns, and `self_display_status` for updating a single-line ANSI status strip. The strip must render on all terminal tiles, not just agents, and the live LED animation path should not require rebroadcasting the entire `herd-agent-state` snapshot every frame.

## Goals
- Add an 8-LED strip and single-line ANSI status display to the bottom-left chrome of all terminal tiles.
- Add `self_led_control` across socket, CLI, and MCP for agent-local or tile-local LED control.
- Add `self_display_status` across socket, CLI, and MCP for the single-line status strip.
- Keep LED sequences looping until replaced and support built-in named patterns.
- Bootstrap tile signal state with the existing debug snapshot but deliver live updates through a dedicated incremental event.

## Non-goals
- Adding tile-targeted root control APIs for other tiles.
- Applying the signal strip to browser or work tiles.
- Replacing the existing `self_display_draw` drawer.
- Persisting LED or status strip state across app restarts.

## Scope
- Backend state, socket protocol, and event emission for tile signal state.
- CLI and MCP tool registration for the two new self-scoped APIs.
- Frontend state handling and terminal tile chrome rendering.
- Targeted unit/integration coverage for CLI serialization, MCP tool surface, store updates, and live tile rendering.
- Docs and PRD updates for the new interfaces.

## Risks And Mitigations
- High-frequency LED updates could spam full-session debug snapshots.
  - Mitigation: add a dedicated `herd-tile-signal-state` incremental event and keep snapshot use to bootstrap.
- Looping LED programs could outlive the tile that started them.
  - Mitigation: store per-tile runner generations and cancel/clear state when tiles are removed.
- ANSI marquee rendering could diverge from the existing preview renderer.
  - Mitigation: reuse `parseAnsiPreview` for the status strip and only add marquee layout logic around it.
- Plain shell tiles could be omitted because current self-display work is agent-focused.
  - Mitigation: key tile signal state by tile id and allow self-scoped sender resolution from `sender_tile_id` with no agent requirement.

## Acceptance Criteria
- Terminal tiles show a bottom-left LED strip and ANSI status strip in both agent and plain-shell tiles.
- `self_led_control` works through socket, CLI, and MCP, and supports structured command sequences plus named patterns.
- `self_display_status` works through socket, CLI, and MCP, renders ANSI colors, and loops long text as a marquee.
- LED command sequences loop until replaced, and replacing a sequence stops the prior animation.
- Live tile signal updates no longer depend on re-emitting the full `herd-agent-state` snapshot.

## Phase 0
### Objective
Lock the new API surface and tile state expectations with failing tests.

### Red
- Add failing MCP tool-surface tests for `self_led_control` and `self_display_status`.
- Add failing CLI serialization tests for `self led-control` and `self display-status`.
- Add failing frontend store tests for bootstrapped and incremental tile signal state.
- Add failing integration coverage for agent and shell tile signal strip rendering.

### Expected Failure Signal
- Missing tool names, unsupported CLI `self` subcommands, missing tile signal state in the frontend, and missing DOM signal strip elements.

### Green
- Confirm the new tests fail for the missing API/state/UI behavior before implementation.

### Verification Commands
- `npx vitest run --root mcp-server src/index.test.ts`
- `cargo test --manifest-path src-tauri/Cargo.toml cli::tests`
- `npm run test:unit -- --run src/lib/stores/appState.test.ts`
- `npx vitest run --config vitest.integration.config.ts tests/integration/worker-root-mcp.test.ts -t "tile-local LED"`

### Exit Criteria
- The added tests fail specifically on the absent self LED/status functionality.

## Phase 1
### Objective
Implement the backend tile signal model and the new self APIs.

### Red
- Re-run the new backend/CLI/MCP tests after the protocol and state scaffolding lands.

### Expected Failure Signal
- Parse/dispatch mismatches, invalid sender handling, or missing signal updates.

### Green
- Add tile signal state types and bootstrap snapshot support.
- Implement `self_led_control` and `self_display_status` in socket dispatch.
- Add CLI parsing and MCP tool registration.
- Emit `herd-tile-signal-state` incremental updates for live changes.

### Verification Commands
- `npx vitest run --root mcp-server src/index.test.ts`
- `cargo test --manifest-path src-tauri/Cargo.toml cli::tests`
- `cargo check --manifest-path src-tauri/Cargo.toml`

### Exit Criteria
- The self APIs compile, serialize, and update backend tile signal state correctly.

## Phase 2
### Objective
Render the new signal strip in terminal tiles and finish regression coverage.

### Red
- Re-run the frontend and integration tests against the first UI pass.

### Expected Failure Signal
- Missing LED/status strip rendering, wrong tile placement, or absent marquee behavior.

### Green
- Render the signal strip in the terminal tile info strip for all shell/agent tiles.
- Move any remaining bottom-left identity labels into the header.
- Reuse the ANSI preview parser for the status strip and add marquee overflow handling.
- Wire the frontend to bootstrap tile signal state and apply incremental updates.

### Verification Commands
- `npm run test:unit -- --run src/lib/stores/appState.test.ts src/lib/ansiPreview.test.ts`
- `npx vitest run --config vitest.integration.config.ts tests/integration/test-driver.test.ts -t "terminal tiles"`
- `npx vitest run --config vitest.integration.config.ts tests/integration/worker-root-mcp.test.ts -t "tile-local LED"`
- `npm run check`

### Exit Criteria
- The terminal strip renders correctly, updates live, and the targeted regressions pass.

## Execution Checklist
- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Phase 2 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log
1. `sed -n '1,240p' /Users/skryl/.codex/skills/phased-prd-red-green/SKILL.md`
   - result: pass
   - notes: loaded the phased PRD workflow.
2. `sed -n '1,260p' /Users/skryl/.codex/skills/phased-prd-red-green/references/prd_red_green_template.md`
   - result: pass
   - notes: loaded the PRD template before drafting this document.
3. `sed -n '1,220p' prd/2026_03_26_self_info_self_display_draw_prd.md`
   - result: pass
   - notes: reviewed the adjacent self-display PRD to keep the new feature aligned with the existing self-scoped display path.
4. `npx vitest run --root mcp-server src/index.test.ts`
   - result: fail, then pass
   - notes: initially failed because the worker MCP tool surface did not include `self_led_control` or `self_display_status`; passed after the shared tool registration update.
5. `cargo test --manifest-path src-tauri/Cargo.toml serializes_self_led_control_payload_with_sender_context -- --nocapture`
   - result: pass
   - notes: verified the new CLI `self led-control` payload shape once the parser and socket command were added.
6. `cargo test --manifest-path src-tauri/Cargo.toml serializes_self_display_status_payload_with_sender_context -- --nocapture`
   - result: pass
   - notes: verified the new CLI `self display-status` payload shape with sender context.
7. `npm run test:unit -- --run src/lib/stores/appState.test.ts -t "tile signal states"`
   - result: fail, then pass
   - notes: initially failed because the frontend state tree had no `tileSignals` path; passed after bootstrap and incremental update handling were added.
8. `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "tile-local LED"`
   - result: fail, then pass
   - notes: the first run proved the LEDs/status strip were wired but the marquee assertion was too optimistic at the default tile width; the rerun passed after the test resized the worker tile to force overflow.
9. `cargo check --manifest-path src-tauri/Cargo.toml`
   - result: pass
   - notes: confirmed the backend/socket/event changes compile cleanly.
10. `npm run check`
   - result: fail, then pass
   - notes: one remaining `AgentDebugState` fixture was missing `tile_signals`; the rerun passed after that last test fixture was updated.
11. `git diff --check -- README.md docs/architecture.md docs/socket-and-test-driver.md mcp-server/src/index.test.ts mcp-server/src/index.ts prd/2026_03_26_tile_signal_strip_prd.md src-tauri/src/agent.rs src-tauri/src/cli.rs src-tauri/src/socket/protocol.rs src-tauri/src/socket/server.rs src-tauri/src/state.rs src/App.svelte src/lib/TerminalTile.svelte src/lib/TileSignalStrip.svelte src/lib/stores/appState.test.ts src/lib/stores/appState.ts src/lib/types.ts tests/integration/worker-root-mcp.test.ts`
   - result: pass
   - notes: confirmed the touched files are patch-clean.
