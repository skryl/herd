# Docs Screenshot Automation PRD

## Status

Completed (2026-02-23)

## Context

The project needed richer end-user documentation with visual TUI examples and an automated way to capture/update screenshots during test workflows.

## Goals

1. Add a dedicated docs screenshots section.
2. Generate screenshots from deterministic TUI test states.
3. Allow screenshot generation as part of integration test runs.
4. Keep default test behavior unchanged unless explicitly enabled.

## Non-goals

1. No runtime UI behavior changes.
2. No dependency on interactive manual screenshot capture.

## Phased Plan (Red/Green)

### Phase 1: Docs structure and index

Red:
1. Identify missing docs location for screenshot gallery.

Green:
1. Add `docs/screenshots/README.md`.
2. Add links from top-level docs indexes.

Refactor:
1. Keep docs navigation concise and consistent.

Exit criteria:
1. Screenshots section discoverable from `README.md` and `docs/README.md`.

### Phase 2: Screenshot generation tests + renderer

Red:
1. Add failing/absent capture path for deterministic TUI visuals.

Green:
1. Add ignored integration test `tests/docs_screenshots.rs` that writes raw text snapshots.
2. Add `scripts/render-doc-screenshots.py` to convert raw snapshots to PNG.
3. Add `scripts/capture-doc-screenshots.sh` wrapper.

Refactor:
1. Keep generation deterministic and file-path configurable via env vars.

Exit criteria:
1. Screenshot script produces PNG files under `docs/screenshots/`.

### Phase 3: Test-runner integration

Red:
1. Existing integration script cannot trigger screenshot capture.

Green:
1. Extend `scripts/run-integration-tests.sh` with optional
   `HERD_CAPTURE_DOC_SCREENSHOTS=1` behavior.

Refactor:
1. Preserve default behavior when env flag is unset.

Exit criteria:
1. Fast/full tiers can optionally generate docs screenshots.

## Exit Criteria Per Phase

1. Phase 1 docs index linked.
2. Phase 2 screenshot artifacts generated from tests.
3. Phase 3 optional integration flow works and tests remain green.

## Acceptance Criteria

1. Docs include screenshot gallery page with rendered PNGs.
2. Screenshot generation can run standalone and from integration tests.
3. Regression tests pass after documentation tooling changes.

## Risks and Mitigations

1. Risk: host font differences.
   Mitigation: fallback font list with default image font fallback.
2. Risk: test pollution from generated files.
   Mitigation: screenshot test is ignored by default; runs only when requested.
3. Risk: test-runner compatibility across bash versions.
   Mitigation: use portable `case` matching instead of bash-specific lowercase expansion.

## Implementation Checklist

- [x] Add docs screenshot gallery page and links
- [x] Add deterministic screenshot integration test (`ignored`)
- [x] Add screenshot render and capture scripts
- [x] Integrate optional capture into integration test runner
- [x] Generate screenshots under `docs/screenshots/`
- [x] Run `cargo test --tests` green
- [x] Run `HERD_CAPTURE_DOC_SCREENSHOTS=1 ./scripts/run-integration-tests.sh --tier fast` green
