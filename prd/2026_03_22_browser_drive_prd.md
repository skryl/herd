## Title

Browser Drive For Child Webviews

## Status

Completed

## Date

2026-03-22

## Context

Herd already supports browser tiles as real child webviews, plus limited browser controls:

1. Root can create, destroy, navigate, and load browser tiles.
2. Workers can reach visible local-network browser tiles through the worker-safe tile surface.
3. Test hooks only target the main Herd UI webview, not child browser tiles.

That means browser tiles are viewable and navigable, but neither Root nor workers have a supported way to drive the page content inside a child browser tile.

The agreed target behavior for this slice is:

1. Add one browser-specific command surface named `browser_drive`.
2. `browser_drive` targets a browser tile by `pane_id`.
3. `browser_drive` supports actions:
   - `click`
   - `type`
   - `dom_query`
   - `eval`
4. Root may drive any browser tile in the current session.
5. Workers may drive only visible local-network browser tiles.
6. This must use the browser child webview directly, not the main test-driver hooks.

## Goals

1. Add a supported child-webview automation surface for browser tiles.
2. Keep worker access scoped to the sender's current local network.
3. Preserve the existing root/worker permission boundary.
4. Return structured results for query/eval actions.
5. Keep the command simple: one `browser_drive` entry point with action-specific args.

## Non-goals

1. General DOM automation for non-browser tiles.
2. Replacing existing `browser_navigate` or `browser_load`.
3. Adding a generic cross-webview test-driver facility.
4. Rich locator syntax beyond the needed v1 selector-based path.

## Scope

In scope:

1. New socket command `browser_drive`.
2. New child-webview result-bearing execution path.
3. CLI support for `herd browser drive <pane_id> <action> [json_args]`.
4. MCP support for `browser_drive`.
5. Worker-safe permission checks for local-network browser access.
6. Integration coverage using a local HTML fixture.

Out of scope:

1. Image/screenshot extraction.
2. Browser tab management.
3. Browser history actions through `browser_drive` itself.
4. Arbitrary raw HTML injection as a new browser-create mode.

## Risks And Mitigations

1. Child webviews may not return JS results the same way as the main app webview.
   - Mitigation: execute directly against the child browser webview and verify it against a local fixture.
2. A generic eval surface can become overly permissive.
   - Mitigation: keep the command browser-only, session-scoped, and network-scoped for workers.
3. Selector-driven actions can be flaky against arbitrary pages.
   - Mitigation: keep v1 semantics explicit and document that failures bubble back as browser-drive errors.

## Acceptance Criteria

1. Socket exposes `browser_drive`.
2. CLI exposes `herd browser drive <pane_id> <action> [json_args]`.
3. MCP exposes `browser_drive` to Root and workers.
4. Supported actions are:
   - `click`
   - `type`
   - `dom_query`
   - `eval`
5. `click` supports selector-based interaction.
6. `type` supports selector plus text input.
7. `dom_query` returns serialized data from the child browser page.
8. `eval` executes arbitrary JS in the child browser page and returns serialized data when possible.
9. Workers can use `browser_drive` only on visible local-network browser tiles.
10. Root can use `browser_drive` on any browser tile in the current session.
11. Existing `browser_navigate` and `browser_load` behavior remains unchanged.

## Phased Plan

### Phase 0: PRD And Red Surface Checks

#### Objective

Create the PRD and add failing checks for the missing `browser_drive` surface.

#### Red

1. Add failing checks for:
   - missing socket command
   - missing CLI path
   - missing MCP tool
   - missing child-webview result path

Expected failure signal:

1. browser tiles cannot be driven through a supported command surface

#### Green

1. Create this PRD.
2. Land failing coverage for later phases.

Verification commands:

1. `npx vitest run --config mcp-server/vitest.config.ts`
2. `cargo test --manifest-path src-tauri/Cargo.toml cli::tests`

#### Exit Criteria

1. The PRD exists in `prd/`.
2. The red checks fail for the expected reasons.

### Phase 1: Backend Child-Webview Drive Path

#### Objective

Add child-webview request/response plumbing and the `browser_drive` socket command.

#### Red

1. Add failing Rust tests and targeted integration checks for:
   - unsupported `browser_drive`
   - missing result round-trip from child webview
   - worker/root permission handling

Expected failure signal:

1. browser drive is unsupported
2. child browser webviews cannot return structured results

#### Green

1. Add backend browser-drive execution helpers that run directly against the child browser webview.
2. Add socket command `browser_drive`.
3. Enforce:
   - Root: current-session browser tiles
   - Worker: visible local-network browser tiles only

Verification commands:

1. `cargo test --manifest-path src-tauri/Cargo.toml`
2. `cargo check --manifest-path src-tauri/Cargo.toml`

#### Exit Criteria

1. Child browser webviews can execute result-bearing actions reliably.
2. Socket permission behavior matches the role model.

### Phase 2: CLI, MCP, Docs, And Integration

#### Objective

Expose `browser_drive` everywhere users and agents need it and lock the behavior with tests.

#### Red

1. Add failing tests for:
   - CLI serialization
   - MCP tool parity
   - end-to-end browser fixture driving for click/type/dom_query/eval

Expected failure signal:

1. surface mismatch across socket, CLI, and MCP
2. browser drive exists but is not usable end to end

#### Green

1. Add CLI support for `browser drive`.
2. Add MCP support for `browser_drive`.
3. Update docs and skill text.
4. Add targeted integration coverage with a local fixture page.
5. Mark this PRD `Completed` once verification is green.

Verification commands:

1. `npx vitest run --config mcp-server/vitest.config.ts`
2. `cargo test --manifest-path src-tauri/Cargo.toml cli::tests`
3. `npx vitest run --config vitest.integration.config.ts tests/integration/worker-root-mcp.test.ts -t "drives browser tiles through browser_drive" --reporter=verbose`
4. `npm run check`

#### Exit Criteria

1. `browser_drive` is available and consistent across socket, CLI, and MCP.
2. End-to-end browser driving works through a child browser tile.

## Implementation Checklist

- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Phase 2 complete
- [x] Targeted verification complete
- [x] Docs/status updated
