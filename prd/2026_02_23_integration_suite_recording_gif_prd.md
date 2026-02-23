# Integration Suite Recording GIF PRD

## Status

Completed (2026-02-23)

## Context

The README needed a real recording of the integration suite execution, not a slideshow of static screenshots.

## Goals

1. Generate a GIF from an actual terminal run of the integration suite command.
2. Embed that GIF in the main README.
3. Document regeneration commands.

## Non-goals

1. No changes to runtime/TUI behavior.
2. No dependency on external recording services.

## Phased Plan (Red/Green)

### Phase 1: Recorder implementation

Red:
1. No existing terminal-run recording pipeline to GIF.

Green:
1. Add `scripts/record-integration-tests-gif.py`:
   - Runs a command in a PTY
   - Captures output over time
   - Renders terminal-like frames with timestamps/status
   - Exports animated GIF

Refactor:
1. Keep command/canvas/timing configurable via CLI args.

Exit criteria:
1. Recorder can generate a non-empty GIF from integration tests.

### Phase 2: Docs integration

Red:
1. README currently references screenshot-based GIF only.

Green:
1. Update `README.md` to use `docs/screenshots/integration_suite.gif`.
2. Update screenshots/testing docs with regeneration commands.

Refactor:
1. Keep screenshot gallery structure intact.

Exit criteria:
1. README displays integration-suite recording GIF.

### Phase 3: Validation

Red:
1. Confirm recorder output and test command success.

Green:
1. Run recorder command on full integration tier and generate artifact.
2. Verify artifact has multiple frames.

Refactor:
1. Keep workflow scriptable and repeatable.

Exit criteria:
1. Recorder exits cleanly and generated GIF is committed.

## Exit Criteria Per Phase

1. Recorder exists and works on a real command.
2. README/docs reference the new integration GIF.
3. Full-suite recording GIF is generated.

## Acceptance Criteria

1. `docs/screenshots/integration_suite.gif` is produced from a real integration run.
2. `README.md` embeds that GIF.
3. Docs include a clear regeneration command.

## Risks and Mitigations

1. Risk: very large GIF output.
   Mitigation: configurable frame interval and viewport dimensions.
2. Risk: command output with ANSI control codes.
   Mitigation: PTY capture with control-code filtering for stable frame rendering.
3. Risk: static-looking output.
   Mitigation: per-frame elapsed status and full output timeline capture.

## Implementation Checklist

- [x] Add PTY-based integration recording GIF script
- [x] Generate `docs/screenshots/integration_suite.gif`
- [x] Update `README.md` to embed integration GIF
- [x] Update docs with regeneration command
- [x] Run recorder against full integration suite successfully
