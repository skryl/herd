# Herd UX Recording GIF PRD

## Status

Completed (2026-02-23)

## Context

The previous GIF pipeline recorded the integration test runner terminal output. The required deliverable is a GIF showing the actual `herd` TUI UX while replaying integration-test-style interactions.

## Goals

1. Record a real `herd` TUI session inside tmux and export it as an animated GIF.
2. Make the main README use this UX recording.
3. Update docs with the correct regeneration command.
4. Remove deprecated runner-recording references.

## Non-goals

1. No changes to production runtime behavior of `herd`.
2. No external screen recording dependencies.

## Phased Plan (Red/Green)

### Phase 1: UX recorder implementation

Red:
1. Existing recorder targets integration test runner stdout, not live TUI UX.

Green:
1. Implement `scripts/record-herd-ux-gif.py` to:
   - Seed tmux sessions that mirror integration scenarios.
   - Launch `herd tui` against that tmux socket.
   - Replay key interactions used in integration happy paths.
   - Capture ANSI-styled tmux pane content and render color frames to GIF.

Refactor:
1. Keep script flags configurable (output path, frame timing, font size).

Exit criteria:
1. Script generates a multi-frame GIF showing real TUI panes and interactions.

### Phase 2: Docs and README integration

Red:
1. README/docs still reference `integration_suite.gif` and runner recorder script.

Green:
1. Update `README.md` hero GIF to `docs/screenshots/herd_ux_integration.gif`.
2. Update `docs/screenshots/README.md` and `docs/testing.md` commands/descriptions.

Refactor:
1. Keep docs concise and aligned with existing screenshot workflow.

Exit criteria:
1. No user-facing docs point to runner-output GIF generation.

### Phase 3: Validation and cleanup

Red:
1. Old runner recorder assets/references risk confusion.

Green:
1. Generate `docs/screenshots/herd_ux_integration.gif` using the new script.
2. Remove deprecated recorder script and legacy runner GIF artifact.
3. Verify references with text search.

Refactor:
1. Keep only one canonical recording workflow.

Exit criteria:
1. Repository has a single, clear UX-recording GIF path and artifact.

## Exit Criteria Per Phase

1. Live UX recorder script works end-to-end.
2. README/docs point to UX GIF.
3. Deprecated runner recording artifacts are removed.

## Acceptance Criteria

1. `docs/screenshots/herd_ux_integration.gif` is generated from live `herd` UX interaction.
2. `README.md` embeds that GIF.
3. `docs/testing.md` documents the UX recording command.
4. Runner-output recording references are removed from user-facing docs.

## Risks and Mitigations

1. Risk: ANSI parsing misses styling details.
   Mitigation: capture with `tmux capture-pane -eN` and render per-cell styles.
2. Risk: tmux timing flakiness while replaying actions.
   Mitigation: staged waits and readiness checks before frame capture.
3. Risk: duplicate workflows cause drift.
   Mitigation: remove deprecated runner recorder artifacts.

## Implementation Checklist

- [x] Add/validate live UX recorder script
- [x] Generate `docs/screenshots/herd_ux_integration.gif`
- [x] Update `README.md` hero GIF reference
- [x] Update docs regeneration instructions
- [x] Remove deprecated runner recorder script/artifact
- [x] Verify final references and run regression checks
