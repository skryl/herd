# JSNES Browser Extension PRD

## Header

1. Title: JSNES browser extension
2. Status: Completed
3. Date: 2026-03-25

## Context

The repo already supports browser-hosted extensions loaded from `extensions/browser/*/index.html`, including single-user emulator flows such as the Game Boy extension and shared browser extension APIs such as Texas Hold'em. We need a new NES-focused extension powered by `jsnes` that fits the same browser extension discovery/loading path and exposes multiplayer control through the existing `extension_call` API.

## Goals

1. Add a new browser extension under `extensions/browser/jsnes`.
2. Vendor a browser-ready `jsnes` build directly inside the extension folder.
3. Support loading `.nes` ROMs from the page UI and through the extension API.
4. Expose a shared extension API for caller-owned player 1 / player 2 control.
5. Keep the control/ownership logic unit-testable outside the browser page shell.

## Non-goals

1. Shipping copyrighted bundled NES games.
2. Adding a second multiplayer transport or room runtime for this extension.
3. Building online netplay or frame sync across multiple browser tiles.
4. Adding compatibility fallbacks for non-extension loading paths.

## Scope

The extension will expose one shared emulator surface in a browser tile. Callers will claim either player 1 or player 2 through `extension_call`, then control that player with button press/release methods. The extension will also expose ROM loading through base64 data for automation and a local file picker for manual usage.

## Risks and mitigations

1. `jsnes` browser integration may have browser-specific initialization issues.
   - Mitigation: vendor the upstream browser bundle, keep DOM wiring thin, and verify with a page-level browser test.
2. Caller-specific multiplayer control could become ambiguous if one caller can own both players.
   - Mitigation: enforce at most one claimed player per caller tile.
3. ROM loading through the API could fail silently with malformed input.
   - Mitigation: decode and validate base64 inputs in the controller and cover the error path in unit tests.
4. Audio/browser helpers inside `jsnes` may be noisy in headless/test contexts.
   - Mitigation: keep tests focused on manifest, state, ownership, and ROM loading rather than audio playback.

## Acceptance criteria

1. `extensions/browser/jsnes/index.html` loads successfully and exposes `globalThis.HerdBrowserExtension`.
2. The manifest advertises multiplayer-safe extension methods for claiming players, loading ROM data, resetting, pausing, and button control.
3. A caller tile can claim player 1, another caller tile can claim player 2, and both can drive independent button state through `extension_call`.
4. The extension can load a valid `.nes` ROM through the JS API using base64 ROM data.
5. Targeted unit, browser, and integration tests pass.

## Phased plan (Red/Green)

### Phase 0

1. Objective
   - Lock scope and add failing tests that describe the new extension contract.
2. Red
   - Add a unit test for controller ownership/control behavior.
   - Add a browser-page smoke test for the extension shell.
   - Add an integration test covering extension metadata, ROM load, and two-player control through `extension_call`.
   - Expected failure signal: missing `extensions/browser/jsnes/*` assets, missing manifest, and unsupported extension methods.
3. Green
   - Create the `jsnes` extension folder, vendored assets, controller logic, and page shell needed to satisfy the tests.
   - Verification commands:
     - `npm run test:unit -- --run extensions/browser/jsnes/jsnes.test.ts`
     - `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "exposes jsnes extension metadata and multiplayer controls"`
4. Exit criteria
   - The new extension tests pass with no placeholder logic left behind.

### Phase 1

1. Objective
   - Wire the controller logic to a browser UI and upstream `jsnes` runtime without introducing a second extension path.
2. Red
   - Expand assertions to verify page readiness, UI status text, and method discovery on the loaded extension page.
   - Expected failure signal: page loads but does not expose ready emulator state or accurate extension metadata.
3. Green
   - Finalize the browser page shell, render status/claims/buttons, and connect UI actions to the same controller used by the extension API.
   - Verification commands:
     - `npm run test:unit -- --run extensions/browser/jsnes/jsnes.test.ts`
4. Exit criteria
   - Page-level smoke coverage passes and the UI reflects the same state returned by the extension API.

### Phase 2

1. Objective
   - Verify the extension integrates cleanly with existing browser-extension discovery and MCP-facing metadata.
2. Red
   - Re-run the integration path that inspects extension metadata and method subcommands from the tile API.
   - Expected failure signal: missing extension metadata, incorrect subcommands, or broken caller-specific multiplayer behavior.
3. Green
   - Adjust manifest/state serialization until the tile metadata and extension-call behavior align with existing browser extension plumbing.
   - Verification commands:
     - `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "exposes jsnes extension metadata and multiplayer controls"`
     - `npm run check`
4. Exit criteria
   - The new extension is discoverable through existing browser extension metadata and passes targeted regression checks.

## Execution checklist

- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Phase 2 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command log

1. `npm view jsnes version dist.tarball repository.url license`
   - result: pass
   - notes: confirmed upstream package version `2.0.0` and Apache-2.0 license.
2. `npm pack jsnes --silent`
   - result: pass
   - notes: downloaded `jsnes-2.0.0.tgz` for vendoring inspection.
3. `npm run test:unit -- --run extensions/browser/jsnes/jsnes.test.ts`
   - result: fail
   - notes: initial red signal was `Cannot find module './logic.js'`.
4. `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "exposes jsnes extension metadata and multiplayer controls"`
   - result: fail
   - notes: initial red signal was missing `extensions/browser/jsnes/index.html`.
5. `npm run test:unit -- --run extensions/browser/jsnes/jsnes.test.ts`
   - result: pass
   - notes: controller ownership, base64 ROM loading, and browser-page shell checks passed.
6. `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "exposes jsnes extension metadata and multiplayer controls"`
   - result: pass
   - notes: extension metadata, base64 ROM loading, and two-caller player control passed through `extension_call`.
7. `npm run check`
   - result: pass
   - notes: `svelte-check` and `tsc` completed with no errors or warnings.
8. `git diff --check -- extensions/browser/jsnes/jsnes.test.ts extensions/browser/jsnes/index.html extensions/browser/jsnes/logic.js extensions/browser/jsnes/app.js extensions/browser/jsnes/styles.css extensions/browser/jsnes/jsnes.min.js extensions/browser/jsnes/LICENSE.jsnes tests/integration/worker-root-mcp.test.ts prd/2026_03_25_jsnes_browser_extension_prd.md`
   - result: pass
   - notes: no whitespace or patch formatting issues in the changed files.
