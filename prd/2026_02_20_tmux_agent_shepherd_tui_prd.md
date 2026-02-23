# Shepherd TUI PRD (tmux Agent Herding)

## Status

Completed (2026-02-23, superseded by subsequent herd PRDs)

## Date

2026-02-20

## Context

You run multiple Claude Code and Codex agent sessions in tmux and need one local control surface to monitor and steer them. The tool should be a terminal UI (lazygit-style) with:

1. Left pane: all relevant tmux sessions plus live agent status.
2. Right pane: content of the currently selected session.
3. Vim-style navigation.
4. Herding controls: mark sessions for automatic monitoring and intervention.
5. Initial herd rule: if a session appears stopped but not finished, inject a nudge message to continue.

This repo is fresh, so this PRD defines both architecture and phased delivery from zero.

## Goals

1. Build a local CLI/TUI tool (`shepherd`) that discovers tmux sessions and surfaces agent status in real time.
2. Provide a two-pane interface (sessions/status left, selected session content right).
3. Support vim keybindings for navigation and core actions.
4. Allow toggling "herded" state per session.
5. Implement herd rule v1: detect stalled unfinished sessions and inject a configurable follow-up message.
6. Ship with automated tests per phase (red -> green -> refactor) and explicit gate checks.

## Non-goals

1. Replacing tmux itself or managing non-tmux terminals.
2. Deep API integrations with Claude/Codex providers.
3. Distributed multi-host orchestration in v1.
4. Complex autonomous planning behaviors beyond rule-based nudging.
5. Persisting full terminal history outside tmux.

## Scope

In scope for v1:

1. Local tmux session/pane discovery and refresh.
2. Agent status classification from pane metadata and content heuristics.
3. Full-screen split-pane TUI with key-driven workflow.
4. Session herding state management.
5. Rule engine with one production rule (stalled + unfinished -> nudge).
6. Safe injection path using tmux send-keys.
7. Config file for thresholds and nudge text.

Out of scope for v1:

1. Plugin ecosystem.
2. ML-based status classification.
3. GUI app.

## Proposed Technical Direction

1. Language/runtime: Rust (stable toolchain).
2. TUI: `ratatui` with `crossterm` backend.
3. tmux integration: shelling to `tmux` commands with structured formats (`-F`) and targeted capture/send operations.
4. CLI: `clap` for command tree (`tui`, `sessions`, `herd`).
5. Persistence: YAML/TOML config and local state file under XDG config path.
6. Testing: Rust unit tests, integration tests with tmux test fixture scripts, and minimal e2e smoke checks.

## Phased Plan (Red/Green)

### Phase 0: Project bootstrap and contracts

Objective: establish executable CLI skeleton and core interfaces before feature work.

Red:

1. Add failing test for CLI root command returning help and non-zero on invalid subcommand.
2. Add failing compile-time/interface tests for tmux adapter, status classifier, and herd engine contracts.
3. Baseline failure signal: missing command wiring and undefined interfaces.

Green:

1. Create module layout and root command (`shepherd tui`, `shepherd sessions`, `shepherd herd` placeholder).
2. Define core interfaces and domain models with minimal no-op implementations.
3. Run targeted tests to confirm command and interface tests pass.

Refactor:

1. Normalize package boundaries and naming while preserving behavior.

Exit criteria:

1. CLI command tree exists and builds.
2. Contracts compile and tests pass.
3. Baseline development loop works (`cargo test` on scaffolding subset).

### Phase 1: tmux discovery and session model

Objective: reliably discover tmux sessions/panes and present normalized metadata.

Red:

1. Add unit tests for parsing tmux command output fixtures into session/pane structs.
2. Add integration test with a temporary tmux server to validate discovery behavior.
3. Baseline failure signal: parser mismatch or discovery returns empty/incorrect metadata.

Green:

1. Implement tmux adapter (`list sessions`, `list panes`, `capture-pane`) with timeout/error handling.
2. Build session model (session id/name, pane id, cwd, last activity timestamp).
3. Add retry-safe refresh path for TUI polling.

Refactor:

1. Deduplicate parsing and command execution helpers.

Exit criteria:

1. Discovery passes unit and integration tests.
2. Errors are surfaced without crashing.
3. Refresh can run repeatedly without state corruption.

### Phase 2: Agent status classification

Objective: classify each session as running/waiting/finished/stalled/unknown.

Red:

1. Add unit tests for classifier against Claude/Codex transcript fixtures.
2. Add failing tests for stalled detection based on inactivity threshold and unfinished markers.
3. Baseline failure signal: statuses resolve to unknown/incorrect values.

Green:

1. Implement rule-based status classifier using pane content + recency metadata.
2. Add configurable finished markers and inactivity thresholds.
3. Expose status summary in `shepherd sessions`.

Refactor:

1. Isolate heuristic sets from classifier logic to simplify future rule additions.

Exit criteria:

1. Fixture-based classifier tests pass.
2. Stalled-vs-finished distinction is validated.
3. Status output is stable across consecutive refreshes.

### Phase 3: Split-pane TUI with vim navigation

Objective: deliver the main lazygit-style interface.

Red:

1. Add model/update tests for keybindings (`j`, `k`, `g`, `G`, `h`, `l`, `enter`, `q`).
2. Add render tests asserting left list + right content layout shape.
3. Baseline failure signal: key events do not move selection/focus; layout missing required panes.

Green:

1. Implement full-screen two-pane TUI.
2. Left pane shows session list with herd flag and status badge.
3. Right pane shows captured content for selected session with periodic refresh.
4. Implement vim navigation and key hint line.

Refactor:

1. Separate view rendering from update logic; simplify keymap registry.

Exit criteria:

1. Required layout and navigation tests pass.
2. Manual smoke check confirms responsive navigation in a real tmux environment.
3. No blocking redraw loops under normal refresh intervals.

### Phase 4: Herding engine and rule v1 (stalled unfinished nudge)

Objective: automate minimal intervention for marked sessions.

Red:

1. Add failing tests for herd state toggling and persistence.
2. Add failing tests for rule v1: inject once when stalled/unfinished; do not inject when finished.
3. Add failing cooldown/max-attempt tests to prevent spam.
4. Baseline failure signal: no injection occurs or duplicate injections occur.

Green:

1. Implement herd registry (mark/unmark per session).
2. Implement monitor loop evaluating herded sessions against rule v1.
3. Inject configurable nudge text through `tmux send-keys ... Enter`.
4. Add cooldown and max-nudge guards with observable counters.

Refactor:

1. Extract rule engine interface to allow additional rules in future phases.

Exit criteria:

1. Rule tests pass for positive and negative scenarios.
2. Injection behavior is idempotent within cooldown windows.
3. Herd actions are visible in UI/state.

### Phase 5: Config, resilience, and release gates

Objective: harden behavior and finalize v1 delivery.

Red:

1. Add failing config load/save tests for defaults and overrides.
2. Add failing resilience tests for tmux disconnect/reconnect handling.
3. Baseline failure signal: defaults not applied, malformed config crashes, or reconnect breaks monitoring.

Green:

1. Implement config file support (thresholds, markers, nudge text, refresh interval).
2. Implement resilient error recovery and surfaced warning states in TUI.
3. Add release-quality docs (`README` quickstart, keybindings, safety notes).

Refactor:

1. Clean up command wiring and reduce duplicate state transitions.

Exit criteria:

1. Config and resilience tests pass.
2. Manual recovery scenarios succeed (tmux restart, missing session, invalid config).
3. Docs match implemented behavior.

## Testing Gates

Run from specific to broad for each completed phase:

1. Unit: `cargo test --lib`
2. Integration: `cargo test --test '*'`
3. E2E/runtime smoke: scripted tmux scenario checks for UI + herd injection paths.
4. CI-facing checks for touched workflows: `cargo test`, `cargo clippy --all-targets`, and `cargo fmt --check`.

If any gate cannot run locally, document exact command and blocker in PR notes.

## Exit Criteria Per Phase (Summary)

1. Phase 0: CLI scaffolding + contracts compile and tests pass.
2. Phase 1: tmux discovery stable and repeatable under test.
3. Phase 2: status classifier correctly distinguishes stalled vs finished on fixtures.
4. Phase 3: split-pane UI and vim navigation verified by tests + smoke check.
5. Phase 4: herd rule v1 injects safely with cooldown and completion guards.
6. Phase 5: config/recovery/docs complete and full regression gates pass.

## Acceptance Criteria (Full Completion)

1. `shepherd tui` opens a split screen with sessions/status left and selected content right.
2. Vim navigation works for session selection, focus movement, and quit.
3. Users can mark/unmark sessions as herded from the TUI.
4. Herd rule v1 detects stalled unfinished sessions and injects a nudge exactly within configured guardrails.
5. Finished sessions are not nudged.
6. Herd/config state persists across restarts.
7. Automated tests for new behavior are green and regression checks on touched areas are complete.
8. PRD status is updated to `Completed` only when all implementation checklist items are done.

## Risks and Mitigations

1. Risk: false positive "finished" or "stalled" detection across different agent output styles.
   Mitigation: configurable marker sets, fixture expansion, conservative defaults, explicit unknown state.
2. Risk: message injection spam.
   Mitigation: cooldown, max-nudge count, per-session last-injection tracking, clear activity log.
3. Risk: tmux command latency or intermittent errors degrade TUI responsiveness.
   Mitigation: bounded timeouts, async polling, error states without crashing.
4. Risk: pane/session id drift during rapid tmux changes.
   Mitigation: refresh reconciliation keyed by stable identifiers; stale-entry cleanup.
5. Risk: accidental nudges to wrong pane.
   Mitigation: explicit pane targeting, pre-send validation, optional dry-run mode for tests.

## Implementation Checklist

- [x] Phase 0 complete (bootstrap + contracts)
- [x] Phase 1 complete (tmux discovery/model)
- [x] Phase 2 complete (status classifier)
- [x] Phase 3 complete (split-pane TUI + vim keys)
- [x] Phase 4 complete (herding rule v1 + injection guards)
- [x] Phase 5 complete (config/resilience/docs)
- [x] Unit tests green for touched modules
- [x] Integration tests green for tmux boundaries
- [x] E2E/runtime smoke checks complete
- [x] PRD status updated to reflect actual completion state
