# Config Externalization PRD

## Status

Completed (2026-02-21)

## Context

The runtime currently mixes persisted settings with duplicated in-source hardcoded values across `config`, `tui`, `agent`, and `llm` modules. This causes drift, makes behavior harder to tune, and makes defaults less explicit.

## Goals

1. Move non-essential hardcoded runtime knobs into `AppConfig`.
2. Keep one source-default template in code for first-run settings generation.
3. Preserve fallback behavior: if a setting is missing from `settings.json`, use source defaults.
4. Remove duplicated hardcoded constants/normalization logic where possible.

## Non-goals

1. Reworking keybinding architecture.
2. Adding new external provider integrations beyond current behavior.
3. Redesigning persisted state format for herd registry.

## Phased Plan (Red/Green)

### Phase 1: Config schema expansion

Red:
1. Add/adjust tests to assert new fields fallback when omitted.
2. Verify current code has duplicated runtime defaults across modules.

Green:
1. Extend `AppConfig` with additional runtime knobs currently hardcoded in runtime logic.
2. Ensure `load_from_path` merges partial config with defaults.
3. Ensure `save_to_path` writes full template including new fields.

Exit criteria:
1. Missing settings file still auto-creates with complete defaults.
2. Missing fields in existing config still fall back correctly.

### Phase 2: Runtime refactor to config-driven behavior

Red:
1. Identify call sites still using duplicated constants or local hardcoded values.

Green:
1. Refactor `agent`, `cli`, `tui`, and `llm` to consume config-driven values.
2. Remove redundant hardcoded values where config now owns behavior.
3. Keep only necessary hard limits in source, centralized in config module.

Exit criteria:
1. Runtime behavior for command tracking/highlighting and classifier windows comes from config.
2. Provider normalization/default handling no longer duplicated in multiple modules.

### Phase 3: Validation and documentation

Red:
1. Run targeted checks before docs updates to capture breakages.

Green:
1. Run targeted test(s) in Docker integration environment.
2. Update README settings example with newly configurable fields.
3. Mark PRD status accurately based on completed checks.

Exit criteria:
1. Targeted tests pass for changed behavior.
2. Docs reflect the latest config surface.

## Acceptance Criteria

1. Source defaults remain authoritative for template generation and fallback merges.
2. New settings are persisted and read from `settings.json`.
3. Runtime modules consume config values instead of local duplicates where feasible.
4. Existing settings files without new fields still run with defaults.

## Risks and Mitigations

1. Risk: Schema expansion introduces incompatible assumptions in existing tests.
   Mitigation: update tests with explicit fallback and round-trip assertions.
2. Risk: Over-externalizing values could break core invariants.
   Mitigation: keep strict hard limits (for example herd slot upper bound) centralized in source.
3. Risk: Partial runtime refactor leaves mixed behavior.
   Mitigation: grep-based sweep for old constants and duplicate normalizers.

## Implementation Checklist

- [x] Phase 1 complete (config schema + fallback coverage)
- [x] Phase 2 complete (runtime refactor to config-driven values)
- [x] Phase 3 complete (validation + docs + status update)
