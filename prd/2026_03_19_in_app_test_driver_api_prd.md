# Herd In-App Test Driver API PRD

## Status

Completed

## Date

2026-03-19

## Summary

Add a first-class in-app test driver to Herd so integration tests can drive the live Tauri app without WebDriver, headless browser automation, or brittle DOM scraping. The driver must be exposed over Herd's existing Unix socket protocol and must operate on typed semantic actions plus state-tree inspection rather than arbitrary JS execution.

The new test model should be:

1. Launch Herd in an isolated test runtime
2. Wait for the app and frontend driver to become ready
3. Drive the app through a typed `test_driver` socket API
4. Assert against the root `AppStateTree` and a compact derived projection
5. Shut the app down and clean up its isolated tmux/socket runtime

The current DOM helpers should remain available only for debugging, renamed to:

1. `test_dom_query`
2. `test_dom_keys`

They are not the supported integration-test surface.

## Context

Herd already contains the beginnings of an in-app test path:

1. The app exposes a local socket at `/tmp/herd.sock`
2. The current `test-e2e.ts` script drives the live app through that socket
3. The frontend already has a single `AppStateTree` that is suitable for state-based assertions

But the current integration path is fragile:

1. `dom_query` injects arbitrary JS into the webview and reads a temp file back out
2. `dom_keys` only synthesizes simplistic `keydown` events on `window`
3. The test script relies on DOM selectors and sleeps instead of state-aware waits
4. Tests attach to a live global Herd instance and do not own runtime lifecycle
5. The app hardcodes tmux server, socket, log, and state-file names, which prevents clean isolated test runs

The result is a half-debugging, half-testing harness rather than a supported integration interface.

## Goals

1. Add a typed semantic test driver over the existing socket transport.
2. Make integration tests assert app state and projection data instead of DOM structure.
3. Replace `test-e2e.ts` with a managed integration harness that launches and tears down Herd itself.
4. Isolate test runs from a developer's live Herd instance.
5. Keep live tmux in the loop for v1.
6. Keep the old DOM bridge only as an explicitly debug-only escape hatch.

## Non-goals

1. Adding a mock tmux runtime in v1.
2. Replacing the existing unit-test strategy.
3. Adding semantic driver coverage for debug/admin controls such as tmux restart, redraw, or log-tail buttons.
4. Removing all low-level socket commands like `spawn_shell` or `list_shells`.
5. Making `test_dom_query` or `test_dom_keys` stable public APIs.

## Core Decisions

1. The supported transport is the existing Unix socket protocol, extended with a new `test_driver` command.
2. v1 covers live tmux only.
3. The integration harness owns app lifecycle instead of attaching to an already-running Herd instance.
4. The typed driver covers product UI only.
5. The semantic driver is the supported automation surface; `test_dom_query` and `test_dom_keys` are kept only for debugging.
6. Tests should primarily assert `AppStateTree` and a derived `TestDriverProjection`, not DOM markup.
7. The new driver must avoid arbitrary JS eval for its supported request path.
8. Test driver features are enabled only in debug builds or when explicitly requested via env.

## Target Architecture

### Runtime isolation

Introduce a runtime-config layer in the Rust backend that resolves current hardcoded runtime identifiers from environment variables while preserving today's defaults for normal use.

The runtime config must cover:

1. tmux server name
2. default session name
3. socket path
4. persisted state path
5. socket log path
6. control-mode log path
7. test-driver enabled/disabled state

For integration runs, the harness sets:

1. `HERD_RUNTIME_ID`
2. `HERD_ENABLE_TEST_DRIVER=1`

The app derives isolated socket/tmux/log/state paths from `HERD_RUNTIME_ID` so each test run gets its own runtime and does not interfere with a live Herd instance.

### Driver bridge

The new supported driver path is a request/response bridge between the socket server and the frontend:

1. test runner sends `{"command":"test_driver","request":...}` over the socket
2. backend assigns a request ID
3. backend emits a `test-driver-request` event into the webview
4. frontend driver executes the typed request using shared app helpers and stores
5. frontend returns the result through a dedicated hidden Tauri command
6. backend resolves the waiting socket request and returns a normal `SocketResponse`

This replaces the supported use of arbitrary `webview.eval(...)` for integration automation.

### Shared action layer

Current UI logic is split across:

1. app-level keydown handling in `App.svelte`
2. canvas wheel/pan logic in `Canvas.svelte`
3. tile drag/resize/close/title interactions in `TerminalTile.svelte`

Those behaviors must be extracted into reusable frontend helpers so that:

1. the real Svelte UI calls them from DOM handlers
2. the test driver calls the same logic directly

This avoids duplicated test-only behavior.

### State-first assertions

The test driver exposes two inspection views:

1. `get_state_tree`
   Returns the full current `AppStateTree`
2. `get_projection`
   Returns a compact UI-centric derived view that includes:
   - mode
   - command bar open/text
   - help open
   - sidebar open/selection
   - close-tab confirmation state
   - selected pane
   - canvas state
   - tabs
   - active tab
   - active-tab terminals
   - sidebar items
   - active-tab lineage connections
   - tmux/control status indicators

Integration tests should default to projection or state-tree assertions instead of DOM assertions.

## Public Interfaces and Types

### Socket protocol

Add:

1. `test_driver`
   Accepts a typed `TestDriverRequest`
2. `test_dom_query`
   Renamed debug-only version of `dom_query`
3. `test_dom_keys`
   Renamed debug-only version of `dom_keys`

`test_driver` requests in v1:

1. `ping`
2. `wait_for_ready`
3. `wait_for_bootstrap`
4. `wait_for_idle`
5. `get_state_tree`
6. `get_projection`
7. `get_status`
8. `press_keys`
9. `command_bar_open`
10. `command_bar_set_text`
11. `command_bar_submit`
12. `command_bar_cancel`
13. `toolbar_select_tab`
14. `toolbar_add_tab`
15. `toolbar_spawn_shell`
16. `sidebar_open`
17. `sidebar_close`
18. `sidebar_select_item`
19. `sidebar_move_selection`
20. `sidebar_begin_rename`
21. `tile_select`
22. `tile_close`
23. `tile_drag`
24. `tile_resize`
25. `tile_title_double_click`
26. `canvas_pan`
27. `canvas_zoom_at`
28. `canvas_wheel`
29. `canvas_fit_all`
30. `canvas_reset`
31. `confirm_close_tab`
32. `cancel_close_tab`

### Frontend types

Add:

1. `TestDriverRequest`
2. `TestDriverProjection`
3. small shared helper APIs for:
   - keyboard actions
   - canvas actions
   - tile actions

### Backend state

Extend backend runtime state to track:

1. whether the test driver is enabled
2. whether the frontend test driver listener is ready
3. whether frontend bootstrap has completed
4. pending driver requests awaiting frontend responses

## Phased Red/Green Plan

### Phase 1: Runtime isolation and driver gating

**Objective**: make test runs isolated and explicitly enabled.

Red:

1. Herd hardcodes tmux server, socket, and log/state paths.
2. Integration scripts collide with the user's real Herd runtime.
3. There is no explicit test-driver enable/disable boundary.

Green:

1. Add a runtime-config module that resolves env-backed runtime identifiers with current defaults.
2. Add `HERD_RUNTIME_ID` and derive isolated test paths/names from it.
3. Add `HERD_ENABLE_TEST_DRIVER` and gate all `test_driver` and `test_dom_*` commands behind debug/test enablement.
4. Update all current hardcoded tmux/socket/log/state references to use runtime config.

Exit criteria:

1. A test run can launch Herd without touching the default `herd` tmux server or `/tmp/herd.sock`.
2. Test-driver commands are rejected when not enabled.

### Phase 2: Typed socket test driver

**Objective**: replace arbitrary JS as the supported integration path.

Red:

1. `dom_query` and `dom_keys` are the only UI-driving socket helpers.
2. Integration tests rely on stringified JS and synthetic window keydowns.
3. Backend and frontend have no typed request/response test bridge.

Green:

1. Add `test_driver` to the socket protocol with a typed `TestDriverRequest`.
2. Add a frontend request listener and a backend response resolver keyed by request ID.
3. Rename legacy DOM helpers to `test_dom_query` and `test_dom_keys`.
4. Keep legacy DOM helpers out of the supported integration path.

Exit criteria:

1. The app can answer typed driver requests without arbitrary JS eval.
2. `test_dom_*` is clearly a debug-only path.

### Phase 3: Shared semantic action helpers

**Objective**: make the driver and the UI use the same behavior paths.

Red:

1. Important interactions are implemented inline in Svelte DOM handlers.
2. Any test driver would need to duplicate click/keyboard/canvas/tile logic.

Green:

1. Extract keyboard behavior from `App.svelte` into a shared controller.
2. Extract canvas behaviors into shared helpers.
3. Extract tile behaviors into shared helpers.
4. Have real UI event handlers call those helpers.
5. Have the test driver call the same helpers.

Exit criteria:

1. No test-driver action reimplements product behavior separately from the UI.
2. Keyboard, canvas, and tile semantics are reusable outside raw DOM events.

### Phase 4: State-tree inspection and readiness

**Objective**: make integration tests state-aware and deterministic.

Red:

1. Tests use DOM selectors and sleeps to infer readiness and state.
2. There is no supported way to ask the running app for its actual `AppStateTree`.

Green:

1. Add `get_state_tree`.
2. Add `get_projection`.
3. Add readiness methods:
   - `ping`
   - `wait_for_ready`
   - `wait_for_bootstrap`
   - `wait_for_idle`
4. Track frontend readiness and bootstrap completion in backend state.

Exit criteria:

1. Integration tests can wait on driver/app readiness without hardcoded sleeps.
2. Integration tests can assert state and projection without DOM scraping.

### Phase 5: Managed integration harness

**Objective**: replace the ad hoc E2E script with a supported test runner.

Red:

1. `test-e2e.ts` expects a live Herd instance.
2. Tests do not own startup/shutdown.
3. Test logic is a monolithic script with manual socket helpers and pass/fail printing.

Green:

1. Add a typed Node test client around `/tmp/...sock`.
2. Add a managed harness that:
   - starts Herd with isolated runtime env
   - waits for socket + bootstrap readiness
   - runs tests serially
   - terminates the app
   - kills the isolated tmux server
   - cleans temp artifacts
3. Add a dedicated integration test command in package scripts.
4. Migrate current E2E coverage to the new harness.

Exit criteria:

1. Integration tests can be run from a single command without manually starting Herd.
2. The old `test-e2e.ts` path is no longer the primary supported harness.

### Phase 6: Coverage migration

**Objective**: make the new driver the primary integration surface.

Red:

1. Coverage is tied to DOM selectors and low-level debug helpers.
2. Keyboard, tab, sidebar, canvas, and tile flows are not expressed as semantic test actions.

Green:

1. Add integration coverage for:
   - app startup
   - keyboard shortcuts
   - command bar
   - toolbar tab actions
   - sidebar selection/navigation/rename prefill
   - tile select/drag/resize/close/double-click
   - canvas pan/zoom/fit/reset
   - close-tab confirmation
   - live tmux tab/window lifecycle
2. Assert via `get_projection()` or `get_state_tree()`.
3. Reserve `test_dom_*` for manual debugging only.

Exit criteria:

1. Product UI integration coverage no longer depends on raw DOM queries.
2. Driver-backed tests are the default integration strategy.

## Test Plan

### Unit coverage

Add unit tests for:

1. runtime-config resolution and isolation naming
2. driver request routing and request-response lifecycle
3. frontend driver executor mapping
4. shared keyboard helper behavior
5. shared canvas helper behavior
6. shared tile helper behavior
7. readiness and idle-state transitions

### Integration coverage

Add serial integration tests for:

1. managed app launch and bootstrap
2. state-tree retrieval
3. projection retrieval
4. tab creation/switching/closing
5. shell creation/selection/closing
6. sidebar open/select/move/rename prefill
7. command bar open/type/submit/cancel
8. input-mode keyboard routing
9. tile drag and resize
10. canvas pan/zoom/fit/reset
11. close-tab confirmation accept/cancel
12. tmux/control status reporting

### Debug-only verification

Keep a small smoke check that:

1. `test_dom_query` still works
2. `test_dom_keys` still works
3. they are not used by the supported integration suite

## Assumptions

1. v1 launches Herd in dev/debug mode rather than introducing a separate packaged test binary.
2. v1 uses live tmux only.
3. Product UI only excludes debug/admin maintenance buttons from the typed driver surface.
4. `test_dom_query` and `test_dom_keys` remain available only for debugging.
5. Integration tests run serially because they own a real desktop app instance.
