# Settings Types Refactor PRD

## Status

Completed (2026-02-23)

## Context

`src/tui.rs` still contains a large group of settings-specific type definitions (`EditableSettings`, `EditableHerdMode`, `SettingsField`, `SettingsOverlay`, `SettingsAction`) in addition to app model/runtime wiring. This keeps settings concerns coupled to top-level TUI composition.

## Goals

1. Move settings type definitions into a dedicated module.
2. Keep existing behavior, method signatures, and runtime semantics unchanged.
3. Reduce the cognitive surface area of `src/tui.rs`.

## Non-goals

1. No settings UX changes.
2. No config schema or persistence format changes.
3. No rule engine behavior changes.

## Phased Plan (Red/Green)

### Phase 1: Baseline and boundaries

Red:
1. Run targeted TUI tests to establish baseline behavior.
2. Identify all settings-type definitions and call sites.

Green:
1. Freeze extraction scope to settings-only type definitions and impls.

Refactor:
1. Keep visibility constrained to `pub(super)` where possible.

Exit criteria:
1. Baseline green and extraction map complete.

### Phase 2: Extract settings type module

Red:
1. Move one type group at a time and compile incrementally.
2. Verify parent/child module visibility and imports.

Green:
1. Add `src/tui/settings_types.rs`.
2. Move settings type definitions + impls from `src/tui.rs`.
3. Rewire `src/tui.rs` to import from `settings_types`.

Refactor:
1. Remove duplicate definitions from `src/tui.rs`.
2. Keep module API stable for existing siblings.

Exit criteria:
1. Settings type definitions are no longer declared in `src/tui.rs`.
2. Build succeeds without behavior changes.

### Phase 3: Validation and completion

Red:
1. Run targeted TUI tests.
2. Run broad regression gates.

Green:
1. Fix regressions and rerun until green.

Refactor:
1. Final import cleanup and formatting.

Exit criteria:
1. `cargo test --test tui_app` passes.
2. `cargo test --tests` passes.
3. `./scripts/run-integration-tests.sh --tier fast` passes.
4. `./scripts/run-integration-tests.sh --tier full` passes.

## Exit Criteria Per Phase

1. Phase 1: baseline + extraction boundaries confirmed.
2. Phase 2: settings types extracted and rewired.
3. Phase 3: all required gates green.

## Acceptance Criteria

1. Settings types and related impls live in `src/tui/settings_types.rs`.
2. `src/tui.rs` is materially slimmer and more focused.
3. Existing tests remain green.
4. PRD checklist and status reflect completion.

## Risks and Mitigations

1. Risk: module visibility breakages.
   Mitigation: use `pub(super)` exports and compile after each move.
2. Risk: subtle behavior change via constructor/default logic movement.
   Mitigation: copy code exactly and validate via existing settings/TUI tests.
3. Risk: cross-module import cycles.
   Mitigation: keep dependencies one-way (`settings_types` depending on `settings_io` helpers only).

## Implementation Checklist

- [x] Phase 1 baseline TUI tests run and extraction boundaries confirmed
- [x] Phase 2 `settings_types` module added
- [x] Phase 2 `src/tui.rs` rewired to use extracted types
- [x] Phase 3 `cargo test --test tui_app` green
- [x] Phase 3 `cargo test --tests` green
- [x] Phase 3 `./scripts/run-integration-tests.sh --tier fast` green
- [x] Phase 3 `./scripts/run-integration-tests.sh --tier full` green
- [x] PRD status updated to Completed with date
