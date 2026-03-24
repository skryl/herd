## Title
Network List Sender Metadata And Browser Visibility

## Status
Completed

## Date
2026-03-23

## Context
The current `network_list` payload returns only `session_id`, `tiles`, and `connections`. When an agent receives the component, it has to infer which tile in that graph is the caller. The user also reported that browser tiles connected to agent tiles do not appear reliably in `network_list` from the agent side, so this slice needs a focused regression around agent-to-browser discovery rather than assuming the current coverage is sufficient.

## Goals
- Make `network_list` return explicit sender-tile metadata so callers can identify the tile making the request.
- Add focused regression coverage that an agent caller sees a directly connected browser tile through `network_list`.
- Keep the existing port-aware `responds_to` behavior unchanged.

## Non-goals
- Reworking the network graph model.
- Changing `network_get` or `network_call` request shapes.
- Adding compatibility aliases or duplicate sender fields beyond what is needed for clear discovery.

## Scope
- Rust `NetworkComponent` serialization
- Rust socket `network_list` response shaping
- Shared TypeScript network graph type
- Focused integration assertions

## Risks and mitigations
- Risk: changing the serialized `network_list` shape could break existing callers.
  - Mitigation: make the sender metadata additive and leave existing fields untouched.
- Risk: the reported browser issue could be a caller-side misunderstanding rather than a backend bug.
  - Mitigation: write the exact regression first and let the test signal tell us whether backend behavior is wrong or only the response shape is missing context.

## Acceptance criteria
- `network_list` includes the caller tile id in its serialized payload.
- A worker agent calling `network_list` sees a directly connected browser tile in the returned `tiles` list.
- Existing port-aware `responds_to` expectations still hold.
- Targeted integration and type/build checks pass.

## Phased Plan (Red/Green)

### Phase 0
Objective: Capture the desired discovery contract in tests.

Red:
- Extend the worker network integration to assert:
  - `network_list` includes the caller tile id
  - the worker sees the connected browser tile in the same payload
- Expected failure signal:
  - missing sender metadata
  - browser tile missing from the worker-visible component

Green:
- Implement the minimal response-shape/backend changes needed for the new assertions to pass.

Verification commands:
- `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "enforces worker local-network permissions at the backend"`

Exit criteria:
- The focused worker network assertions pass.

### Phase 1
Objective: Propagate the additive response shape cleanly through shared types and adjacent docs/checks.

Red:
- Run adjacent type/build checks after the backend change and capture any drift.
- Expected failure signal:
  - TypeScript type mismatch for the network graph payload

Green:
- Update shared types/docs for the additive `network_list` sender metadata.

Verification commands:
- `npm run check`
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `git diff --check`

Exit criteria:
- The additive payload shape is reflected in shared types/docs and checks stay green.

## Execution Checklist
- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log
1. `rg -n "network_list|component_for_sender|NetworkComponent|sender_tile_id|browser" src-tauri/src tests/integration -S`
   - result: pass
   - notes: mapped the network discovery and existing browser integration coverage.
2. `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "enforces worker local-network permissions at the backend"`
   - result: fail
   - notes: red signal was the missing `sender_tile_id` field on the `network_list` payload; the connected browser tile was already present in the returned component.
3. `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "enforces worker local-network permissions at the backend"`
   - result: pass
   - notes: `network_list` now returns `sender_tile_id` and the worker-visible component still includes the connected browser tile.
4. `cargo test --manifest-path src-tauri/Cargo.toml network::tests`
   - result: pass
   - notes: adjacent Rust network unit coverage stayed green after the additive response-shape change.
5. `cargo check --manifest-path src-tauri/Cargo.toml`
   - result: pass
   - notes: Rust compile passed with pre-existing dead-code warnings only.
6. `npm run check`
   - result: pass
   - notes: shared TypeScript and Svelte checks passed after updating the network graph type.
7. `git diff --check`
   - result: pass
   - notes: no whitespace or patch-format issues.
8. `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "drives browser tiles through browser_drive"`
   - result: pass
   - notes: browser-filtered worker discovery also returns `sender_tile_id` and still sees the connected browser tile.
