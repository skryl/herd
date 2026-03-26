# Browser Drive Screenshot Action

Status: Completed
Date: 2026-03-24

## Context

`browser_drive` can currently click, type, query, and evaluate JavaScript in browser tiles, but it cannot capture the current browser view. The requested change is to add a screenshot action without adding a parallel browser-control API.

## Goals

- Add a `screenshot` action to `browser_drive`.
- Return a PNG payload from the backend browser runtime and surface it through the root MCP tool in a way agents can use directly.
- Document the new action alongside the existing browser drive commands.

## Non-goals

- Do not add a separate screenshot-only tool.
- Do not add format negotiation, clipping, or full-page stitching in this change.
- Do not add a fallback compatibility path outside the existing macOS browser runtime support.

## Scope

- Browser drive action allowlists and structured message API metadata.
- Browser webview screenshot capture on macOS.
- Root MCP response handling for screenshot results.
- Focused regression coverage and docs updates.

## Risks and mitigations

- Risk: the screenshot payload is only exposed as raw JSON text, which makes it awkward for agents to inspect.
  - Mitigation: have the root MCP `browser_drive` tool emit MCP image content for screenshot responses.
- Risk: snapshotting from `WKWebView` introduces fragile native conversion code.
  - Mitigation: use WebKit’s built-in snapshot API and convert directly to PNG bytes through AppKit.
- Risk: the new action appears in one browser-drive surface but not the others.
  - Mitigation: update the socket validator, structured `message_api`, MCP schema, docs, and integration coverage together.

## Acceptance criteria

- `browser_drive` accepts `screenshot` anywhere browser drive actions are enumerated.
- The backend returns a non-empty PNG screenshot payload for a browser tile on macOS.
- The root MCP `browser_drive` tool can return screenshot content as an MCP image block.
- Browser drive docs mention the new action and its return shape.
- Existing browser drive actions continue to work.

## Phased Plan

### Phase 0

Objective: add failing coverage for the new screenshot action.

Red:
- Extend the structured browser `message_api` tests to require `screenshot` in the drive action enum and subcommand list.
- Extend the browser-drive integration test to request a screenshot and verify it is a PNG payload.
- Expected failure signal: `screenshot` is rejected as an unsupported action or missing from the advertised browser drive metadata.

Green:
- No implementation in this phase.

Exit criteria:
- The new coverage fails against the current implementation.

### Phase 1

Objective: implement screenshot capture end to end.

Red:
- Run the new targeted tests and capture the failing signal.

Green:
- Add `screenshot` to the browser drive allowlists and MCP schema.
- Capture browser screenshots through the existing macOS webview path and return a PNG payload.
- Emit screenshot results as MCP image content from the root tool.
- Update docs and any role guidance that enumerates browser drive actions.
- Verification commands:
  - targeted Rust tests
  - targeted JS build/tests
  - targeted integration tests
  - `git diff --check`

Exit criteria:
- Targeted tests pass and the screenshot action is documented.

## Execution Checklist

- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log

1. `cargo test --manifest-path src-tauri/Cargo.toml exposes_structured_browser_message_api_with_drive_subcommands`
   - result: fail
   - notes: red phase; browser `message_api` still advertised only `click`, `type`, `dom_query`, and `eval`.
2. `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "drives browser tiles through browser_drive"`
   - result: pass
   - notes: green phase; browser drive returned a PNG screenshot payload and the existing browser drive flow still passed.
3. `npm --prefix mcp-server run build`
   - result: pass
   - notes: verifies the root MCP tool schema and screenshot image result typing.
4. `cargo test --manifest-path src-tauri/Cargo.toml exposes_structured_browser_message_api_with_drive_subcommands`
   - result: pass
   - notes: green phase; structured browser `message_api` now advertises `screenshot`.
5. `git diff --check -- src-tauri/Cargo.toml src-tauri/src/browser.rs src-tauri/src/network.rs src-tauri/src/socket/server.rs mcp-server/src/index.ts tests/integration/client.ts tests/integration/worker-root-mcp.test.ts docs/socket-and-test-driver.md .claude/skills/herd-root/SKILL.md prd/2026_03_24_browser_drive_screenshot_prd.md`
   - result: pass
   - notes: final whitespace/conflict check for touched files.
