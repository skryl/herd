## Title
Agent Socket-Only Guidance And Invalid CLI Hard Failure

## Status
Completed

## Date
2026-03-23

## Context
Agents are still being instructed to run the `herd` binary directly from the `/herd` skill. Some of those examples are stale, including legacy top-level commands like `list agents`. The binary currently opens the GUI whenever extra args are present but do not match a recognized CLI group, so a mistaken agent invocation can open a second Herd window instead of failing fast.

## Goals
- Make Herd-managed agents use MCP/socket tools instead of shelling out to the `herd` CLI.
- Make invalid `herd ...` invocations fail with a CLI error instead of launching the GUI.
- Preserve normal GUI startup for real GUI launches.

## Non-goals
- Remove the user-facing CLI from the product.
- Change the MCP tool surface itself.
- Add compatibility aliases for stale CLI commands.

## Scope
- Rewrite `.claude/skills/herd/SKILL.md` to be MCP/socket-only.
- Tighten entrypoint classification so unknown argument-based launches are treated as CLI attempts and fail.
- Add/adjust tests for the new invocation behavior.

## Risks and mitigations
- Risk: macOS GUI launches may include special launcher args.
  - Mitigation: explicitly preserve known GUI launch args such as `-psn_*`.
- Risk: stale docs or prompts may continue teaching CLI usage.
  - Mitigation: remove CLI guidance from the Herd skill in the same change.

## Acceptance criteria
- `/herd` no longer instructs agents to use `HERD_BIN`, `--agent-pid`, or CLI commands.
- `herd --agent-pid 123 list agents` returns an error and does not fall through to GUI startup.
- Standard GUI launch with no extra args still starts the app.
- Targeted tests covering invocation classification pass.

## Phased Plan (Red/Green)

### Phase 0
Objective: stop invalid argument-based `herd` launches from opening the GUI.

Red:
- Add unit tests for GUI-launch arg preservation and for legacy `list agents` being treated as a CLI path rather than a GUI path.
- Expected failure signal: the new tests fail because current logic only treats recognized CLI groups as CLI invocations.

Green:
- Add explicit GUI-launch-arg detection.
- Route all other non-empty arg invocations through `cli::run(...)` so unknown command groups fail normally.
- Verification commands:
  - `cargo test --manifest-path src-tauri/Cargo.toml cli::tests`

Exit criteria:
- Unknown argument-based invocations now fail with CLI errors.
- GUI launch remains available for no-arg and known GUI-launch-arg starts.

### Phase 1
Objective: stop teaching agents to use the CLI.

Red:
- Confirm the current `/herd` skill still contains CLI-specific guidance such as `HERD_BIN`, `--agent-pid`, and shell command examples.
- Expected failure signal: grep finds those stale CLI instructions.

Green:
- Rewrite `.claude/skills/herd/SKILL.md` so it instructs agents to use MCP/socket tools only.
- Remove CLI examples, `sudo`, worker `browser drive`, and stale top-level `list ...` guidance.
- Verification commands:
  - `rg -n "HERD_BIN|--agent-pid|Use the Herd CLI|sudo|list agents|browser drive %|shell spawn" .claude/skills/herd/SKILL.md`

Exit criteria:
- The Herd skill is MCP/socket-only and matches the current tool model.

## Execution Checklist
- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log
1. `sed -n '1,220p' .claude/skills/herd/SKILL.md`
   - result: `pass`
   - notes: confirmed current skill still teaches CLI usage and stale `list ...` commands.
2. `sed -n '1,220p' src-tauri/src/cli.rs`
   - result: `pass`
   - notes: confirmed CLI detection only recognizes known command groups and otherwise falls through.
3. `cargo test --manifest-path src-tauri/Cargo.toml cli::tests -- --nocapture`
   - result: `pass`
   - notes: targeted CLI tests passed, including the new invocation classification cases.
4. `src-tauri/target/debug/herd --agent-pid 4242 list agents`
   - result: `pass`
   - notes: exits with `unknown command group: list` instead of launching the GUI.
5. `rg -n '"\$HERD_BIN"|--agent-pid|Use the Herd CLI|MCP/CLI|browser drive %|shell spawn' .claude/skills/herd/SKILL.md .claude/roles/root/CLAUDE.md .claude/roles/worker/CLAUDE.md -S`
   - result: `pass`
   - notes: no stale CLI-oriented prompt text remains in the agent-facing prompts checked here.
6. `git diff --check`
   - result: `pass`
   - notes: no whitespace or patch hygiene issues.
