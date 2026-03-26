# Shift+A ELK Layout PRD

## Header

1. Title: Shift+A ELK layout mode
2. Status: Completed
3. Date: 2026-03-24

## Context

Herd already has a lowercase `a` auto-arrange cycle that applies a small set of local placement patterns (`circle`, `snowflake`, `stack-down`, `stack-right`, `spiral`). That is useful for quick manual reshuffling, but it is not topology-aware.

The repo already has `elkjs` installed, and the user wants a separate `Shift+A` mode that arranges the current session with ELK based on tile connectivity, tile sizes, and explicit port sides. Lowercase `a` must keep its current behavior.

## Goals

- Add a new `Shift+A` command path that computes a session-wide ELK layout.
- Use current tile sizes and network port connections as ELK inputs.
- Arrange all current-session tiles on the canvas, not only tmux-backed windows.
- Preserve lowercase `a` as the existing pattern-cycle behavior.
- Record the new mode as `elk` so the session reflects that `Shift+A` is active.

## Non-goals

- Replacing or removing the lowercase `a` pattern cycle.
- Changing socket, MCP, or backend layout APIs.
- Implementing animated layout transitions.
- Adding a second non-ELK fallback mode for `Shift+A`.

## Scope

- Frontend layout logic in `src/lib/stores/appState.ts`
- Keyboard wiring in `src/lib/interaction/keyboard.ts`
- Help text in `src/lib/HelpPane.svelte`
- Types in `src/lib/types.ts`
- Unit coverage in `src/lib/stores/appState.test.ts`
- Shortcut coverage in a new `src/lib/interaction/keyboard.test.ts`

## Risks and mitigations

- Risk: ELK can produce unstable placement if graph direction is underconstrained.
  - Mitigation: derive a dominant layout direction from current port usage and set explicit layered options.
- Risk: ELK output may overlap or drift too far from the current working area.
  - Mitigation: snap output to Herd’s grid and anchor the resulting graph to the currently selected tile when possible.
- Risk: disconnected tiles may be dropped from the graph.
  - Mitigation: always include every current-session tile as a node, even without edges.
- Risk: `Shift+A` could accidentally reuse the lowercase cycle state.
  - Mitigation: keep `elk` outside the lowercase cycle list and test the split directly.

## Acceptance criteria

- Pressing lowercase `a` still uses the existing arrangement cycle.
- Pressing `Shift+A` uses ELK and marks the session arrangement mode as `elk`.
- ELK layout uses current tile dimensions plus network edge port sides.
- ELK layout includes current-session work tiles as well as tmux-backed tiles.
- ELK layout persists the resulting positions through `saveLayoutState`.
- A session already marked `elk` does not fall back to the lowercase pattern cycle when tmux state changes.

## Phased Plan (Red/Green)

### Phase 0

1. Objective
   - Add failing tests for the new ELK arrange behavior and the shortcut split.
2. Red
   - Add an app-state test that expects a new ELK arrangement mode, ELK-driven ordering from connected tiles, and persisted layout updates.
   - Add an app-state test that expects `elk` mode to survive session growth without falling back to the lowercase pattern cycle.
   - Add keyboard tests that prove lowercase `a` still calls the old cycle and uppercase `A` calls the new ELK path.
   - Expected failure signal: missing export, missing mode, wrong shortcut dispatch, and old arrangement logic still used.
3. Green
   - Export the new API surface needed by the tests and wire minimal stubs if required so the tests compile and fail for the right reason.
   - Verification commands
     - `npx vitest run src/lib/stores/appState.test.ts -t "ELK"`
     - `npx vitest run src/lib/interaction/keyboard.test.ts`
4. Exit criteria
   - The new tests exist and fail for missing ELK behavior rather than test harness issues.

### Phase 1

1. Objective
   - Implement ELK-backed session arrangement and mode tracking.
2. Red
   - Run the new targeted app-state tests and capture the failing signal.
3. Green
   - Add ELK graph construction from current-session tiles and `state.network.connections`.
   - Include port-side metadata and current layout dimensions in the graph.
   - Snap ELK output to Herd’s grid and anchor the graph relative to the selected tile when available.
   - Track `elk` in arrangement mode state without adding it to the lowercase cycle.
   - Verification commands
     - `npx vitest run src/lib/stores/appState.test.ts -t "ELK"`
4. Exit criteria
   - The ELK app-state tests pass and lowercase-cycle tests still pass.

### Phase 2

1. Objective
   - Wire `Shift+A` and update visible help text.
2. Red
   - Run the keyboard tests and capture the failing signal.
3. Green
   - Add `Shift+A` handling to call the new ELK arrangement path.
   - Leave lowercase `a` unchanged.
   - Update help text to document both shortcuts.
   - Verification commands
     - `npx vitest run src/lib/interaction/keyboard.test.ts`
4. Exit criteria
   - Keyboard tests pass and help text matches the shipped shortcut behavior.

### Phase 3

1. Objective
   - Regression verification and PRD closeout.
2. Red
   - Re-run adjacent arrangement tests to catch regressions in the existing lowercase cycle.
3. Green
   - Run targeted regression coverage and diff hygiene checks.
   - Verification commands
     - `npx vitest run src/lib/stores/appState.test.ts`
     - `npx vitest run src/lib/interaction/keyboard.test.ts`
     - `npm run check`
     - `git diff --check`
4. Exit criteria
   - New ELK path is covered, lowercase `a` remains unchanged, and the PRD can be marked complete.

## Execution Checklist

- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Phase 2 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log

1. `rg -n "Shift\\+A|shift\\+a|autoArrange|arrangement|elkjs|ELK" src src-tauri tests -S`
   - result: pass
   - notes: confirmed lowercase `a` path exists, `Shift+A` is unused, and `elkjs` is installed but unused.
2. `npx vitest run src/lib/stores/appState.test.ts -t "ELK"`
   - result: fail, then pass
   - notes: red signal was missing `autoArrangeWithElk`; green verified ELK layout semantics.
3. `npx vitest run src/lib/interaction/keyboard.test.ts`
   - result: fail, then pass
   - notes: red signal was missing `autoArrangeWithElk`; green verified lowercase `a` vs `Shift+A` split.
4. `npx vitest run src/lib/stores/appState.test.ts`
   - result: pass
   - notes: 70/70 app-state tests passed after ELK integration.
5. `npm run check`
   - result: pass
   - notes: Svelte and TypeScript checks are clean.
6. `git diff --check`
   - result: pass
   - notes: no whitespace or patch-format issues remain.
