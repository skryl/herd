# PreToolUse TMUX-Style Agent Tiles PRD

- Status: Completed
- Date: 2026-03-19

## Context

Herd currently handles Claude `PreToolUse` `Agent` hooks by spawning a read-only tile that tails the agent transcript. That gives visibility, but it is not a real terminal session and it diverges from the tmux teammate-mode experience where each child agent runs inside its own Claude terminal surface.

We now have the live tmux teammate child command shape:

`<claude-binary> --agent-id <agent_id> --agent-name <agent_name> --team-name <team_name> --agent-color <color> --parent-session-id <lead_session_uuid> [permission/model flags]`

The project needs the `PreToolUse` agent hook path to launch the same style of Claude child session inside a normal Herd tile instead of a read-only transcript viewer.

## Goals

- Replace transcript-tail observer tiles for `PreToolUse` `Agent` hooks with normal Herd tiles.
- Launch the same Claude child-agent command shape used by tmux teammate handoff.
- Keep parent/child lineage in the Herd canvas.
- Make the new behavior integration-testable without launching the real Claude binary in tests.

## Non-goals

- Rework Claude’s own internal agent backend selection.
- Remove the debugging transcript parser or background Bash hook behavior.
- Change tmux teammate-mode itself.

## Scope

- `.claude/hooks/on-agent-start.sh`
- `tests/integration/claude-hooks.test.ts`
- small test-only helper logic as needed
- optional docs/status updates

## Risks and mitigations

- Risk: real Claude agent launches are not deterministic in CI or local integration tests.
  - Mitigation: add an env override for the spawned child binary so tests can use a fake executable and assert the exact argv.
- Risk: current `Agent` tool payload shape differs from the older hook docs.
  - Mitigation: key off the actual current payload (`name`, `team_name`, `prompt`, `description`, `session_id`) and keep a legacy fallback path for older `subagent_type` payloads.
- Risk: color/model/permission values may be missing.
  - Mitigation: derive stable defaults from team config and hook payload, and omit optional flags when unavailable.

## Acceptance criteria

- Running the `Agent` `PreToolUse` hook with the current Claude payload shape creates a non-read-only Herd tile.
- The spawned tile is connected to the parent window lineage.
- The hook sends a Claude child-agent launch command into the spawned tile using the tmux handoff argument shape.
- Integration coverage verifies the child tile is normal, lineage is preserved, and the child process receives the expected argv via a fake binary.
- Existing background Bash hook coverage still passes.

## Phased Plan

### Phase 0: PRD and payload confirmation

Objective:
- Capture the real `PreToolUse:Agent` payload and document the target launch shape.

Red:
- Confirm the current hook still tails transcripts and marks agent tiles read-only.
- Confirm the actual hook payload fields available in this Claude version.

Green:
- Record the current payload and launch shape in this PRD.

Exit criteria:
- The PRD reflects the current payload and target command form.

### Phase 1: Failing integration coverage

Objective:
- Add tests that describe the new desired behavior before changing the hook.

Red:
- Replace the current agent hook integration expectation with one that requires:
  - a non-read-only tile
  - preserved lineage
  - output proving a tmux-style Claude child command was launched
- Use a fake child binary injected through env so the test fails against the current transcript-tail hook.

Green:
- Capture the failing signal from the integration suite.

Exit criteria:
- The new agent hook integration test fails for the current implementation.

### Phase 2: Hook implementation

Objective:
- Make the `Agent` `PreToolUse` hook spawn a normal tile and launch the Claude child-agent command.

Red:
- The new test fails because the tile is read-only and only transcript tail commands are sent.

Green:
- Update the hook to:
  - parse the current `Agent` payload
  - spawn a child tile through Herd
  - set a stable title
  - avoid `set_read_only`
  - send the tmux-style Claude child command into the tile
  - support a test-only binary override
  - retain a legacy fallback for older payload shapes if needed

Exit criteria:
- The agent hook integration test passes.

### Phase 3: Regression verification and status updates

Objective:
- Prove the change does not break adjacent hook coverage and document completion.

Red:
- Run targeted regression checks.

Green:
- Verify the updated agent hook test and the background Bash hook test both pass.
- Update docs/status if the user-visible behavior description changed.

Exit criteria:
- Targeted integration and static checks pass.

## Implementation checklist

- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Phase 2 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command log

1. `sed -n '1,260p' .claude/hooks/on-agent-start.sh`
   - result: pass
   - notes: confirmed current transcript-tail/read-only behavior
2. `sed -n '1,260p' tests/integration/claude-hooks.test.ts`
   - result: pass
   - notes: confirmed existing read-only transcript expectations
3. `claude` smoke and local artifact inspection
   - result: pass
   - notes: captured the real tmux child-agent command shape and a real `PreToolUse:Agent` payload with `name`, `team_name`, `prompt`, `description`, `run_in_background`, and top-level `session_id`
4. `npm run test:integration -- tests/integration/claude-hooks.test.ts`
   - result: fail -> pass
   - notes: first failed because the old hook still created a read-only transcript tile; passed after the hook launched a normal tile and emitted the tmux-style agent launch path under the test override
5. `bash -n .claude/hooks/on-agent-start.sh`
   - result: pass
   - notes: verified shell syntax after the hook rewrite
6. `npm run check`
   - result: pass
   - notes: Svelte/type checks clean
7. `npm run test:unit`
   - result: pass
   - notes: 34 unit tests passed
8. `npm run test:integration`
   - result: pass
   - notes: full integration suite passed with 7 tests
