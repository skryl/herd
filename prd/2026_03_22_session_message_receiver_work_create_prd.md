# Session Message Receiver For Work Create PRD

## Status

Completed

## Date

2026-03-22

## Context

Herd already routes tile-instance work commands through the tile message receiver path, but `work_create` is still a direct closure inside the socket handler. The intended boundary is now clearer: the tile message bus is for concrete tile instances only, while session-scoped commands should still use the shared message-delivery layer by targeting a session receiver rather than a tile receiver.

## Goals

1. Add a session receiver abstraction to the shared message-delivery layer.
2. Route `work_create` through that session receiver instead of dispatching inline from the socket handler.
3. Preserve the existing `work_create` command shape, permissions, payload, and side effects.
4. Record `work_create` delivery as a structured log entry targeting the session instance.

## Non-goals

1. Moving other session-scoped commands onto the session receiver in this slice.
2. Changing the public socket, CLI, or MCP command names.
3. Reworking tile-instance receiver behavior.

## Scope

1. `src-tauri/src/socket/server.rs`
2. `tests/integration/work-registry.test.ts`
3. `docs/socket-and-test-driver.md`

## Risks And Mitigations

1. The new session receiver could blur the tile/session boundary again.
   - Mitigation: keep the receiver narrow and only advertise `work_create`.
2. `work_create` logging could become inconsistent with existing tile-message logs.
   - Mitigation: reuse `dispatch_with_log` and set `target_kind = "session"` explicitly.
3. The integration test might only validate the happy path payload and miss the new routing target.
   - Mitigation: assert `wrapper_command`, `message_name`, `target_kind`, and `target_id`.

## Acceptance Criteria

1. `work_create` is dispatched through a session receiver with `.send(...)`.
2. The session receiver is a distinct target from tile receivers and only handles session-scoped messages in this slice.
3. `work_create` still returns the same work item payload and still emits topic/debug/work update side effects.
4. Integration coverage proves the message log entry for `work_create` targets the session instance.

## Phased Plan

### Phase 1: Red

#### Objective

Make the missing session-receiver routing observable in tests and docs.

#### Red

1. Add a failing integration expectation that `work_create` logs as a session-targeted message delivery.
2. Update the socket docs to describe the intended session-receiver behavior for `work_create`.

Expected failure signal:
- `work_create` has no session-targeted message log entry
- docs overstate that only tile receivers are involved for work commands

#### Green

1. Add a dedicated `SessionMessageReceiver`.
2. Route `work_create` through `dispatch_with_log(... || receiver.send(...))`.
3. Preserve the current permission check and work side effects.

Verification commands:
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `npm run check`
- `npm run test:integration -- tests/integration/work-registry.test.ts -t "derives owner-only work updates from the port graph and enforces the full stage review lifecycle"`

#### Exit Criteria

1. `work_create` is no longer an inline direct socket dispatch.
2. The targeted integration test passes with a session-targeted log assertion.

## Execution Checklist

- [x] PRD saved
- [x] Phase 1 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log

1. `sed -n '1,220p' /Users/skryl/.codex/skills/phased-prd-red-green/SKILL.md`
   - result: pass
   - notes: confirmed the required PRD and red/green workflow
2. `sed -n '1320,1775p' src-tauri/src/socket/server.rs`
   - result: pass
   - notes: confirmed the existing tile receiver path and the absence of a session receiver
3. `sed -n '3685,3815p' src-tauri/src/socket/server.rs`
   - result: pass
   - notes: confirmed `work_create` still dispatches inline
4. `cargo check --manifest-path src-tauri/Cargo.toml`
   - result: pass
   - notes: verified the session receiver refactor compiled cleanly with only pre-existing warnings
5. `npm run check`
   - result: pass
   - notes: verified the updated integration test and type surface
6. `npm run test:integration -- tests/integration/work-registry.test.ts -t "derives owner-only work updates from the port graph and enforces the full stage review lifecycle"`
   - result: pass
   - notes: verified `work_create` logs as a session-targeted message while later work mutations still target the work tile
7. `git diff --check`
   - result: pass
   - notes: confirmed patch hygiene
