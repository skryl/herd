# Agent Display Drawer And `display_draw`

## Status
Completed

## Date
2026-03-25

## Context
Terminal tiles currently expose one primary shell/agent surface plus the existing activity drawer. The requested behavior adds a second bottom drawer called Display and a third bottom-bar toggle called Shell so agent and shell tiles can independently show or hide the live shell surface, the new display surface, and the activity log. The new Display drawer is not a terminal transcript: it is an agent-local bitmap-like frame updated through a new `display_draw` MCP tool. The draw payload must always send a full frame size, and the rendered frame must stay centered inside the available drawer space.

## Goals
- Add three independent terminal-tile view toggles: `SHELL`, `DISPLAY`, and `ACT`.
- Keep the default state to only `SHELL` enabled.
- Add an agent-local `display_draw` MCP tool that replaces the tile’s display frame with ANSI-backed content plus explicit `columns` and `rows`.
- Render the display drawer with the same ANSI segment parser used by browser previews.
- Center the drawn frame inside the drawer regardless of tile size.

## Non-goals
- Network-exposing display drawing to other tiles.
- Incremental pixel-diff APIs or multi-layer compositing.
- Reworking browser/work tile bottom bars.
- Persisting display frames across full app restarts.

## Scope
- MCP server tool exposure for `display_draw`.
- Socket/backend command handling and in-memory display frame state.
- Agent debug snapshot plumbing to frontend state.
- New terminal display drawer component and terminal tile toggle/layout changes.
- Focused unit and integration coverage for tool exposure, display state propagation, and terminal-tile view toggles.

## Risks And Mitigations
- The draw API could sprawl into a second rendering format.
  - Mitigation: keep `display_draw` to full-frame ANSI text plus explicit `columns` and `rows`.
- Hiding the terminal surface could break xterm sizing or focus.
  - Mitigation: hide the shell surface without tearing down the xterm instance and resync viewport on re-show.
- Drawer stacking could regress the existing activity panel.
  - Mitigation: reuse the existing bottom-drawer pattern and extend the integration tests that already exercise terminal tile drawers.
- Agent-local ownership could be bypassed if the backend trusts arbitrary target ids.
  - Mitigation: `display_draw` takes no target tile id and always resolves the frame from the caller’s authenticated agent record.

## Acceptance Criteria
- Shell/agent tiles show `SHELL`, `DISPLAY`, and `ACT` controls in the bottom bar.
- Only `SHELL` is active by default.
- Toggling `SHELL` hides/shows the xterm surface without removing the tile.
- Toggling `DISPLAY` opens a resizable drawer that renders the latest agent display frame.
- `display_draw` is exposed on the MCP surface and only updates the calling agent’s own tile.
- The rendered display frame is centered inside the available drawer body.

## Phase 0
### Objective
Lock the requested surface with failing coverage.

### Red
- Add failing MCP coverage that expects `display_draw` on the worker/root MCP surfaces.
- Add failing backend/frontend coverage that expects agent debug snapshots to carry display frames.
- Add failing terminal tile integration coverage for the new `SHELL`/`DISPLAY`/`ACT` controls, default state, and display drawer visibility.

### Expected Failure Signal
- Missing MCP tool names, missing display state in snapshots, and missing terminal tile controls/drawers.

### Green
- Confirm the tests fail specifically because the display-drawer feature is not implemented yet.

### Verification Commands
- `npx vitest run --root mcp-server src/index.test.ts`
- `npm run test:integration -- tests/integration/test-driver.test.ts -t "shows shell, display, and activity toggles on terminal tiles"`
- `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "renders an agent-local display_draw frame in the terminal display drawer"`

### Exit Criteria
- The new tests fail for the missing display tool/state/UI path.

## Phase 1
### Objective
Implement the agent-local display tool and state propagation.

### Red
- Re-run the new MCP/backend tests after plumbing the command and snapshot shape.

### Expected Failure Signal
- Command parsing mismatches, missing sender validation, or snapshot shape/type errors.

### Green
- Add `display_draw` to the shared MCP tool surface.
- Add the backend command/state path that stores full-frame ANSI content by calling agent tile.
- Include agent display frames in the emitted agent debug snapshot.

### Verification Commands
- `npx vitest run --root mcp-server src/index.test.ts`
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `npm run check`

### Exit Criteria
- `display_draw` updates the caller’s display frame and the frontend state receives it.

## Phase 2
### Objective
Implement the centered display drawer and three-toggle terminal tile UI.

### Red
- Re-run the terminal-tile integration coverage with the new display state present.

### Expected Failure Signal
- The drawer is missing, not centered, not resizable, or the shell/activity toggles do not behave independently.

### Green
- Add the shared display drawer component using the ANSI preview renderer.
- Update terminal tiles to expose the three bottom-bar toggles with the requested default state and centered display layout.

### Verification Commands
- `npm run test:integration -- tests/integration/test-driver.test.ts -t "shows shell, display, and activity toggles on terminal tiles"`
- `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "renders an agent-local display_draw frame in the terminal display drawer"`
- `npm run check`

### Exit Criteria
- Terminal tiles expose the new three-view model and the display frame renders centered.

## Execution Checklist
- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Phase 2 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log
1. `sed -n '1,220p' /Users/skryl/.codex/skills/phased-prd-red-green/SKILL.md`
   - result: pass
   - notes: confirmed the required phased PRD workflow.
2. `sed -n '1,240p' /Users/skryl/.codex/skills/phased-prd-red-green/references/prd_red_green_template.md`
   - result: pass
   - notes: loaded the PRD template.
3. `sed -n '1,360p' src/lib/TerminalTile.svelte`
   - result: pass
   - notes: confirmed terminal tiles currently expose only the shell surface plus the activity drawer.
4. `sed -n '1,260p' src/lib/TileActivityDrawer.svelte`
   - result: pass
   - notes: confirmed the existing bottom-drawer pattern and resize-handle behavior to mirror for the display drawer.
5. `sed -n '1,260p' src/lib/ansiPreview.ts`
   - result: pass
   - notes: confirmed the existing ANSI preview parser that the display drawer should reuse.
6. `npx vitest run --root /Users/skryl/Dev/herd/mcp-server src/index.test.ts`
   - result: fail, then pass
   - notes: initially failed because `display_draw` was missing from the shared MCP tool surface; passed after the tool registration was added.
7. `npm run test:integration -- tests/integration/test-driver.test.ts -t "shows shell, display, and activity toggles on terminal tiles"`
   - result: fail, then pass
   - notes: initially failed because terminal tiles still only exposed the existing activity control; passed after `SHELL`, `DISPLAY`, and `ACT` were wired into [TerminalTile.svelte](/Users/skryl/Dev/herd/src/lib/TerminalTile.svelte).
8. `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "renders an agent-local display_draw frame in the terminal display drawer"`
   - result: fail, then pass
   - notes: initially failed because the socket protocol did not recognize `display_draw`; passed after the backend command/state path was added.
9. `cargo check --manifest-path /Users/skryl/Dev/herd/src-tauri/Cargo.toml`
   - result: pass
   - notes: verified the backend display-frame and socket changes compile cleanly.
10. `npm run check`
    - result: pass
    - notes: verified the Svelte and TypeScript surfaces, including the new `agentDisplays` app-state shape.
11. `npm run test:unit -- --run src/lib/stores/appState.test.ts`
    - result: fail, then pass
    - notes: initially exposed missing `agent_displays` fields in test fixtures; passed after the reducer tests were updated and the new display-frame mapping test was added.
12. `git diff --check -- /Users/skryl/Dev/herd/mcp-server/src/index.ts /Users/skryl/Dev/herd/mcp-server/src/index.test.ts /Users/skryl/Dev/herd/src-tauri/src/agent.rs /Users/skryl/Dev/herd/src-tauri/src/state.rs /Users/skryl/Dev/herd/src-tauri/src/socket/protocol.rs /Users/skryl/Dev/herd/src-tauri/src/socket/server.rs /Users/skryl/Dev/herd/src/lib/types.ts /Users/skryl/Dev/herd/src/lib/stores/appState.ts /Users/skryl/Dev/herd/src/lib/stores/appState.test.ts /Users/skryl/Dev/herd/src/lib/TerminalTile.svelte /Users/skryl/Dev/herd/src/lib/TerminalDisplayDrawer.svelte /Users/skryl/Dev/herd/tests/integration/test-driver.test.ts /Users/skryl/Dev/herd/tests/integration/worker-root-mcp.test.ts /Users/skryl/Dev/herd/prd/2026_03_25_agent_display_drawer_prd.md`
    - result: pass
    - notes: confirmed the touched files are free of whitespace and patch-format issues.
