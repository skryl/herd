# JSON Rule Engine + Always-Visible Herder Log PRD

## Status

Completed (2026-02-21)

## Context

Herd modes currently use markdown prompt files and static mode enums. Nudge behavior is a single fixed message sent when cooldown/stall checks pass. We need to migrate herd modes to JSON rule files that execute ordered regex/LLM rules, render templated commands from returned variables, and send commands to tmux on rule matches. We also need a verbose herder log panel that is always visible beneath content.

## Goals

1. Replace markdown herd mode files with JSON rule files.
2. Support ordered rule evaluation with first-match short-circuit.
3. Support regex and LLM rule types with explicit input scope selection.
4. Send templated tmux commands using bound variables and optional `{command}` from LLM output.
5. Add an always-visible herder log pane below the content pane (right side split).
6. Make herder log verbose and useful for diagnosing rule evaluation behavior.
7. Keep all settings/config/state under `~/.config/herd`.

## Non-goals

1. Add persistent on-disk herder logs (session-memory log only).
2. Add shell escaping/sandboxing for generated commands.
3. Redesign unrelated TUI layout outside required right-pane split and focus additions.

## Phased Plan (Red/Green)

### Phase 1: Config schema + rule file migration bootstrap

Red:
1. Add failing config tests for `.json` herd mode files and bootstrap behavior.
2. Add failing migration tests for legacy `.md` mode references (hard reset to defaults).

Green:
1. Change herd mode config shape to use JSON rule files (`rule_file`).
2. Bootstrap default `.json` rule files under `~/.config/herd/herd_modes/`.
3. Apply hard-reset migration from legacy markdown mode definitions.

Refactor:
1. Keep path normalization, migration checks, and default rule-file generation in config/rules helpers.

Exit criteria:
1. Config round-trip and first-boot tests pass with JSON mode files.
2. Legacy markdown migration path is deterministic.

### Phase 2: Dynamic herd mode identity + registry migration

Red:
1. Add failing tests for herd mode persistence as dynamic string identifiers.
2. Add failing tests for cycling herd mode from settings-defined mode names.

Green:
1. Replace static `HerdMode` enum persistence with dynamic mode names per herd.
2. Update UI rendering and registry sync to use dynamic mode names.

Refactor:
1. Keep compatibility helpers localized in herd registry APIs.

Exit criteria:
1. Herd registry tests pass with string mode identities.

### Phase 3: Rule engine core (regex + templates + scopes)

Red:
1. Add failing tests for ordered evaluation and first-match behavior.
2. Add failing tests for regex named captures and template substitution.
3. Add failing tests for missing placeholder behavior.

Green:
1. Introduce rule schema/types and JSON parser.
2. Implement regex rule evaluation and command rendering.
3. Implement input scope handling (`full_buffer`, `visible_window`).

Refactor:
1. Keep command templating and rule execution logic in dedicated rule module.

Exit criteria:
1. Rule engine unit tests pass for regex behavior and template handling.

### Phase 4: LLM rules + runtime integration

Red:
1. Add failing tests for strict LLM JSON output parsing.
2. Add failing tests for skip-on-error behavior for broken LLM responses/provider errors.

Green:
1. Add LLM rule evaluation path with strict JSON contract.
2. Integrate rule evaluation into refresh cycle using existing cooldown/stall gating.
3. Send matched command to tmux and record nudge state.

Refactor:
1. Keep LLM transport/parsing separate from rule orchestration.

Exit criteria:
1. Refresh-cycle integration tests pass for first-match execution and error handling.

### Phase 5: Always-visible herder log pane + TUI settings updates

Red:
1. Add failing TUI tests for right-side split with always-visible log pane.
2. Add failing focus/scroll tests for log pane.
3. Add failing settings-render tests for `Rule File` / `Edit Rules`.

Green:
1. Add `Herder Log` pane below content with 70/30 split.
2. Add `FocusPane::HerderLog` with scroll controls and follow-tail behavior.
3. Add in-memory verbose log buffer (10,000 lines cap).
4. Update settings/editor labels and rule-file editing semantics.

Refactor:
1. Isolate log append/trim/scroll helpers in model methods.

Exit criteria:
1. New and existing TUI tests pass, and log pane remains always visible.

## Acceptance Criteria

1. Herd mode files are JSON rule files, not markdown prompts.
2. Rule types: regex and llm; both support `full_buffer` / `visible_window` input scope.
3. Rules execute in order; first true rule sends rendered command and stops further rule evaluation for that pane/cycle.
4. Regex rules return boolean plus named-capture variables as JSON values.
5. LLM rules return strict JSON with boolean and optional command/variables.
6. Commands support placeholders like `{command}` and `{variable}`.
7. Missing placeholders fail rule rendering (no send).
8. Rule errors are logged and skipped; remaining rules still evaluate.
9. Herder log pane is always visible below content and supports focus + scrolling.
10. Herder log includes verbose rule-evaluation lifecycle entries.
11. All touched tests pass.

## Risks and Mitigations

1. Risk: LLM provider response shape drift.
   Mitigation: strict parser with clear errors; skip failing rules and continue.
2. Risk: dynamic herd mode names break existing saved state.
   Mitigation: default fallback mode assignment and migration fallback to primary mode.
3. Risk: noisy logs impacting readability.
   Mitigation: structured concise line format and fixed in-memory retention.
4. Risk: `visible_window` mismatch with actual tmux pane viewport.
   Mitigation: query tmux pane height and derive tail lines consistently.

## Implementation Checklist

- [x] Phase 1 complete (config + migration + bootstrap)
- [x] Phase 2 complete (dynamic herd mode identity)
- [x] Phase 3 complete (rule engine core)
- [x] Phase 4 complete (LLM rule integration)
- [x] Phase 5 complete (always-visible herder log + settings updates)
- [x] Unit/integration tests green for touched behavior
- [x] README/docs updated for new rule and log behavior
- [x] PRD status updated to Completed with date
