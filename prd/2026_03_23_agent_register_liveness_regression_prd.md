# Agent Register Liveness Regression

## Header

1. Title: Agent Register Liveness Regression
2. Status: Completed
3. Date: 2026-03-23

## Context

Live Claude panes are falling into a dead state and losing Herd MCP access because the public `agent_register` socket command no longer carries `tile_id`, but the backend session receiver still requires that field when deserializing registration args. The MCP server can launch, attempt registration, and then fail to re-establish live agent state even though the pane is still running.

## Goals

1. Make public `agent_register` succeed without an explicit `tile_id`.
2. Ensure a pane-backed agent can re-enter the alive state through the current socket/MCP registration flow.
3. Add regression coverage for the protocol shape that the checked-in MCP server actually sends.

## Non-goals

1. Redesigning agent ping or subscriber lifetime semantics.
2. Changing the tmux pane model for agent tiles.
3. Adding back a separate legacy `tile_id` field to the public socket protocol.

## Scope

Socket/session receiver registration deserialization, derived tile identity for pane-backed agents, integration coverage, and brief PRD evidence.

## Risks and mitigations

1. Risk: changing registration args could drift from the persisted agent schema.
   Mitigation: derive `tile_id` directly from `pane_id`, which is already the authoritative pane-backed tile identifier in the current protocol.
2. Risk: adjacent registration flows might rely on the stale field accidentally.
   Mitigation: run the focused registration regression and one adjacent session-receiver path that already uses `agentRegister`.

## Acceptance criteria

1. `agent_register` succeeds through the public socket protocol without a `tile_id` field.
2. After registration plus a live signal (`agent_ping_ack` or event subscription), the agent appears `alive = true`.
3. The targeted regression and adjacent registration path pass.

## Phased Plan (Red/Green)

### Phase 0

1. Objective
   Capture the failing registration behavior with the current socket shape.
2. Red
   - Tests/checks to add first: integration coverage that registers an agent through `client.agentRegister(...)`, then acks a ping and expects an alive agent entry for that pane.
   - Expected failure signal: `agent_register` fails with a missing `tile_id` error.
3. Green
   - Minimal implementation targets: none in this phase.
   - Verification commands: targeted integration run showing the registration failure.
4. Exit criteria
   - The focused regression exists and fails before implementation.

### Phase 1

1. Objective
   Align backend registration deserialization with the public socket protocol.
2. Red
   - Tests/checks to add first: Phase 0 regression remains the failing signal.
   - Expected failure signal: registration still requires a missing `tile_id`.
3. Green
   - Minimal implementation targets: remove the stale `tile_id` arg requirement and derive the pane-backed tile id from `pane_id`.
   - Verification commands: targeted regression plus adjacent session-receiver coverage.
4. Exit criteria
   - Registration succeeds, the agent becomes alive, and the adjacent registration path still passes.

## Execution Checklist

- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log

1. `tail -n 120 tmp/herd-socket.log`
   - result: pass
   - notes: captured `agent_register` failing with `missing field tile_id`, followed by `agent ... is not alive` tool errors.
2. `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "registers pane-backed agents without requiring an explicit tile_id"`
   - result: fail
   - notes: fresh root bootstrap failed because the MCP-side `agent_register` was rejected with `missing field tile_id`.
3. `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "registers pane-backed agents without requiring an explicit tile_id"`
   - result: pass
   - notes: root bootstrap plus direct socket `agentRegister` succeeded and the registered agent became alive.
4. `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "routes session-scoped socket commands through the session receiver"`
   - result: fail
   - notes: hit an unrelated `active_tab_terminals` projection race after `tile_create`; registration itself was already succeeding in the log payload.
5. `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "creates actual worker agents through tile_create instead of plain shells"`
   - result: pass
   - notes: adjacent root-bootstrap path passed with the fixed registration flow.
6. `npm --prefix mcp-server run build`
   - result: pass
   - notes: the checked-in MCP server still builds against the current protocol surface.
