# Session Receiver Expansion PRD

## Status

Completed

## Date

2026-03-22

## Context

Herd now has a shared message-delivery layer with tile receivers for tile-instance commands and a minimal session receiver for `work_create`. A large set of session-scoped socket commands still dispatch inline from the socket handler instead of being delivered to the session instance. The next step is to move those session-scoped commands onto the session receiver so the socket layer consistently resolves the target session, builds the message envelope, and hands delivery to the session receiver.

## Goals

1. Route the remaining session-scoped socket commands through `SessionMessageReceiver.send(...)`.
2. Keep tile-instance commands on tile receivers and do not collapse them into the session receiver.
3. Preserve the public socket/CLI/MCP command surface and existing behaviors.
4. Make the resulting tile message logs show these commands as `target_kind = "session"` with the session id as the target.

## Non-goals

1. Moving `agent_events_subscribe` onto the session receiver.
2. Changing worker/root permission boundaries.
3. Refactoring tile-instance commands away from tile receivers.

## Scope

1. `src-tauri/src/socket/server.rs`
2. `tests/integration/worker-root-mcp.test.ts`
3. `docs/socket-and-test-driver.md`

## Risks And Mitigations

1. The session receiver could become a second socket handler with too much direct parsing logic.
   - Mitigation: keep parsing confined to typed message-arg structs and remove the old inline socket closures in the same change.
2. Log target metadata could regress for existing commands.
   - Mitigation: add an integration assertion that multiple session-scoped wrappers now log with `target_kind = "session"` and `target_id = session_id`.
3. Message delivery commands could accidentally lose sender/session context.
   - Mitigation: let the session receiver carry the resolved `SenderContext` when needed and reuse the existing helper functions for direct/public/network/root delivery.

## Acceptance Criteria

1. The following commands dispatch through the session receiver: `shell_create`, `browser_create`, `agent_create`, `agent_register`, `agent_unregister`, `agent_ping_ack`, `agent_log_append`, `topics_list`, `network_list`, `session_list`, `network_connect`, `network_disconnect`, `message_direct`, `message_public`, `message_network`, `message_root`, `topic_subscribe`, `topic_unsubscribe`, and existing `work_create`.
2. Their socket arms no longer contain the old inline business-logic closures.
3. Focused integration coverage proves a representative set of these wrappers log as session-targeted deliveries.
4. Existing targeted compile/type/integration checks are green.

## Phased Plan

### Phase 1: Red

#### Objective

Make the missing session-receiver routing observable and define the target command set.

#### Red

1. Add a focused integration expectation that representative session-scoped wrapper commands log with `target_kind = "session"`.
2. Update the docs to describe that session-scoped network/message/topic/registry commands route through the session receiver.

Expected failure signal:
- the expected wrapper commands do not produce session-targeted log entries
- docs still describe them only as generic message-delivery without the session receiver distinction

#### Green

1. Expand `SessionMessageReceiver` to support the full session-scoped command set for this slice.
2. Add a small helper so socket arms resolve context, build args, and call `receiver.send(...)`.
3. Remove the replaced inline closures from the socket dispatch arms.

Verification commands:
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `npm run check`
- `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "routes session-scoped socket commands through the session receiver"`
- `npm run test:integration -- tests/integration/work-registry.test.ts -t "derives owner-only work updates from the port graph and enforces the full stage review lifecycle"`

#### Exit Criteria

1. The targeted session-scoped commands only dispatch through the session receiver.
2. The focused integration assertions pass.

## Execution Checklist

- [x] PRD saved
- [x] Phase 1 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log

1. `sed -n '2415,3735p' src-tauri/src/socket/server.rs`
   - result: pass
   - notes: mapped the remaining direct session-scoped socket handlers
2. `sed -n '2890,3075p' src-tauri/src/socket/server.rs`
   - result: pass
   - notes: captured the agent/topic/list direct handlers that still bypass the session receiver
3. `sed -n '3075,3515p' src-tauri/src/socket/server.rs`
   - result: pass
   - notes: captured the session/network direct handlers that still bypass the session receiver
4. `sed -n '3515,3745p' src-tauri/src/socket/server.rs`
   - result: pass
   - notes: captured the message/topic direct handlers that still bypass the session receiver
5. `cargo check --manifest-path src-tauri/Cargo.toml`
   - result: pass
   - notes: verified the expanded session receiver refactor compiled with only pre-existing warnings
6. `npm run check`
   - result: pass
   - notes: verified the app/frontend TypeScript surface after the routing refactor
7. `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "routes session-scoped socket commands through the session receiver"`
   - result: pass
   - notes: verified representative create/registry/topic/network/message wrappers now log as session-targeted deliveries
8. `npm run test:integration -- tests/integration/work-registry.test.ts -t "derives owner-only work updates from the port graph and enforces the full stage review lifecycle"`
   - result: pass
   - notes: verified `work_create` still routes through the session receiver while work tile mutations continue to use the work tile receiver
9. `git diff --check`
   - result: pass
   - notes: confirmed patch hygiene
