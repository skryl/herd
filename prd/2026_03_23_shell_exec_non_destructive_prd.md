# Shell Exec Non-Destructive Delivery

## Header

1. Title: Shell Exec Non-Destructive Delivery
2. Status: Completed
3. Date: 2026-03-23

## Context

`network_call` currently exposes shell action `exec`, and that action routes to `respawn-pane -k`. For a connected worker, using `network_call` to "run a command" on a visible shell replaces the pane process instead of submitting a command into the existing shell. That kills the target shell's live process and breaks agent-to-shell workflows.

## Goals

1. Make shell `exec` run a command inside the existing pane without respawning the pane process.
2. Preserve shell usability after `network_call(..., "exec")` so later reads and writes still work on the same tile.
3. Update docs and tool wording so the public behavior matches the implementation.

## Non-goals

1. Reworking internal pane respawn helpers used for tile or agent bootstrap.
2. Changing browser or work tile call behavior.
3. Adding a second compatibility command for the old destructive shell-exec path.

## Scope

Backend shell tile message handling, worker/root docs, MCP tool wording, and integration coverage for worker `network_call` shell execution.

## Risks and mitigations

1. Risk: changing `exec` semantics could silently break code relying on destructive respawn behavior.
   Mitigation: scope the change to shell command execution semantics only, add an integration test covering continued shell reuse, and update docs immediately.
2. Risk: command submission may fail to terminate if the caller omits a newline.
   Mitigation: append a trailing newline when `exec` submits the command to the pane.

## Acceptance criteria

1. `network_call(shell, "exec", { command })` prints command output and leaves the target shell usable for a later `input_send`.
2. No public docs still describe `shell_exec` or shell `exec` as a pane respawn path.
3. Targeted integration coverage passes.

## Phased Plan (Red/Green)

### Phase 0

1. Objective
   Add a regression test that demonstrates the current shell-destroying behavior.
2. Red
   - Tests/checks to add first: worker integration coverage that uses `network_call(..., "exec")`, then `input_send`, and expects both outputs from the same shell tile.
   - Expected failure signal: post-`exec` shell interaction fails or never produces the second marker because the pane process was replaced.
3. Green
   - Minimal implementation targets: none in this phase.
   - Verification commands: targeted integration test run showing the new assertion fails before implementation.
4. Exit criteria
   - A targeted test exists and fails against current behavior.

### Phase 1

1. Objective
   Replace destructive shell exec routing with non-destructive command submission and align docs/tool wording.
2. Red
   - Tests/checks to add first: Phase 0 test remains the failing signal.
   - Expected failure signal: shell pane still dies or becomes unusable after `exec`.
3. Green
   - Minimal implementation targets: submit shell `exec` through tmux input with a guaranteed trailing newline, keep pane identity stable, and update public descriptions.
   - Verification commands: targeted integration test plus adjacent MCP/unit checks.
4. Exit criteria
   - The new integration test passes, adjacent checks pass, and docs describe the new behavior accurately.

## Execution Checklist

- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log

1. `rg -n "network_call|shell_exec|respawn_pane_shell_command|exec" ...`
   - result: pass
   - notes: confirmed shell `exec` routes to `respawn-pane -k`.
2. `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "enforces worker local-network permissions at the backend"`
   - result: fail
   - notes: new regression failed after shell `exec`; the target shell lost normal pane-backed behavior.
3. `cargo fmt --manifest-path src-tauri/Cargo.toml`
   - result: fail
   - notes: skipped because `cargo-fmt` / `rustfmt` is not installed in the active toolchain.
4. `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "enforces worker local-network permissions at the backend"`
   - result: pass
   - notes: worker `network_call(..., "exec")` now leaves the shell usable for a later `input_send`.
5. `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "allows shared shell access from multiple workers on one local network"`
   - result: pass
   - notes: adjacent shared-shell worker access still passes.
6. `npm --prefix mcp-server run build`
   - result: pass
   - notes: MCP server TypeScript build passed after tool-description updates.
