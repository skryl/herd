# Default Obstacle-Aware Wire Routing

## Status
Completed

## Date
2026-03-24

## Context
Herd currently uses ELK only for tile arrangement. Network wires are still rendered as local cubic Bezier curves, so they do not honor tile obstacles after manual movement and can visibly run across or under other components.

The original goal was to use ELK alone for wire routing as well. That is not achievable in the current browser runtime:

- `elkjs` does not include `org.eclipse.elk.alg.libavoid` in its transpiled worker.
- Upstream ELK `libavoid` is not a pure browser algorithm; it wraps an external `libavoid-server` binary and is not directly embeddable into the frontend bundle used by Herd.

The practical browser-side way to get fixed-node, side-aware, obstacle-avoiding routes is to replace the current custom curve generator with `libavoid-js`, a WASM port of libavoid, while keeping ELK for tile arrangement.

Follow-up requirement:

- use orthogonal obstacle-aware waypoints again,
- but render the resulting waypoint chain as a smooth cubic Bezier SVG path instead of a hard-edged orthogonal polyline.

## Goals
- Replace the default rendered network wire geometry with obstacle-aware routed paths.
- Keep routing side-aware for Herd ports (`left`, `top`, `right`, `bottom`).
- Recompute routes from current tile positions regardless of the current arrangement mode.
- Remove the old cubic-network-wire path generation in the same change.
- Make the routed geometry observable in tests and the test-driver projection.
- Render smooth cubic Bezier curves from router-produced orthogonal waypoints instead of displaying the raw waypoint polyline.

## Non-goals
- Replacing ELK tile arrangement.
- Adding new socket or MCP APIs.
- Reworking the transient drag/release draft line visuals.
- Solving parent/child tmux lineage connector routing unless it naturally falls out of the same implementation.

## Scope
- Frontend dependency and router initialization.
- Network wire data model in app state and test projection.
- Canvas rendering for routed network paths.
- Frontend tests proving routed-path output and removal of the old cubic network-wire path.

## Risks and mitigations
- WASM load timing could break synchronous store consumers.
  - Mitigation: initialize the router at module load and keep exported routing functions synchronous after module resolution completes.
- The new router may need explicit connection pins per side.
  - Mitigation: create one pin per tile side and map Herd ports directly to those pins.
- Bundle/runtime path resolution for the WASM asset may fail in Vite or Vitest.
  - Mitigation: load the asset through Vite-managed URL resolution and verify in targeted tests.
- Changing the projected wire shape could affect test-driver consumers.
  - Mitigation: update projection types and keep the new payload additive enough for current tests to assert on path/points.

## Acceptance criteria
- Visible network wires no longer use the old freeform cubic-control-point model.
- Routed network paths change when tiles move, without requiring ELK arrangement mode.
- Routing honors port sides and avoids an obstacle tile in targeted tests.
- The old network connector control-point fields are removed from the rendered network wire model.
- Rendered paths contain cubic Bezier curve commands derived from orthogonal waypoints.
- Targeted frontend tests and `npm run check` pass.

## Phased Plan

### Phase 0
#### Objective
Document the routing change and capture the implementation constraint before code changes.

#### Red
- Create this PRD with the browser-runtime constraint and delivery plan.
- Expected failure signal:
  - none; documentation/setup phase.

#### Green
- Commit the PRD and track progress against it.
- Verification commands:
  - `test -f prd/2026_03_24_default_libavoid_wire_routing_prd.md`

#### Exit criteria
- PRD exists with explicit goals, non-goals, risks, and red/green phases.

### Phase 1
#### Objective
Add failing tests that prove network wires still use the old cubic geometry and do not expose routed points/path data.

#### Red
- Update frontend tests to expect:
  - a routed path string for network wires,
  - routed point lists,
  - no `cx1/cy1/cx2/cy2` assertions for network wires,
  - obstacle-aware bend points in a blocking-layout case.
- Expected failure signal:
  - current tests fail because `buildRenderedNetworkConnections` only returns Bezier control points.

#### Green
- Land the smallest test updates that fail against the current implementation.
- Verification commands:
  - `npx vitest run src/lib/stores/appState.test.ts -t "routes network wires"`

#### Exit criteria
- At least one targeted test is red specifically because network wires are still curve-based.

### Phase 2
#### Objective
Implement the new default routed-wire engine and update canvas rendering.

#### Red
- Keep the Phase 1 routing tests red while wiring in the new dependency and data model.
- Expected failure signal:
  - tests continue to fail until routed point generation and rendering are in place.

#### Green
- Add `libavoid-js`.
- Initialize the router in the frontend runtime.
- Replace the old network-wire curve model with routed points and SVG path data.
- Update Canvas rendering and test projection output.
- Remove the old Bezier-based network-wire fields from the rendered network-wire model.
- Verification commands:
  - `npx vitest run src/lib/stores/appState.test.ts`
  - `npm run check`

#### Exit criteria
- Network wires are rendered from routed polyline/orthogonal paths and targeted frontend tests pass.

### Phase 3
#### Objective
Run regressions and close the PRD.

#### Red
- Run adjacent checks to catch projection/type regressions.
- Expected failure signal:
  - any type or test-driver breakage from the wire-model change.

#### Green
- Fix adjacent regressions.
- Update this PRD to `Completed`.
- Verification commands:
  - `npx vitest run src/lib/stores/appState.test.ts src/lib/appEvents.test.ts src/lib/interaction/keyboard.test.ts`
  - `npm run check`
  - `git diff --check`

#### Exit criteria
- Targeted regressions are green and the PRD status is updated.

## Implementation Checklist
- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Phase 2 complete
- [x] Phase 3 complete
- [x] Documentation/status updated

## Command Log
1. `node` experiments against `elkjs`
   - result: `fail`
   - notes: `layered` produced edge sections but moved nodes; `fixed` did not compute routes.
2. `git clone https://github.com/eclipse/elk`
   - result: `pass`
   - notes: confirmed upstream `org.eclipse.elk.alg.libavoid` depends on `libavoid-server`.
3. `npm view libavoid-js`
   - result: `pass`
   - notes: found a browser-side WASM port suitable for fixed-node obstacle-aware routing.
4. `npx vitest run src/lib/stores/appState.test.ts -t "network connectors|buildCanvasConnections"`
   - result: `pass`
   - notes: routed network and lineage wire tests are green, including obstacle avoidance around a blocking tile.
5. `npx vitest run src/lib/stores/appState.test.ts src/lib/appEvents.test.ts src/lib/interaction/keyboard.test.ts`
   - result: `pass`
   - notes: targeted frontend regression sweep passed.
6. `npm run check`
   - result: `pass`
   - notes: Svelte and TypeScript checks are green after the wire-model change.
7. `git diff --check`
   - result: `pass`
   - notes: no whitespace or patch formatting issues.
8. `npx vitest run src/lib/stores/appState.test.ts -t "curved rendered paths|buildCanvasConnections"`
   - result: `pass`
   - notes: orthogonal waypoints now render as rounded SVG paths in the targeted bend cases.
9. `npx vitest run src/lib/stores/appState.test.ts src/lib/appEvents.test.ts src/lib/interaction/keyboard.test.ts`
   - result: `pass`
   - notes: frontend regression sweep stayed green after switching back to orthogonal routing.
10. `npm run check`
    - result: `pass`
    - notes: Svelte and TypeScript checks stayed green after the rounded-path rendering change.
