# Socket Cleanup Ownership PRD

Status: Completed
Date: 2026-03-24

## Context

`herd network list` fails against a live Herd session with:

`failed to connect to Herd socket at /tmp/herd.sock: No such file or directory (os error 2)`

The live `target/debug/herd` process still has a listener bound to `/tmp/herd.sock`, but the filesystem entry can disappear. The current socket server startup and shutdown code both unconditionally remove `runtime::socket_path()`. That allows an older Herd process to unlink a newer process's live socket pathname during exit.

## Goals

- Prevent one Herd process from removing another live Herd process's Unix socket path.
- Preserve the existing single-path CLI contract for the active runtime.
- Add regression coverage for owned cleanup vs replaced socket path.

## Non-Goals

- Redesign multi-instance Herd runtime coordination.
- Change the CLI socket selection behavior.
- Add cross-process lock files or PID registries.

## Scope

- `src-tauri/src/socket/server.rs`
- Focused Rust tests in the same module
- PRD and command log updates

## Risks And Mitigations

- Risk: cleanup stops removing stale paths on normal shutdown.
  Mitigation: only skip unlink when the current path no longer matches the bound entry; owned-path cleanup still removes the exact socket entry this process created.
- Risk: metadata identity is not stable enough across replacements.
  Mitigation: compare device and inode from the filesystem entry recorded immediately after bind.

## Acceptance Criteria

- A process records the identity of the socket path it bound.
- Cleanup removes the socket path only when the current filesystem entry still matches that recorded identity.
- Replaced-path cleanup leaves the replacement entry intact.
- Targeted Rust tests pass.

## Phased Plan

### Phase 0: Red

Objective: Capture the cleanup ownership race in focused tests.

Red:
- Add tests for:
  - cleanup removes the owned path
  - cleanup does not remove a replacement path with different identity
- Expected failure signal:
  - replacement-path test fails because cleanup unlinks the new entry

Green:
- No implementation changes in this phase.

Exit Criteria:
- Regression test exists and fails on current behavior.

### Phase 1: Green

Objective: Make cleanup ownership-aware.

Red:
- Use the failing regression from Phase 0.

Green:
- Record the bound socket path identity after successful bind.
- Make cleanup compare the current path identity against the recorded one before unlinking.
- Clear the recorded identity after cleanup.

Verification Commands:
- `cargo test --manifest-path src-tauri/Cargo.toml socket::server::tests::cleanup_removes_only_owned_socket_path`
- `cargo test --manifest-path src-tauri/Cargo.toml socket::server::tests::cleanup_removes_recorded_socket_path`

Exit Criteria:
- Both targeted tests pass.

### Phase 2: Regression Check

Objective: Confirm no adjacent socket server regressions in targeted verification.

Red:
- N/A

Green:
- Run an adjacent server test slice or `cargo test` with the socket server module filter.

Exit Criteria:
- Targeted verification is green and recorded.

## Implementation Checklist

- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Phase 2 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log

1. `cargo test --manifest-path src-tauri/Cargo.toml socket::server::tests::cleanup_removes_only_owned_socket_path`
   - result: fail, then pass
   - notes: red signal was `cleanup removed the replacement socket path`; passed after recording and comparing socket path identity

2. `cargo test --manifest-path src-tauri/Cargo.toml socket::server::tests::cleanup_removes_recorded_socket_path`
   - result: pass
   - notes: owned socket path cleanup still removes the bound entry

3. `cargo test --manifest-path src-tauri/Cargo.toml socket::server::tests::welcome_messages_reference_role_specific_skills`
   - result: pass
   - notes: adjacent socket server unit test remained green

4. `cargo test --manifest-path src-tauri/Cargo.toml socket::server::tests::`
   - result: pass
   - notes: socket server test slice passed, `3 passed`

5. `git diff --check -- src-tauri/src/socket/server.rs prd/2026_03_24_socket_cleanup_ownership_prd.md`
   - result: pass
   - notes: no whitespace or patch formatting issues

6. `cargo fmt --manifest-path src-tauri/Cargo.toml`
   - result: skipped
   - notes: `cargo-fmt`/`rustfmt` is not installed for the active toolchain

7. `herd network list`
   - result: pass
   - notes: the live app recreated `/tmp/herd.sock` and the CLI connected successfully again
