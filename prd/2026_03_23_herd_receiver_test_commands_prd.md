## Title
Herd Receiver For Test Socket Commands

## Status
Completed

## Date
2026-03-23

## Context
The socket command model now separates session-scoped and tile-instance message delivery, but the test/debug commands still bypass receivers and log directly as `target_kind = test_driver`. The remaining gap is limited to the non-streaming `test_*` commands. The user explicitly does not want `agent_events_subscribe` moved in this pass.

## Goals
- Add a dedicated herd-level receiver for the test/debug socket commands.
- Route `test_driver`, `test_dom_query`, and `test_dom_keys` through that receiver.
- Make the structured message log identify those deliveries as targeting the herd receiver.

## Non-goals
- Moving `agent_events_subscribe` off its dedicated streaming path.
- Renaming the public `test_*` socket commands.
- Reworking the test driver request surface itself.

## Scope
- Rust socket server receiver/dispatch code
- Focused integration coverage for log routing
- Focused docs/status updates where the receiver model is described

## Risks and mitigations
- Risk: changing the log target metadata could break existing assertions.
  - Mitigation: add the focused integration check first and update only the intended log expectations.
- Risk: test-driver request handling could regress if the receiver refactor changes payload parsing.
  - Mitigation: keep the existing request execution logic intact and move only the dispatch boundary.

## Acceptance criteria
- `test_driver`, `test_dom_query`, and `test_dom_keys` route through a `HerdMessageReceiver`.
- Structured message logs for those commands use `target_kind = herd`.
- `agent_events_subscribe` remains on its current dedicated streaming path.
- Focused integration and Rust checks pass.

## Phased Plan (Red/Green)

### Phase 0
Objective: Capture the new herd-receiver routing in a focused failing check.

Red:
- Add an integration test that issues `test_driver`, `test_dom_query`, and `test_dom_keys` commands and waits for `tile_message_logs` entries with `target_kind = herd`.
- Expected failure signal:
  - log entries still show `target_kind = test_driver`

Green:
- Keep the new test in place and move the test/debug command arms behind a herd receiver so the log entries turn green.

Verification commands:
- `npm run test:integration -- tests/integration/test-driver.test.ts -t "routes test socket commands through the herd receiver"`

Exit criteria:
- The focused integration check passes with herd-targeted log entries for all three commands.

### Phase 1
Objective: Refactor the server dispatch path to use a dedicated herd receiver without changing the public API.

Red:
- Run a focused Rust check after the routing change and capture any compile errors from the new receiver/helper.
- Expected failure signal:
  - missing receiver wiring or type mismatches in socket dispatch

Green:
- Add `HerdMessageReceiver`.
- Route `test_driver`, `test_dom_query`, and `test_dom_keys` through it.
- Update the receiver-model docs to mention herd-scoped test/debug commands.

Verification commands:
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `npm run check`
- `npm run test:integration -- tests/integration/test-driver.test.ts -t "routes test socket commands through the herd receiver"`
- `git diff --check`

Exit criteria:
- The receiver-based implementation compiles, the focused checks pass, and the docs match the new routing.

## Execution Checklist
- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log
1. `npm run test:integration -- tests/integration/test-driver.test.ts -t "routes test socket commands through the herd receiver"`
   - result: fail
   - notes: red phase failed as expected because the log entries still used `target_kind = test_driver` instead of `herd`.
2. `cargo check --manifest-path src-tauri/Cargo.toml`
   - result: pass
   - notes: green compile check passed with pre-existing dead-code warnings only.
3. `npm run test:integration -- tests/integration/test-driver.test.ts -t "routes test socket commands through the herd receiver"`
   - result: pass
   - notes: green after routing `test_driver`, `test_dom_query`, and `test_dom_keys` through the herd receiver.
4. `npm run check`
   - result: pass
   - notes: shared frontend/type checks stayed green after the routing change.
5. `git diff --check`
   - result: pass
   - notes: no whitespace or patch-format issues.
