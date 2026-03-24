# Browser Tile Incognito Create Option

Status: Completed
Date: 2026-03-23

## Context

All browser tiles currently share the default browser storage, so cookies and other site state bleed across tiles. The requested behavior is not to change the default, but to make it possible to create a browser tile in incognito mode during tile creation.

## Goals

- Add an explicit non-default browser tile creation option that starts the browser webview in incognito mode.
- Preserve the incognito setting from tile creation through later browser webview sync/navigation.
- Expose the option consistently across the socket, CLI, and frontend invoke surfaces that already create browser tiles.

## Non-goals

- Do not change the default browser tile behavior.
- Do not add a new browser UI control for toggling profiles after creation.
- Do not add persistent named browser profiles beyond an incognito option.

## Scope

- Browser tile creation plumbing in socket protocol, command helpers, frontend Tauri wrappers, and CLI serialization.
- Durable storage of the browser tile incognito flag in tracked tile metadata.
- Browser webview creation using the stored incognito setting.
- Focused regression coverage and API docs for the new creation option.

## Risks and mitigations

- Risk: the browser tile is visible before the incognito flag is persisted.
  - Mitigation: persist the browser tile record before emitting the browser snapshot for creation.
- Risk: incognito creation is wired through one path but not others.
  - Mitigation: cover socket `tile_create`, direct Tauri `spawn_browser_window`, and CLI serialization in the same change.
- Risk: storage settings drift from tile lifecycle.
  - Mitigation: store the flag on `tile_registry`, which is already the durable source of tracked tile metadata.

## Acceptance criteria

- `tile_create` for `browser` accepts an explicit incognito flag.
- Omitted flag preserves the current default shared-profile behavior.
- Browser webviews created from incognito-marked tiles start with Tauri’s incognito mode enabled.
- A default browser tile and an incognito browser tile do not share local browser storage in the integration test.
- Docs mention the new browser creation option.

## Phased Plan

### Phase 0

Objective: add failing coverage for browser incognito creation and isolation.

Red:
- Add an integration test that creates one default browser tile and one incognito browser tile, loads the same page, writes browser storage in one, and proves the incognito tile does not see it.
- Add targeted API serialization assertions for the new create option where needed.
- Expected failure signal: the incognito option is rejected/ignored or the browser storage remains shared.

Green:
- No implementation in this phase.

Exit criteria:
- The new coverage fails for the current behavior.

### Phase 1

Objective: implement incognito browser tile creation end to end.

Red:
- Run the new targeted tests and capture the failing signal.

Green:
- Add the browser incognito creation option to the public create surfaces.
- Persist the flag on tile metadata.
- Use the persisted flag when building browser webviews.
- Update docs for the new create option.
- Verification commands:
  - targeted Rust tests
  - targeted integration tests
  - `git diff --check`

Exit criteria:
- Targeted tests pass and the default browser path remains unchanged.

## Execution Checklist

- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log

1. `rg -n "browser.*profile|cookie jar|cookiejar|user_data_dir|user data dir|BrowserContext|profile|tileCreate\\('browser'|tile_create.*browser|spawnBrowser|browser window|webview" src-tauri src tests docs -g '!src-tauri/target'`
   - result: pass
   - notes: identified browser creation, socket protocol, frontend invoke, and browser webview builder paths.
2. `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "creates browser tiles with optional incognito storage isolation"`
   - result: fail
   - notes: red phase; incognito browser still saw the default-profile `localStorage` value.
3. `cargo test --manifest-path src-tauri/Cargo.toml`
   - result: pass
   - notes: covers Rust unit tests for CLI serialization, DB migration, and backend browser/tile plumbing.
4. `npm --prefix mcp-server run build`
   - result: pass
   - notes: verifies MCP tool schema and payload updates still typecheck.
5. `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "creates browser tiles with optional incognito storage isolation"`
   - result: pass
   - notes: green phase; default and incognito browser tiles no longer shared storage.
6. `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "drives browser tiles through browser_drive"`
   - result: pass
   - notes: regression check for the existing browser tile control path.
7. `git diff --check -- src-tauri/src/db.rs src-tauri/src/tile_registry.rs src-tauri/src/commands.rs src-tauri/src/browser.rs src-tauri/src/socket/protocol.rs src-tauri/src/socket/server.rs src-tauri/src/cli.rs src/lib/tauri.ts mcp-server/src/index.ts docs/socket-and-test-driver.md tests/integration/client.ts tests/integration/worker-root-mcp.test.ts prd/2026_03_23_browser_incognito_tile_create_prd.md`
   - result: pass
   - notes: final whitespace/conflict check for touched files.
