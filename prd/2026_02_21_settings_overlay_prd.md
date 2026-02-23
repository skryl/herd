# Settings Overlay + Unified Config Persistence PRD

## Status

Completed (2026-02-21)

## Date

2026-02-21

## Context

The current app persists configuration and runtime state in different default locations (`config.toml` under config home and `state.json` under state home), and the TUI has no user-editable settings surface. We need to unify user settings and persistence under `~/.config/herd`, create `~/.config/herd/settings.json` on first boot when missing, and provide an in-TUI settings overlay opened by `,` for editing key settings.

## Goals

1. Store user configuration in `~/.config/herd/settings.json`.
2. Ensure `settings.json` is created on first boot when missing.
3. Store herd persistence data under `~/.config/herd` as well.
4. Add `,` keybinding to open a settings overlay in the TUI.
5. Make settings editable in the TUI:
   - number of herds (default: `10`)
   - OpenAI API key
   - Anthropic API key
   - LLM provider/model selection
6. Populate model choices by fetching model lists using whichever provider key is available for the selected provider.
7. Add editable herd modes in settings, with markdown prompt files persisted under `~/.config/herd`.

## Non-goals

1. Redesigning the full TUI layout.
2. Introducing async runtime infrastructure.
3. Adding encrypted secret storage in this change.
4. Reworking herd-rule behavior unrelated to settings.
5. Wiring herd-mode prompts into a separate runtime LLM orchestration layer (future integration point).

## Phased Plan (Red/Green)

### Phase 1: Settings persistence path unification

Red:

1. Add failing tests for default settings/state paths under `~/.config/herd`.
2. Add failing tests proving missing settings file is created with defaults.

Green:

1. Replace legacy default config path with `~/.config/herd/settings.json`.
2. Move default state persistence path to `~/.config/herd/state.json`.
3. Implement load-or-create behavior for settings defaults.

Refactor:

1. Keep path/IO helpers centralized in config module.

Exit criteria:

1. Path and bootstrap tests pass.
2. First-run settings creation works without manual setup.

### Phase 2: Settings schema extension + model discovery

Red:

1. Add failing tests for new settings fields and default values.
2. Add failing tests for settings serialization round-trip including provider/model fields.

Green:

1. Extend settings schema with herd count, provider keys, provider selection, and model selection.
2. Add provider model-fetching helpers (OpenAI + Anthropic) keyed by available API keys.
3. Handle empty/missing keys gracefully with explicit error feedback.

Refactor:

1. Keep provider fetch logic behind small helper functions for future expansion.

Exit criteria:

1. Schema tests pass.
2. Provider model fetching compiles and integrates with settings flow.

### Phase 3: TUI settings overlay (`,` command)

Red:

1. Add failing model/update tests for `,` opening settings overlay and key handling.
2. Add failing render tests confirming settings overlay appears and reflects editable fields.

Green:

1. Implement settings overlay state in `AppModel`.
2. Bind `,` in command mode to open overlay.
3. Support editing settings values and saving to `settings.json`.
4. Support model refresh/selection based on provider keys and selected provider.

Refactor:

1. Keep overlay rendering and event handling separate from main-pane logic where possible.

Exit criteria:

1. New TUI tests pass.
2. Manual smoke confirms open/edit/save path.

### Phase 4: Herd Modes editing + markdown prompt persistence

Red:

1. Add failing TUI tests for herd-mode add/rename/remove interactions.
2. Add failing config tests for herd-mode definitions and prompt file bootstrap.

Green:

1. Extend settings schema with `herd_modes` (`name` + markdown `file` path).
2. Add a dedicated Herd Modes section in settings with selection/add/remove/edit affordances.
3. Add a markdown prompt editor overlay and write prompt files under `~/.config/herd/herd_modes/`.
4. Ensure first-boot and save flows materialize missing herd-mode prompt markdown files.

Refactor:

1. Keep prompt file path normalization and default prompt generation in focused helpers.

Exit criteria:

1. Herd mode settings interactions are test-covered.
2. Prompt markdown files are created/written under config home paths.
3. Config round-trip remains stable with herd mode definitions.

## Exit Criteria Per Phase (Summary)

1. Phase 1: unified default persistence paths + first-boot file creation validated by tests.
2. Phase 2: expanded settings schema + provider/model fetch plumbing validated by tests.
3. Phase 3: settings overlay interaction validated by tests and manual smoke.
4. Phase 4: herd mode editing/prompt persistence validated by tests.

## Acceptance Criteria

1. First run creates `~/.config/herd/settings.json` when missing.
2. Default runtime persistence uses `~/.config/herd/state.json`.
3. Pressing `,` opens a settings overlay in the TUI.
4. User can edit herd count, OpenAI key, Anthropic key, provider, and model in TUI.
5. Model list can be fetched for selected provider when a corresponding key is available.
6. Saved settings persist across restarts.
7. Updated tests pass for changed behavior.
8. Herd mode markdown files are created/stored under `~/.config/herd/herd_modes/`.

## Risks and Mitigations

1. Risk: provider API fetch failures or auth errors degrade UX.
   Mitigation: show clear in-TUI status message and keep existing settings unchanged on fetch error.
2. Risk: key handling conflicts between overlay and existing command/input modes.
   Mitigation: isolate overlay input mode and prioritize overlay event routing when active.
3. Risk: herd-count reconfiguration could desync existing herd assignments.
   Mitigation: clamp/normalize assignments when herd count shrinks.
4. Risk: plaintext API key storage.
   Mitigation: document behavior clearly; defer secure keychain integration as future work.

## Implementation Checklist

- [x] Phase 1 complete (paths + first-boot creation)
- [x] Phase 2 complete (schema + model discovery helpers)
- [x] Phase 3 complete (`,` settings overlay + edit/save flow)
- [x] Phase 4 complete (herd modes section + markdown prompt file persistence)
- [x] Unit/integration tests green for touched behavior
- [x] README/docs updated for new settings path and keybinding
- [x] PRD status updated to `Completed` only after full verification

## Command Log

1. `cargo test --test phase3_tui --test phase5_config_and_resilience`
   - result: pass
   - notes: verifies new settings overlay interactions and config/state path/bootstrap behavior.
2. `cargo test --lib`
   - result: pass
   - notes: includes new LLM model parsing helper tests.
3. `cargo test`
   - result: pass
   - notes: full suite green after path/schema/UI updates.
4. `cargo fmt --check` then `cargo fmt`
   - result: pass
   - notes: formatting corrected post-implementation.
5. `cargo clippy --all-targets`
   - result: pass
   - notes: no lint blockers in touched code paths.
6. `cargo test --test phase3_tui --test phase5_config_and_resilience`
   - result: pass
   - notes: covers herd-mode overlay interactions and prompt file bootstrap behavior.
7. `cargo test`
   - result: pass
   - notes: full regression after herd-mode settings/prompt persistence updates.
