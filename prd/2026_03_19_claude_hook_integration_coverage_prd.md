# Claude Hook Integration Coverage PRD

## Status

Completed

## Date

2026-03-19

## Context

Herd already has an in-app integration harness and two active Claude Code project hooks:

1. `PreToolUse` for `Agent`
2. `PreToolUse` for background `Bash`

Those hooks are user-visible behavior. They create read-only Herd tiles, title them, and in the agent case stream transcript output. But that behavior is not currently covered by the supported integration suite, so regressions can slip through even though the hook path is part of the day-to-day Claude workflow.

## Goals

1. Add live integration tests for every currently configured Claude hook.
2. Cover the visible hook outcomes through the running Herd app and socket driver.
3. Assert parent/child tile behavior for hook-spawned tiles.
4. Assert read-only state and observable hook output.

## Non-goals

1. Adding coverage for inactive or legacy hook scripts.
2. Replacing the hook implementations with a different architecture.
3. Mocking Claude itself.

## Scope

In scope:

1. `on-agent-start.sh`
2. `on-bg-bash.sh`
3. Minimal hook-path fixes required to make the visible behavior deterministic and testable

Out of scope:

1. `on-subagent-start.sh`
2. Global Claude config
3. DOM-heavy UI assertions outside the existing test-driver/debug surfaces

## Risks and mitigations

1. Hook scripts run in shell and depend on runtime env.
   Mitigation: run them in the integration harness with isolated `HERD_SOCK` and explicit parent pane env.
2. Transcript streaming is asynchronous.
   Mitigation: poll state/output with bounded waits and create dedicated temp transcript directories per hook instance.
3. Hook-created tiles may not preserve lineage today.
   Mitigation: make hook spawn requests parent-aware before asserting connections.

## Acceptance criteria

1. The active `Agent` hook is covered by a live integration test.
2. The active background `Bash` hook is covered by a live integration test.
3. Agent hook coverage verifies:
   - separate child tiles are created
   - tiles are read-only
   - titles match hook naming
   - transcript text becomes visible in the created tiles
4. Background Bash hook coverage verifies:
   - foreground commands do not create a tile
   - background commands create a separate read-only tile
   - the visible title and echoed command match the hook payload
5. Hook-spawned tiles preserve parent linkage to the originating pane.

## Phased Plan

### Phase 1: Parent-aware hook spawn path

Objective:

Make the active hook scripts provide stable parent linkage for spawned tiles.

Red:

1. Add integration coverage that expects hook-spawned tiles to link back to the originating pane.
2. Expected failure: spawned tiles appear unparented because the hook scripts do not pass a parent pane through `spawn_shell`.

Green:

1. Update the active hook scripts to pass `parent_pane_id` when a parent tmux pane is available.
2. Verify hook-spawned tiles retain root-parent lineage in Herd state.

Exit criteria:

1. Hook-created tiles are parent-aware through the live socket path.

### Phase 2: Hook behavior coverage

Objective:

Cover the configured hook outcomes end to end through the running app.

Red:

1. Add integration tests for:
   - multi-agent hook launches
   - transcript streaming
   - background Bash read-only tiles
   - no-op foreground Bash path
2. Expected failure: unsupported or regressed hook behavior shows up as missing tiles, missing read-only state, missing lineage, or missing output.

Green:

1. Add hook-driving integration helpers.
2. Make any minimal hook-path fixes needed for the tests to pass.
3. Keep assertions state-first and output-based.

Exit criteria:

1. Both active Claude hooks are covered by the live integration suite.

## Execution Checklist

- [x] Phase 1 complete
- [x] Phase 2 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log

1. `npm run test:integration`
   - result: pass
   - notes: live hook suite plus existing driver coverage passed
2. `npm run test:unit`
   - result: pass
   - notes: existing frontend state tests still green
3. `npm run check`
   - result: pass
   - notes: Svelte and TypeScript checks passed
4. `cargo check --manifest-path src-tauri/Cargo.toml`
   - result: pass
   - notes: passed with existing non-blocking Rust warnings
