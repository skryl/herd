# Status Machine + Herd Trigger Eligibility PRD

## Status

Completed (2026-02-21)

## Context

Current herd triggering depends on a coarse status classifier and only runs rules when status is `stalled`. The classifier is purely heuristic (`waiting` markers, `finished` markers, inactivity threshold). This misses long-lived waiting states and provides weak observability for why a pane is or is not eligible for herding.

We need a richer process-state model that still presents the existing UI status labels but computes explicit herd eligibility from state + timing evidence. We also need rule evaluation to receive structured status context, and we need migration to happen in place without destructive resets or config versioning.

## Goals

1. Introduce a stateful status assessment model with explicit reasons and timing.
2. Trigger herd rule evaluation for both `stalled` and `waiting` panes that exceed a waiting grace.
3. Preserve conservative behavior (avoid false-positive nudges).
4. Keep existing cooldown/max-nudges/herded safety gates.
5. Inject structured status context into rule evaluation and template variables.
6. Migrate config/state/rule files in place (no wipe, no `config_version`).
7. Maintain verbose herder log explainability for status decisions and gating.

## Non-goals

1. New external storage backends.
2. Global LLM-prefilter requirement before LLM rules.
3. Breaking CLI/TUI command UX or keybindings unrelated to status/trigger logic.

## Phased Plan (Red/Green)

### Phase 1: Status assessment model contracts

Red:
1. Add failing tests for richer assessment output: reasons, confidence, inactivity, waiting duration.
2. Add failing tests for waiting-grace promotion (`Waiting` -> `WaitingLong`) and display-status mapping.

Green:
1. Add `ProcessState`, `StatusReasonCode`, and `ProcessAssessment` model types.
2. Update classifier contract from status-only to assessment output.
3. Keep UI-facing `AgentStatus` values as display mapping.

Refactor:
1. Keep normalization helpers centralized in `agent.rs`.

Exit criteria:
1. Classifier unit tests pass with assessment-first API.

### Phase 2: Registry persistence for transition continuity

Red:
1. Add failing tests for state continuity across cycles/restarts.

Green:
1. Extend `HerdSessionState` with persisted assessment metadata:
   - `last_assessment_state`
   - `state_entered_unix`
   - `last_assessment_unix`
   - `last_reasons`
2. Add registry helpers to update/read assessment metadata.

Refactor:
1. Keep serde defaults/backward compatibility for old state files.

Exit criteria:
1. Existing state files load; new metadata persists after save.

### Phase 3: Herd trigger gate redesign

Red:
1. Add failing herd tests for:
   - stalled eligible
   - waiting short not eligible
   - waiting long eligible
   - cooldown/max-nudge still enforced

Green:
1. Change herd engine gate from `status == stalled` to `assessment.eligible_for_herd` and confidence threshold.
2. Preserve herded/cooldown/max gates.

Refactor:
1. Keep gating logic encapsulated in `HerdRuleEngine`.

Exit criteria:
1. Phase 4 herd tests pass with new eligibility semantics.

### Phase 4: Rule-context injection

Red:
1. Add failing rule-engine tests for status context template variables.
2. Add failing integration test for LLM input receiving status context payload.

Green:
1. Add `RuleRuntimeContext` in rules module.
2. Inject status-derived variables into regex/LLM template rendering.
3. Include structured status context in LLM rule input composition.

Refactor:
1. Keep context variable assembly isolated from rule evaluation loop.

Exit criteria:
1. Rule tests validate context values and rendering behavior.

### Phase 5: In-place migration and config defaults

Red:
1. Add failing config tests asserting new status knobs are defaulted when absent.
2. Add failing tests asserting old config/state/rule files are upgraded in place.

Green:
1. Add config fields:
   - `status_waiting_grace_secs`
   - `status_transition_stability_secs`
   - `status_confidence_min_for_trigger`
2. On load, merge missing values and persist normalized config back to disk.
3. Normalize rule files in place when parseable, preserving authored rules.

Refactor:
1. Keep migration in load/save path without config version key.

Exit criteria:
1. Legacy files load and are rewritten with missing defaults populated.

### Phase 6: Runtime integration and logs

Red:
1. Add failing TUI/runtime tests for logging of assessment/gate decisions.

Green:
1. Use assessment in UI session build, gate evaluation, and registry metadata updates.
2. Add herder log lines for:
   - assessment summary
   - transition decisions
   - eligibility verdict
   - dispatch/no-dispatch reason

Refactor:
1. Keep refresh-loop complexity bounded with helper functions.

Exit criteria:
1. Runtime tests and existing TUI regressions pass.

## Acceptance Criteria

1. Classifier outputs structured assessment with reasons/timing/confidence.
2. Herd rules can trigger for stalled sessions and waiting sessions past grace.
3. Conservative guardrails remain: herded only, cooldown, max nudges, confidence threshold.
4. Rule context exposes status fields to template/LLM evaluation.
5. Existing config/state/rule files are updated in place (no destructive reset).
6. No `config_version` field is introduced.
7. Herder log clearly explains status and trigger decisions.
8. Full touched test suite passes.

## Risks and Mitigations

1. Risk: state-flapping between running/waiting.
   Mitigation: transition stability threshold and persisted state-entered timestamps.
2. Risk: accidental nudges from ambiguous waiting detection.
   Mitigation: waiting grace + confidence threshold + existing cooldown/max.
3. Risk: migration rewrites user-authored files unexpectedly.
   Mitigation: normalize parseable files only; preserve logical content.
4. Risk: runtime complexity in refresh loop.
   Mitigation: extract helper functions and focused tests.

## Implementation Checklist

- [x] Phase 1 complete (assessment model + tests)
- [x] Phase 2 complete (registry persistence metadata)
- [x] Phase 3 complete (eligibility gate redesign)
- [x] Phase 4 complete (rule runtime context injection)
- [x] Phase 5 complete (in-place migration/defaults)
- [x] Phase 6 complete (runtime wiring + verbose logs)
- [x] Tests green for touched behavior
- [x] README/docs updated for new status/trigger semantics
- [x] PRD status updated to Completed with date
