# Network Call Wire Signal Animation

## Status
In Progress

## Date
2026-03-25

## Context
Herd already renders network wires on the canvas and logs `network_call` activity through tile message logs, but the canvas does not visually react when an agent invokes a network call. The requested behavior is to animate the relevant wires so it looks like a signal flows from the originating tile to the destination tile when an agent makes a network call.

## Goals
- Animate network wires when a `network_call` occurs.
- Make the animation originate at the caller tile and flow toward the destination tile.
- Support multi-hop local-network routes by animating each wire segment in sequence.
- Drive the effect from real `network_call` log entries instead of ad hoc frontend timers.

## Non-goals
- Animating direct messages, public chatter, or non-network tile calls.
- Changing the network permission model or local-network visibility rules.
- Reworking static wire routing or port placement.

## Scope
- Frontend signal derivation from `tile_message_logs` and active network graph state.
- Canvas SVG overlay for temporary wire pulse visuals.
- Focused unit coverage for route-to-signal derivation.
- Focused integration coverage that verifies the pulse appears after a real `network_call`.

## Risks And Mitigations
- `network_call` can target any tile in the visible connected component, not only a directly adjacent tile.
  - Mitigation: compute the shortest connection route through the current network graph and animate hop-by-hop.
- Historical logs could cause stale animations when a session first loads.
  - Mitigation: only animate logs observed after the current session becomes visible in the mounted canvas.
- Overlay animation could fight existing pan/zoom behavior or clutter browser/webview layering.
  - Mitigation: render the signal in the existing network SVG inside `.canvas-world`, separate from browser webview overlays.

## Acceptance Criteria
- A successful `network_call` produces a visible temporary wire pulse on the canvas.
- The pulse flows from caller tile to destination tile.
- Multi-hop `network_call` traffic animates along the actual wire route in hop order.
- The effect is driven from `network_call` message-log entries and does not animate on stale pre-existing history when first viewing a session.

## Phase 0
### Objective
Lock the route-derivation contract and visible pulse behavior with failing coverage.

### Red
- Add/update tests that expect:
  - route-based signal segments to be derived from `network_call` tile message logs
  - multi-hop signals to produce more than one ordered segment
  - the canvas DOM to show a temporary signal overlay after a real `network_call`

### Expected Failure Signal
- No signal-derivation helper exists, and the canvas never renders a network-call pulse.

### Green
- Add the tests and confirm they fail specifically because the animation path is missing.

### Verification Commands
- `npm run test:unit -- --run src/lib/stores/appState.test.ts`
- `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "animates network wires after a network_call"`

### Exit Criteria
- Tests fail because signal derivation and DOM pulse rendering do not exist yet.

## Phase 1
### Objective
Implement route-aware signal derivation and canvas rendering.

### Red
- Re-run the focused unit/integration tests after the helper and overlay plumbing is in place.

### Expected Failure Signal
- Type or behavior mismatches around signal timing, route direction, or canvas rendering.

### Green
- Derive temporary network-call signal segments from new `network_call` logs.
- Animate the matching wire paths and a moving signal marker across each routed segment.

### Verification Commands
- `npm run test:unit -- --run src/lib/stores/appState.test.ts`
- `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "animates network wires after a network_call"`
- `npm run check`

### Exit Criteria
- The pulse appears on real `network_call` activity and the focused checks pass.

## Execution Checklist
- [ ] Phase 0 complete
- [ ] Phase 1 complete
- [ ] Integration/regression checks complete
- [ ] Documentation/status updated

## Command Log
1. `sed -n '1,220p' /Users/skryl/.codex/skills/phased-prd-red-green/SKILL.md`
   - result: pass
   - notes: loaded the required phased PRD workflow.
2. `sed -n '1,260p' /Users/skryl/.codex/skills/phased-prd-red-green/references/prd_red_green_template.md`
   - result: pass
   - notes: loaded the PRD template.
3. `rg -n "buildRenderedNetworkConnections|wire|network_call|tile_message_logs|wrapper_command" src src-tauri/src tests/integration -S`
   - result: pass
   - notes: traced the current wire rendering and network-call logging surfaces.
