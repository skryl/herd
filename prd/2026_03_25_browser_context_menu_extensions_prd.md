## Title

Browser Context Menu Extension Loader

## Status

Completed

## Date

2026-03-25

## Context

The canvas context menu must always appear above every tile surface, including native browser child webviews. Browser tiles also need a tile-local context-menu entry that loads any local browser extension page from `extensions/browser` without going through the socket-only `browser_load` path.

## Goals

- Keep the DOM context menu visible above browser child webviews.
- Add a browser-tile `Load` submenu that lists the browser extension pages under `extensions/browser`.
- Route browser context-menu loads through a frontend-supported Tauri command path.
- Cover the new submenu and suppression behavior with focused store and integration checks.

## Non-goals

- Intercepting right-clicks inside the browser page content itself.
- Adding nested submenus beyond the single `Load` submenu.
- Changing non-browser tile context-menu items.

## Scope

- `src/lib/ContextMenu.svelte`
- `src/lib/BrowserTile.svelte`
- `src/lib/stores/appState.ts`
- `src/lib/stores/appState.test.ts`
- `src/lib/tauri.ts`
- `src/lib/types.ts`
- `src-tauri/src/browser.rs`
- `src-tauri/src/lib.rs`
- `tests/integration/test-driver.test.ts`

## Risks and mitigations

- Risk: browser child webviews can visually cover the DOM context menu regardless of CSS z-index.
  - Mitigation: suppress browser webviews while any context menu is open and let the tile placeholder remain visible underneath.
- Risk: browser extension page discovery could drift from the actual filesystem contents.
  - Mitigation: enumerate HTML entrypoints from `extensions/browser` through a Tauri command instead of hardcoding the list in the frontend.
- Risk: adding a new cached state field could break older state-construction paths.
  - Mitigation: default missing `browserExtensionPages` to `[]` in the menu builder and preserve the field in app-state reducers.

## Acceptance criteria

- Opening a context menu hides browser child webviews so the menu remains visible above the canvas.
- Browser tile context menus include `Load >` with the discovered extension pages from `extensions/browser`.
- Selecting a browser extension page loads it into the browser tile.
- Focused store, integration, frontend check, and Rust-side checks pass.

## Phased Plan

### Phase 0

#### Objective

Capture the new browser context-menu contract in failing tests.

#### Red

- Add a store test for the browser `Load` submenu and its selection effect.
- Add an integration test for browser context-menu submenu entries plus browser-webview suppression while the menu is open.
- Expected failure signal: missing submenu entries, missing load effect, or browser tiles not entering the suppressed state when the menu opens.

#### Green

- No implementation in this phase.
- Verification commands:
  - `npm run test:unit -- --run src/lib/stores/appState.test.ts -t "browser-tile Load submenu"`
  - `npm run test:integration -- tests/integration/test-driver.test.ts -t "shows browser Load submenu entries and suppresses browser webviews while the context menu is open"`

#### Exit criteria

- The targeted checks fail for the missing submenu or stacking behavior.

### Phase 1

#### Objective

Implement browser extension discovery, the browser `Load` submenu, and browser-webview suppression while context menus are open.

#### Red

- Re-run the targeted tests after the Phase 0 updates.
- Expected failure signal: missing Tauri command path, missing extension-page cache, or browser webviews still visually winning over the menu.

#### Green

- Add Tauri commands for browser extension discovery and browser file loads.
- Cache the discovered extension pages in app state and expose them through the browser tile context menu.
- Suppress browser webviews while context menus are open and restore them on dismissal.
- Verification commands:
  - `npm run test:unit -- --run src/lib/stores/appState.test.ts -t "browser-tile Load submenu"`
  - `npm run test:integration -- tests/integration/test-driver.test.ts -t "shows browser Load submenu entries and suppresses browser webviews while the context menu is open"`
  - `npm run check`
  - `cargo test --manifest-path src-tauri/Cargo.toml browser::tests::`

#### Exit criteria

- Browser tiles expose the new submenu, the menu remains visible above browser webviews, and the targeted checks pass.

## Execution Checklist

- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log

1. `find extensions/browser -maxdepth 3 \( -name index.html -o -name '*.html' \) | sort`
   - result: `pass`
   - notes: discovered the current browser extension entrypoints under `extensions/browser`
2. `npm run test:unit -- --run src/lib/stores/appState.test.ts -t "browser-tile Load submenu"`
   - result: `pass`
   - notes: focused store coverage passed for the new browser submenu after implementation
3. `npm run test:integration -- tests/integration/test-driver.test.ts -t "shows browser Load submenu entries and suppresses browser webviews while the context menu is open"`
   - result: `fail`
   - notes: first green attempt exposed an older app-state shape path where `browserExtensionPages` was missing
4. `npm run check`
   - result: `fail`
   - notes: the same missing `browserExtensionPages` field showed up in the frontend typecheck
5. `cargo test --manifest-path src-tauri/Cargo.toml browser::tests::`
   - result: `pass`
   - notes: Rust browser command/test coverage remained green after adding extension discovery and browser file-load commands
6. `npm run check`
   - result: `pass`
   - notes: the missing-state-field fix restored frontend type safety
7. `npm run test:integration -- tests/integration/test-driver.test.ts -t "shows browser Load submenu entries and suppresses browser webviews while the context menu is open"`
   - result: `pass`
   - notes: verified submenu contents, browser-webview suppression, and local browser extension loading through the context menu
