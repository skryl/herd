# Herd Color Palette + Herder Log Filtering PRD

## Status

Completed (2026-02-22)

## Context

The TUI currently renders herd assignments and herder log output in mostly uniform colors. The log pane also lacks quick per-herd filtering, which makes it harder to isolate activity for a single herd during active runs.

## Goals

1. Give each herd ID (`0-9`) a stable, distinct display color.
2. Apply herd color in the Herds pane and session herd indicators.
3. Color herder log lines by herd ID.
4. Add Herder Log focus controls to filter log lines by herd ID using `0-9`.

## Non-goals

1. Persisting herder log filter state to disk.
2. Changing rule engine behavior or dispatch gating logic.
3. Adding external/exported log files.

## Phased Plan (Red/Green)

### Phase 1: Log filter controls + render behavior

Red:
1. Add failing TUI tests for numeric filtering in Herder Log focus.
2. Add failing TUI checks for updated Herder Log shortcut hints.

Green:
1. Add in-memory Herder Log filter state (`all` or `herd N`).
2. Bind `0-9` to filter when Herder Log pane is focused.
3. Add clear filter controls (`a` or `-`) while focused on Herder Log.
4. Render only matching entries when filter is active.

Refactor:
1. Keep filter/scroll math in AppModel helper methods.

Exit criteria:
1. Herder Log shows only selected herd entries when filtered.
2. Existing herd assignment shortcuts still work outside Herder Log focus.

### Phase 2: Herd palette + colored log entries

Red:
1. Add failing tests that exercise per-herd log lines and visual output behavior.

Green:
1. Add stable herd color palette helper for IDs `0-9`.
2. Apply palette to Herds list and session herd labels.
3. Store herd metadata per log entry and color rendered log lines accordingly.

Refactor:
1. Keep color helpers centralized and reused across panes.

Exit criteria:
1. Herd visual indicators and log lines consistently use herd palette.
2. Non-herd/system log lines retain neutral styling.

## Acceptance Criteria

1. Each herd ID has a distinct, stable color in TUI.
2. Herder log lines associated with a herd render in that herd color.
3. While Herder Log pane is focused, pressing `0-9` filters logs to that herd.
4. Filter can be cleared in Herder Log pane without affecting herd assignments.
5. Touched tests pass.

## Risks and Mitigations

1. Risk: Numeric keybindings conflict with herd assignment shortcuts.
   Mitigation: Scope filtering keys to Herder Log focus only.
2. Risk: Filtered view breaks scroll calculations.
   Mitigation: Derive max scroll from filtered line count.
3. Risk: Color readability varies by terminal theme.
   Mitigation: Use high-contrast ANSI color set and keep neutral fallback for system lines.

## Implementation Checklist

- [x] Phase 1 complete (filter controls + filtered rendering)
- [x] Phase 2 complete (palette + colored herd/log output)
- [x] Touched tests green
- [x] Full `cargo test` green
- [x] PRD status updated to Completed with date
