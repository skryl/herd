# Codex App-Server Session Status Integration PRD

## Status

Completed (2026-02-22)

## Context

Current Herd status classification is tmux-driven (pane capture + inactivity/marker heuristics). For Codex sessions this can misclassify active/idle states because update timing is inferred indirectly from pane activity.

Codex exposes structured thread/turn lifecycle data through the app-server protocol (`thread/list`, `thread/read`, `turn/*` notifications). We can use this to improve status accuracy for `codex*` panes while preserving tmux heuristics as fallback.

## Goals

1. Use Codex app-server thread/turn status to enrich status assessment for Codex sessions.
2. Preserve existing behavior for non-Codex sessions.
3. Keep tmux heuristic path as fallback when app-server is unavailable or errors.
4. Apply enrichment consistently in both TUI and `herd sessions` CLI output.
5. Avoid heavy refresh costs with cached lookups and bounded retry behavior.

## Non-goals

1. Replacing tmux-based session discovery.
2. Supporting non-Codex provider status APIs in this change.
3. Full real-time subscription mode to app-server notifications for arbitrary external sessions.

## Phased Plan (Red/Green)

### Phase 1: Contracts + mapping rules

Red:
1. Add failing tests for mapping Codex turn status (`inProgress`, `completed`, `interrupted`, `failed`) to Herd process assessment.
2. Add failing tests for waiting-grace behavior under Codex-completed/idle state.

Green:
1. Add Codex status model and mapping helpers.
2. Add assessment reasons and confidence values for Codex-derived states.

Refactor:
1. Keep mapping in one module reusable by TUI + CLI.

Exit criteria:
1. Mapping tests pass and fallback path remains unchanged.

### Phase 2: App-server query client + caching

Red:
1. Add failing tests for app-server JSON response parsing and latest-thread selection by cwd.
2. Add failing tests for error handling/backoff semantics.

Green:
1. Implement lightweight JSON-RPC client for `codex app-server` stdio.
2. Implement cached lookup keyed by cwd using `thread/list` + `thread/read`.
3. Add retry cooldown when app-server fails.

Refactor:
1. Isolate IO from parsing where practical.

Exit criteria:
1. Status provider returns deterministic per-cwd state snapshots with graceful failure.

### Phase 3: Runtime integration (TUI + CLI)

Red:
1. Add failing integration checks asserting codex sessions prefer app-server-derived assessment.
2. Add failing checks asserting fallback to heuristic assessment when provider unavailable.

Green:
1. Integrate provider into TUI refresh/session-build path.
2. Integrate provider into `sessions` command status path.
3. Keep herder log/status messaging informative on provider failures.

Refactor:
1. Keep function signatures and callsites bounded despite additional provider input.

Exit criteria:
1. Codex panes reflect provider-backed status when available; all other panes unchanged.

## Acceptance Criteria

1. Codex sessions can derive state from app-server thread/turn data.
2. TUI and `herd sessions` both use codex enrichment where available.
3. On provider failure/unavailability, Herd still works via tmux heuristics.
4. Existing test suite remains green; new tests cover codex mapping/provider behavior.

## Risks and Mitigations

1. Risk: app-server process/query latency can stall refresh.
   Mitigation: cache + poll interval + retry backoff.
2. Risk: cwd->thread mapping ambiguity.
   Mitigation: sort by `updated_at`, choose latest, and preserve fallback heuristic.
3. Risk: protocol drift in app-server JSON.
   Mitigation: tolerant serde parsing and defensive unknown-status handling.
4. Risk: regressions in non-Codex behavior.
   Mitigation: gate enrichment strictly to `codex*` commands.

## Implementation Checklist

- [x] Phase 1 complete (mapping contracts + tests)
- [x] Phase 2 complete (app-server client + cache/backoff)
- [x] Phase 3 complete (TUI + CLI integration)
- [x] New/touched tests green
- [x] Full `cargo test` green
- [x] PRD status updated to Completed with date
