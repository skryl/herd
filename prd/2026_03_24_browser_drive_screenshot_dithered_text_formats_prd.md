# Browser Drive Screenshot Dithered Text Formats

Status: Completed
Date: 2026-03-24

## Context

`browser_drive("screenshot")` currently supports PNG image output and a binary-thresholded Braille text mode. The next change is to improve text-only screenshot fidelity by dithering the Braille renderer and adding two more text renderers: plain ASCII grayscale and ANSI-colored text output.

## Goals

- Replace threshold-only Braille rendering with a dithered Braille renderer.
- Extend `browser_drive("screenshot")` with `ascii` and `ansi` text formats.
- Keep `image` as the default screenshot format.
- Advertise the expanded screenshot format surface consistently through browser tile metadata, socket/test-driver docs, MCP handling, and root skill guidance.

## Non-goals

- Do not add a second screenshot command or a separate renderer tool.
- Do not write screenshots to disk.
- Do not add OCR, clipping, or layout-aware semantic extraction.

## Scope

- `src-tauri/src/browser.rs`
- `src-tauri/src/network.rs`
- `mcp-server/src/index.ts`
- `tests/integration/worker-root-mcp.test.ts`
- `docs/socket-and-test-driver.md`
- `.claude/skills/herd-root/SKILL.md`
- PRD status and command log

## Risks and mitigations

- Risk: ANSI output is high-fidelity but unreadable if the consumer strips escape codes.
  - Mitigation: keep ASCII and Braille as plain-text alternatives and leave `image` as the default.
- Risk: new text formats are added in the runtime but not advertised through metadata or MCP.
  - Mitigation: update browser `message_api`, docs, and MCP screenshot payload handling in the same change.
- Risk: dithering makes Braille screenshots too noisy on simple pages.
  - Mitigation: use a stable ordered dither and keep the existing width bounds.

## Acceptance criteria

- `browser_drive(tile_id, "screenshot", { "format": "braille" })` returns dithered Braille text.
- `browser_drive(tile_id, "screenshot", { "format": "ascii" })` returns grayscale ASCII text.
- `browser_drive(tile_id, "screenshot", { "format": "ansi" })` returns ANSI-colored text.
- Browser `message_api` and root MCP describe `image`, `braille`, `ascii`, and `ansi` as valid screenshot formats.
- Root MCP returns text content for all text screenshot formats and image content for PNG screenshots.
- Focused renderer and browser-drive regressions pass.

## Phased Plan

### Phase 0

Objective: add failing coverage for the expanded screenshot text-format surface.

Red:
- Extend the browser screenshot metadata expectation to require the new `format` enum values.
- Extend the browser-drive integration test to request `ascii` and `ansi` screenshots and validate their payloads.
- Add renderer-focused Rust tests that require dithered Braille and ASCII output on grayscale inputs.
- Expected failure signal:
  - screenshot metadata still advertises only `image` and `braille`
  - runtime rejects `ascii` or `ansi`
  - renderer tests fail because Braille is still threshold-only or ASCII output is missing

Green:
- No implementation changes in this phase.

Exit criteria:
- Targeted tests fail on the current implementation.

### Phase 1

Objective: implement dithered text screenshot renderers end to end.

Red:
- Run the new targeted tests and capture the failing signal.

Green:
- Parse `ascii` and `ansi` screenshot formats.
- Replace threshold-only Braille rasterization with dithered Braille.
- Add ASCII grayscale and ANSI color text renderers.
- Return a shared structured text screenshot payload for Braille, ASCII, and ANSI.
- Update root MCP screenshot handling to accept every text screenshot format.

Exit criteria:
- Targeted Rust and integration checks pass.

### Phase 2

Objective: update the surfaced interface and record verification.

Red:
- N/A

Green:
- Update browser `message_api`, docs, and root skill guidance to advertise all screenshot formats.
- Run focused regression checks plus `git diff --check`.

Exit criteria:
- Metadata and docs match the implemented screenshot formats and the final checks are green.

## Execution Checklist

- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Phase 2 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log

1. `cargo test --manifest-path src-tauri/Cargo.toml braille_tests::`
   - result: fail
   - notes: red phase; compile failed because `ascii_text_from_gray_image` and `ansi_text_from_rgb_image` did not exist yet
2. `cargo test --manifest-path src-tauri/Cargo.toml exposes_structured_browser_message_api_with_drive_subcommands`
   - result: fail
   - notes: red phase; the new renderer tests prevented the browser metadata check from compiling cleanly
3. `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "drives browser tiles through browser_drive"`
   - result: fail
   - notes: red phase; `browser_drive screenshot` rejected `format: "ascii"` because only `image` and `braille` were supported
4. `cargo test --manifest-path src-tauri/Cargo.toml braille_tests::`
   - result: pass
   - notes: green phase; dithered Braille plus ASCII and ANSI text renderers all passed focused unit coverage
5. `cargo test --manifest-path src-tauri/Cargo.toml exposes_structured_browser_message_api_with_drive_subcommands`
   - result: pass
   - notes: green phase; browser `message_api` now advertises `image`, `braille`, `ascii`, and `ansi`
6. `npm --prefix mcp-server run build`
   - result: pass
   - notes: MCP screenshot payload typing and tool handling compile cleanly with the new text formats
7. `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "drives browser tiles through browser_drive"`
   - result: pass
   - notes: green phase; browser drive returned PNG, dithered Braille, ASCII, and ANSI screenshot payloads
8. `git diff --check -- src-tauri/src/browser.rs src-tauri/src/network.rs mcp-server/src/index.ts tests/integration/worker-root-mcp.test.ts docs/socket-and-test-driver.md .claude/skills/herd-root/SKILL.md prd/2026_03_24_browser_drive_screenshot_dithered_text_formats_prd.md`
   - result: pass
   - notes: final whitespace/conflict check for touched files
