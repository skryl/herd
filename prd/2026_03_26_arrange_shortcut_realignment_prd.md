# Arrange Shortcut Realignment PRD

## Header

1. Title: keyboard realignment of `a` and `Shift+A`
2. Status: Complete
3. Date: 2026-03-26

## Context

Herd currently maps lowercase `a` to the anchored arrangement cycle and `Shift+A` directly to the ELK arrangement. The requested behavior changes those meanings:

- lowercase `a` should align the current session’s tiles to the nearest grid snap points
- `Shift+A` should start with ELK and then continue through the old anchored arrangement sequence

This affects keyboard routing, session layout behavior, and the user-facing shortcut descriptions.

## Goals

- Make lowercase `a` snap the active session’s tile positions to the nearest configured grid points.
- Make `Shift+A` follow a cycle of `ELK -> circle -> snowflake -> stack-down -> stack-right -> spiral -> ELK ...`.
- Keep the existing anchored arrangement implementations intact.
- Update user-facing shortcut descriptions to match the new behavior.

## Non-goals

- No changes to the underlying anchored arrangement formulas.
- No changes to the command bar shortcuts in this pass.
- No backend/socket surface changes.

## Scope

In scope:

- new app-state grid alignment action
- keyboard shortcut routing changes
- shortcut/help text updates
- targeted unit coverage for alignment and keyboard sequencing

Out of scope:

- canvas background grid visuals
- new arrange menu items or toolbar controls

## Risks and mitigations

- Risk: the `Shift+A` cycle could get stuck on anchored layouts and never return to ELK.
  - Mitigation: track the wrap point explicitly in tests.
- Risk: lowercase `a` could unexpectedly zoom/fit the canvas like the old arrange command.
  - Mitigation: test routing and keep the alignment command separate from fit behavior.
- Risk: grid alignment could affect only shell/browser tiles and miss work cards.
  - Mitigation: align all layout entries in the active session and test both pane-backed and work-card entries.

## Acceptance criteria

- Pressing `a` aligns the active session’s tiles to their nearest grid points using the current grid size.
- Pressing `a` no longer advances the anchored arrangement cycle.
- Pressing `Shift+A` runs ELK first, then the old anchored arrangements on subsequent presses, and returns to ELK after the anchored cycle wraps.
- Help and shortcut text describe the new behavior.

## Phased Plan (Red/Green)

### Phase 0: Red coverage for routing and alignment

1. Objective
   - Add failing tests for the new keyboard routing and the grid-alignment behavior.
2. Red
   - Add failing tests for:
     - lowercase `a` routing to grid alignment instead of the anchored cycle
     - `Shift+A` using ELK first and returning to ELK after the anchored sequence wraps
     - session grid alignment snapping existing layout entries
   - Expected failure signal
     - keyboard tests still expecting old `a` behavior and no grid-alignment function
3. Green
   - Add the new alignment action and update keyboard routing.
   - Verification commands
     - targeted Vitest
4. Exit criteria
   - keyboard behavior matches the requested shortcut semantics

### Phase 1: Shortcut text and regression pass

1. Objective
   - Update user-visible shortcut text and run adjacent regression checks.
2. Red
   - Update shortcut/help assertions if any are covered, or verify text paths manually.
   - Expected failure signal
     - stale shortcut descriptions still mention the old `a` behavior
3. Green
   - Update status bar/help/docs text.
   - Verification commands
     - targeted Vitest and `npm run check`
4. Exit criteria
   - visible shortcut descriptions match the implemented behavior

## Execution Checklist

- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log

1. `rg -n "input.key === 'a'|input.key === 'A'|autoArrange\\(|autoArrangeWithElk\\(|align|snap to grid|gridSnap|AUTO_ARRANGE_PATTERNS|keyboard shortcuts|auto-arrange" src/lib src-tauri/src tests/integration/test-driver.test.ts src/lib/interaction/keyboard.test.ts docs`
   - result: pass
   - notes: located current keyboard routing and user-facing shortcut text
2. `sed -n '1,220p' /Users/skryl/.codex/skills/phased-prd-red-green/SKILL.md`
   - result: pass
   - notes: loaded phased PRD workflow
3. `npx vitest run src/lib/interaction/keyboard.test.ts src/lib/stores/appState.test.ts -t "alignSessionToGrid|handleGlobalKeyInput arrange shortcuts"`
   - result: pass
   - notes: verified the new grid-alignment action and the revised `Shift+A` sequencing
4. `npm run check`
   - result: pass
   - notes: validated Svelte and TypeScript after shortcut routing and copy updates
5. `npx vitest run src/lib/interaction/keyboard.test.ts src/lib/stores/appState.test.ts`
   - result: pass
   - notes: full keyboard/app-state regression pass for the affected surface
6. `git diff --check -- src/lib/interaction/keyboard.ts src/lib/interaction/keyboard.test.ts src/lib/stores/appState.ts src/lib/stores/appState.test.ts src/lib/StatusBar.svelte src/lib/HelpPane.svelte docs/keyboard-shortcuts.md prd/2026_03_26_arrange_shortcut_realignment_prd.md`
   - result: pass
   - notes: no whitespace or patch formatting issues in the touched files
