# Browser Drive Screenshot Braille Output

Status: Completed
Date: 2026-03-24

## Context

`browser_drive("screenshot")` can now return an in-memory PNG payload, but that still requires the caller to consume image content. The requested extension is a text-only screenshot mode that converts the captured image to Braille in memory so agents can read it directly without writing any files.

## Goals

- Extend `browser_drive("screenshot")` with a Braille text output mode.
- Keep the existing PNG screenshot behavior as the default.
- Expose the new format consistently through the browser tile `message_api`, the socket/test-driver surface, and the root MCP tool.

## Non-goals

- Do not add a second screenshot action or a separate screenshot tool.
- Do not write screenshot files to disk.
- Do not add clipping, color output, or OCR in this change.

## Scope

- Screenshot argument parsing and payload branching inside the browser runtime.
- In-memory PNG-to-Braille conversion.
- Root MCP response handling for screenshot text vs image outputs.
- Focused browser-drive regression coverage and docs updates.

## Risks and mitigations

- Risk: the Braille output is too large or noisy to be useful.
  - Mitigation: support a bounded `columns` option and use a conservative default width.
- Risk: adding the new format changes the screenshot contract in one layer but not the others.
  - Mitigation: update the message API metadata, integration expectations, MCP surface, and docs in the same change.
- Risk: image conversion adds unnecessary file I/O or shelling out.
  - Mitigation: decode and rasterize the PNG bytes entirely in memory inside Rust.

## Acceptance criteria

- `browser_drive(tile_id, "screenshot")` still returns the current PNG payload by default.
- `browser_drive(tile_id, "screenshot", { "format": "braille" })` returns a text payload without writing files.
- The browser tile `message_api` documents the `format` and `columns` args for `screenshot`.
- Root MCP returns screenshot Braille as text content and PNG screenshots as image content.
- Focused browser-drive tests pass for both PNG and Braille screenshot outputs.

## Phased Plan

### Phase 0

Objective: add failing coverage for screenshot Braille output.

Red:
- Extend the structured browser `message_api` expectations to require `screenshot` args for `format` and `columns`.
- Extend the browser-drive integration test to request `format: "braille"` and verify a text payload with Braille characters.
- Expected failure signal: screenshot metadata still advertises no args or the runtime returns the old PNG payload for a Braille request.

Green:
- No implementation in this phase.

Exit criteria:
- The new Braille coverage fails against the current implementation.

### Phase 1

Objective: implement in-memory Braille screenshot output end to end.

Red:
- Run the new targeted tests and capture the failing signal.

Green:
- Parse screenshot format options.
- Convert screenshot PNG bytes to Braille text in memory.
- Return image or Braille payloads from the screenshot action based on `args.format`.
- Update the root MCP tool to emit text for Braille screenshot results.
- Update docs and role guidance for the new screenshot format.
- Verification commands:
  - targeted Rust tests
  - targeted JS build/tests
  - targeted integration tests
  - `git diff --check`

Exit criteria:
- Targeted tests pass and both screenshot formats are documented.

## Execution Checklist

- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log

1. `cargo test --manifest-path src-tauri/Cargo.toml exposes_structured_browser_message_api_with_drive_subcommands`
   - result: fail
   - notes: red phase; the structured browser `message_api` still advertised the old screenshot subcommand shape without Braille args.
2. `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "drives browser tiles through browser_drive"`
   - result: fail
   - notes: first green attempt; the Braille payload existed but aggressive trimming collapsed it to only a few characters.
3. `cargo test --manifest-path src-tauri/Cargo.toml braille_tests::`
   - result: pass
   - notes: verifies the in-memory Braille renderer on light and dark synthetic image blocks.
4. `cargo test --manifest-path src-tauri/Cargo.toml exposes_structured_browser_message_api_with_drive_subcommands`
   - result: pass
   - notes: green phase; browser `message_api` now advertises screenshot `format` and `columns` args.
5. `npm --prefix mcp-server run build`
   - result: pass
   - notes: verifies MCP screenshot image/text branching and tool typing.
6. `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "drives browser tiles through browser_drive"`
   - result: pass
   - notes: green phase; browser drive returned both the PNG screenshot payload and the Braille text payload.
7. `git diff --check -- src-tauri/Cargo.toml src-tauri/src/browser.rs src-tauri/src/network.rs src-tauri/src/socket/server.rs mcp-server/src/index.ts tests/integration/client.ts tests/integration/worker-root-mcp.test.ts docs/socket-and-test-driver.md .claude/skills/herd-root/SKILL.md prd/2026_03_24_browser_drive_screenshot_braille_prd.md`
   - result: pass
   - notes: final whitespace/conflict check for touched files.
