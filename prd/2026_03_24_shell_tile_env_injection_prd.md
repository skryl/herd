# Shell Tile Env Injection PRD

Status: Completed
Date: 2026-03-24

## Context

In a Herd-managed shell tile, `HERD_SOCK` is present but `HERD_TILE_ID` is empty. That breaks local-network shell usage because the CLI can connect to the socket but cannot identify the sending tile automatically.

The current shell launch paths only inject `HERD_SOCK`. `HERD_TILE_ID` is only injected in the agent respawn path, so ordinary shell windows and shell respawns come up without the tile identity env.

## Goals

- Ensure Herd-managed shell tiles always receive `HERD_TILE_ID`.
- Preserve the existing `HERD_SOCK` injection behavior.
- Cover shell creation and shell respawn behavior with regression tests.

## Non-Goals

- Changing CLI fallback semantics when `HERD_TILE_ID` is missing.
- Changing agent tile env handling.

## Scope

- `src-tauri/src/commands.rs`
- `src-tauri/src/tmux_state.rs`
- Focused tests for shell env injection

## Risks And Mitigations

- Risk: shell tiles get a new tile id on respawn.
  Mitigation: resolve or create the tile record before respawn and reuse its stable tile id.
- Risk: fix covers new windows but not last-window respawn.
  Mitigation: patch both shell creation and shell respawn entry points.

## Acceptance Criteria

- A new Herd shell tile has both `HERD_SOCK` and `HERD_TILE_ID`.
- Respawned shell tiles keep the same `HERD_TILE_ID`.
- Targeted tests pass.

## Phased Plan

### Phase 0: Red

Objective: Capture missing shell tile env injection in tests.

Red:
- Add regression coverage for shell launch env generation / shell respawn arguments.
- Expected failure signal:
  - shell launch or respawn args do not contain `HERD_TILE_ID=...`

Green:
- No implementation changes in this phase.

Exit Criteria:
- Regression test exists and fails on current behavior.

### Phase 1: Green

Objective: Inject `HERD_TILE_ID` for shell windows and respawns.

Red:
- Use the failing regression from Phase 0.

Green:
- Resolve/create shell tile records before respawning shell panes.
- Pass `HERD_TILE_ID` through the shell respawn helpers.

Exit Criteria:
- Targeted env injection tests pass.

### Phase 2: Regression Check

Objective: Verify adjacent command tests remain green.

Red:
- N/A

Green:
- Run targeted shell-related Rust tests and a diff sanity check.

Exit Criteria:
- Targeted verification is green and recorded.

## Implementation Checklist

- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Phase 2 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log

1. `cargo test --manifest-path src-tauri/Cargo.toml shell_tile_env`
   - result: replaced
   - notes: verification used narrower unit and integration commands below

2. Manual repro in a live Herd shell tile: `echo \"$HERD_SOCK\"; echo \"$HERD_TILE_ID\"`
   - result: fail
   - notes: `HERD_SOCK` was set while `HERD_TILE_ID` was empty

3. `cargo test --manifest-path src-tauri/Cargo.toml tmux_state::tests::shell_respawn_args_include_socket_and_tile_env`
   - result: pass
   - notes: shell respawn helper now includes both `HERD_SOCK` and `HERD_TILE_ID`

4. `cargo test --manifest-path src-tauri/Cargo.toml commands::tests::shell_launch_command_starts_in_the_requested_directory`
   - result: pass
   - notes: adjacent shell command test remained green after the helper split

5. `npm run test:integration -- tests/integration/test-driver.test.ts -t "injects HERD_TILE_ID into spawned shell tiles"`
   - result: pass
   - notes: root `tile_create shell` path produced matching `HERD_TILE_ID`

6. `npm run test:integration -- tests/integration/test-driver.test.ts -t "injects HERD_TILE_ID into toolbar-spawned shell tiles"`
   - result: pass
   - notes: toolbar `new-shell` path produced matching `HERD_TILE_ID`

7. `git diff --check -- src-tauri/src/commands.rs src-tauri/src/tmux_state.rs src-tauri/src/socket/server.rs tests/integration/test-driver.test.ts prd/2026_03_24_shell_tile_env_injection_prd.md`
   - result: pass
   - notes: no whitespace or patch formatting issues

8. `cargo fmt --manifest-path src-tauri/Cargo.toml`
   - result: skipped
   - notes: `cargo-fmt`/`rustfmt` is not installed for the active toolchain
