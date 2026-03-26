## Title

Browser Drive Text Screenshot Format

## Status

Completed

## Date

2026-03-24

## Context

`browser_drive(..., "screenshot")` currently supports `image`, `braille`, `ascii`, and `ansi`. Those paths all derive from a rendered bitmap. They are useful for visual approximation, but they do not preserve DOM text layout well enough for agents that need to read browser-based game screens or UI-heavy pages. We need a first-class `format: "text"` output that preserves as much positional information as possible while staying in-memory and returning plain text.

## Goals

1. Add `format: "text"` to browser screenshot output.
2. Preserve on-screen text positions better than HTML-to-prose conversion.
3. Keep the result fully in-memory and returnable through existing socket/MCP surfaces.
4. Advertise the new format everywhere browser screenshot capabilities are exposed.

## Non-goals

1. Full OCR of bitmap-only content.
2. A second parallel browser action just for text snapshots.
3. Long-term compatibility fallbacks for old screenshot format schemas.

## Scope

1. Browser backend screenshot contract and renderer.
2. Browser tile message API advertisement.
3. Root MCP browser tool handling.
4. Targeted integration/unit coverage.
5. Docs and root skill updates.

## Risks and mitigations

1. DOM text extraction may collapse layout.
   - Mitigation: render extracted text into a character grid using viewport-relative bounding boxes instead of joining node text.
2. Pages with canvas/WebGL may produce little or no DOM text.
   - Mitigation: keep existing image-derived formats unchanged; `text` is an additional option, not a replacement.
3. Overlapping DOM fragments may make grid output noisy.
   - Mitigation: prefer line-preserving sources (`innerText`, form values, accessibility labels) and stable overwrite rules.

## Acceptance criteria

1. `browser_drive screenshot` accepts `format: "text"` with `columns`.
2. Browser `message_api` advertises `text` alongside the existing screenshot formats.
3. Root MCP accepts and returns the `text` screenshot result as plain text content plus structured content.
4. Integration coverage proves `format: "text"` returns positional multi-line text from a browser tile.
5. Documentation and root skill guidance mention the new format.

## Phased Plan (Red/Green)

### Phase 0

1. Objective
   - Define the contract and failing checks for `format: "text"`.
2. Red
   - Add targeted test expectations for the browser screenshot format enum and the integration path.
   - Expected failure signal: unsupported format validation or missing advertised schema entries.
3. Green
   - Update the contract surfaces to include `text`.
   - Verification commands: targeted Rust and integration tests.
4. Exit criteria
   - All exposed schemas and tests recognize `text` as a valid screenshot format.

### Phase 1

1. Objective
   - Implement a layout-preserving DOM text renderer for browser screenshots.
2. Red
   - Add failing tests for the DOM-layout text renderer behavior.
   - Expected failure signal: missing/incorrect text payload or collapsed layout.
3. Green
   - Evaluate a browser-side script that extracts visible text fragments with bounding boxes and render them into a terminal grid.
   - Verification commands: targeted Rust and integration tests.
4. Exit criteria
   - `format: "text"` returns multi-line text with stable column count and useful on-screen positioning.

### Phase 2

1. Objective
   - Document and verify the end-to-end surface.
2. Red
   - Add or tighten doc/skill/integration assertions that mention all supported screenshot formats.
   - Expected failure signal: docs/tests still list the old set.
3. Green
   - Update docs, skill guidance, and PRD status.
   - Verification commands: focused tests and diff checks.
4. Exit criteria
   - Docs, tests, and PRD all match the implemented interface.

## Execution Checklist

- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Phase 2 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log

1. `sed -n '1,220p' /Users/skryl/.codex/skills/phased-prd-red-green/SKILL.md`
   - result: pass
   - notes: confirmed PRD and red/green workflow requirements
2. `sed -n '1,240p' /Users/skryl/.codex/skills/phased-prd-red-green/references/prd_red_green_template.md`
   - result: pass
   - notes: loaded template sections/checklist
3. `rg -n "format: \\\"braille\\\"|screenshot|ascii|ansi|browser_drive|text" ...`
   - result: pass
   - notes: located current screenshot format contracts and tests
4. `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "drives browser tiles through browser_drive"`
   - result: fail
   - notes: red signal was `browser_drive screenshot requires \`format\` to be one of \`image\`, \`braille\`, \`ascii\`, or \`ansi\`, got \`text\``
5. `cargo test --manifest-path src-tauri/Cargo.toml browser::braille_tests::`
   - result: pass
   - notes: renderer/unit coverage passed with the new `text` format tests
6. `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "drives browser tiles through browser_drive"`
   - result: pass
   - notes: end-to-end browser screenshot coverage passed with `format: "text"`
7. `cargo test --manifest-path src-tauri/Cargo.toml exposes_structured_browser_message_api_with_drive_subcommands`
   - result: pass
   - notes: verified browser tile message_api advertises the expanded screenshot format set
8. `npm --prefix mcp-server run build`
   - result: pass
   - notes: MCP server TypeScript build accepted the new screenshot text payload
9. `git diff --check -- src-tauri/src/browser.rs src-tauri/src/network.rs mcp-server/src/index.ts tests/integration/worker-root-mcp.test.ts docs/socket-and-test-driver.md .claude/skills/herd-root/SKILL.md tests/fixtures/browser-text-layout.html prd/2026_03_24_browser_drive_text_screenshot_prd.md`
   - result: pass
   - notes: no whitespace or patch-format issues in the changed files
