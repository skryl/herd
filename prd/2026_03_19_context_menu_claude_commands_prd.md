# Herd Right-Click Context Menu With Claude-Aware Actions PRD

## Status

Completed

## Date

2026-03-19

## Summary

Add an app-owned right-click context menu to Herd.

The required behavior is:

1. Right-click on empty canvas shows `New Shell`.
2. Right-click on a regular tile shows `Close Shell`.
3. Right-click on an interactive Claude tile shows `Close Shell` plus all available Claude commands.
4. Canvas-created shells appear at the clicked canvas world position.
5. Claude command clicks are hybrid:
   - known zero-arg commands execute immediately
   - commands with arguments or unknown argument shape insert without `Enter`

The feature must stay tmux-authoritative, avoid legacy compatibility branches, and be fully covered through the root state tree and typed in-app integration driver.

## Context

Herd currently blocks the browser context menu on the canvas but has no app-owned right-click interaction model. Tile actions are only reachable through keyboard shortcuts, the toolbar, and the command bar.

Claude tiles are also missing direct UI affordances for Claude slash commands even though they are a distinct interactive surface in the app. The current app already has the primitives needed to build this cleanly:

1. a single `AppStateTree`
2. tmux-authoritative shell creation and shell close flows
3. an in-app typed integration driver
4. Claude hook scripts that already know when a hook-created tile is an interactive Claude tile vs an output follower

The missing pieces are context-menu state, a deterministic canvas-placement override for right-click shell creation, tile classification for Claude-aware menus, and an authoritative Claude command discovery path.

## Goals

1. Add a state-driven right-click context menu.
2. Keep shell creation and close flows tmux-authoritative.
3. Place canvas-created shells at the click point.
4. Show Claude commands only for interactive Claude tiles.
5. Source Claude commands authoritatively for the pane cwd.
6. Cover the feature with unit tests and typed integration tests.

## Non-goals

1. Replacing keyboard, toolbar, or command-bar flows.
2. Prefetching Claude commands for every pane in the app.
3. Showing Claude commands on background output followers or BG Bash tiles.
4. Introducing native OS menus.
5. Reusing `test_dom_*` as the supported automation path.

## Scope

In scope:

1. context-menu UI state
2. canvas and tile right-click handlers
3. visible context-menu overlay
4. `New Shell`, `Close Shell`, and Claude-command actions
5. Claude tile classification and command discovery
6. test-driver and test coverage updates

Out of scope:

1. tmux session/window mapping changes
2. command-bar redesign
3. broader background-task UX changes

## Core Decisions

1. The context menu is stored in the root `AppStateTree`, not component-local DOM state.
2. Canvas `New Shell` creates a tmux window in the active session and records a one-shot placement override for the next created window.
3. That explicit placement override wins over arrangement-mode auto-reflow for that one creation only.
4. Claude tiles keep `Close Shell` in the same menu as Claude commands.
5. Claude commands are shown under a `Claude Commands` section in the same menu.
6. Claude command discovery is authoritative per pane cwd and happens on demand when the menu opens.
7. Command clicks are hybrid:
   - built-ins known to take no arguments execute immediately
   - commands with argument metadata or unknown argument shape insert without `Enter`
8. Unknown commands default to insert-only.
9. Integration tests use a deterministic Claude-command discovery stub rather than the real Claude runtime.

## Risks And Mitigations

1. Claude command discovery may be slow or fail.
   - Mitigation: load on demand, show loading/error rows, keep `Close Shell` usable, stub discovery in tests.
2. Placement can race with snapshot-driven layout reconciliation.
   - Mitigation: use a one-shot pending placement override consumed by the next matching created window before layout persistence.
3. Interactive Claude tiles can be misclassified.
   - Mitigation: add explicit hook-driven tile-role metadata and use tmux heuristics only as fallback for manually launched root Claude panes.
4. DOM-only tests could miss store regressions.
   - Mitigation: keep the menu model pure and assert it through unit tests and typed driver projection.

## Acceptance Criteria

1. Right-clicking empty canvas opens a menu with `New Shell`.
2. Choosing `New Shell` creates a shell in the active tab and places it at the clicked world position.
3. Right-clicking a regular tile opens a menu with `Close Shell`.
4. Choosing `Close Shell` reuses the existing close semantics, including session-close confirmation when it is the last window in the session.
5. Right-clicking an interactive Claude tile opens a menu with `Close Shell` and `Claude Commands`.
6. The Claude command list is discovered authoritatively for that pane cwd.
7. Choosing a known zero-arg Claude command sends the command plus `Enter`.
8. Choosing an arg-taking or unknown Claude command inserts the command without executing it.
9. Background output tiles do not show Claude commands.
10. Unit and integration coverage passes through the state tree and typed driver.

## Public Interfaces And Types

Add frontend types:

1. `ContextMenuState`
2. `ContextMenuTarget = 'canvas' | 'pane'`
3. `ContextMenuItem`
4. `PaneKind = 'regular' | 'claude' | 'output'`
5. `ClaudeCommandDescriptor { name, execution, source }`

Add backend interfaces:

1. Tauri command `get_claude_commands_for_pane(pane_id)`
2. socket command `set_tile_role { session_id, role }`

Extend test-driver API:

1. `canvas_context_menu`
2. `tile_context_menu`
3. `context_menu_select`
4. `context_menu_dismiss`

Extend test-driver projection:

1. current context-menu state
2. rendered menu items
3. Claude-command loading/error state

## Phased Red/Green Plan

### Phase 0: Context-Menu State And Driver Surface

#### Objective

Add the pure state and typed-driver surfaces first.

#### Red

1. Add failing unit tests for opening and dismissing the context menu.
2. Add failing unit tests for menu-item derivation for canvas and regular panes.
3. Add failing integration-driver tests for context-menu requests and projection fields.

Expected failure signal:

1. missing context-menu types
2. missing projection state
3. unknown typed-driver requests

#### Green

1. Add `ContextMenuState`, `ContextMenuItem`, and `PaneKind`.
2. Extend the root store with context-menu state and pure selectors.
3. Extend the typed test driver and projection with context-menu support.
4. Do not render the actual menu yet.

Verification commands:

1. `npm run test:unit -- src/lib/stores/appState.test.ts`
2. `npm run test:integration -- tests/integration/test-driver.test.ts`
3. `npm run check`

#### Exit Criteria

1. context-menu state exists in the root store
2. typed driver can open and dismiss menu state
3. targeted tests are green

### Phase 1: Canvas And Regular-Tile Menu Actions

#### Objective

Implement the visible menu plus `New Shell` and `Close Shell` for non-Claude targets.

#### Red

1. Add failing unit tests for canvas click-point world-coordinate capture.
2. Add failing unit tests for one-shot pending spawn placement.
3. Add failing unit tests for `Close Shell` routing through the existing close intent.
4. Add failing integration tests for:
   - right-click canvas -> `New Shell` at clicked position
   - right-click regular tile -> `Close Shell`

Expected failure signal:

1. new shell appears at default layout instead of click point
2. no visible menu projection after right click
3. no menu-driven close action

#### Green

1. Implement `ContextMenu.svelte` and mount it from `App.svelte`.
2. Wire right-click handlers in `Canvas.svelte` and `TerminalTile.svelte`.
3. Add one-shot pending spawn placement and consume it during snapshot reconciliation.
4. Ensure explicit right-click placement bypasses arrangement reflow for that one created shell only.
5. Route `Close Shell` through the same close path as `x`.

Verification commands:

1. `npm run test:unit -- src/lib/stores/appState.test.ts`
2. `npm run test:integration -- tests/integration/test-driver.test.ts`
3. `npm run check`

#### Exit Criteria

1. canvas menu works and places new shells at the click point
2. regular tile menu closes shells correctly
3. menu dismisses on click-away and `Escape`

### Phase 2: Claude Tile Classification And Command Discovery

#### Objective

Recognize interactive Claude panes and load authoritative command lists for them.

#### Red

1. Add failing backend tests for explicit tile-role metadata and fallback Claude detection.
2. Add failing backend/helper tests for Claude-command discovery and metadata enrichment.
3. Add failing frontend tests for Claude menu loading, success, and error states.
4. Add failing integration tests using a stubbed discovery provider for Claude-tile menus and output-tile exclusion.

Expected failure signal:

1. Claude tiles are treated as regular tiles
2. command list never appears
3. output followers incorrectly expose Claude commands

#### Green

1. Add backend tile-role metadata storage and `set_tile_role`.
2. Update the Claude hook scripts to mark interactive tiles `claude` and output followers `output`.
3. Add fallback detection for manually launched root Claude panes.
4. Implement `get_claude_commands_for_pane(pane_id)`.
5. Add a dedicated discovery helper and metadata enrichment rules.
6. Surface loading and error rows into the menu state and projection.

Verification commands:

1. `cargo test --manifest-path src-tauri/Cargo.toml`
2. `npm run test:unit`
3. `npm run test:integration -- tests/integration/test-driver.test.ts`
4. `npm run check`

#### Exit Criteria

1. interactive Claude panes show Claude commands
2. output tiles do not
3. integration tests use the deterministic stub path

### Phase 3: Hybrid Claude Command Execution And Regression Coverage

#### Objective

Make Claude command clicks perform the correct immediate-vs-insert behavior and close out coverage.

#### Red

1. Add failing unit tests for:
   - zero-arg command executes immediately
   - arg-taking command inserts without `Enter`
   - unknown command defaults to insert-only
2. Add failing integration tests for:
   - immediate execution behavior
   - insert-only behavior
   - `Close Shell` still present on Claude tiles
   - last-window close confirmation via the menu

Expected failure signal:

1. all commands either execute or insert with no distinction
2. Claude menu lacks the regular close action
3. insert-only path still executes

#### Green

1. Implement hybrid click routing for Claude commands.
2. Select the target pane before command dispatch.
3. Execute zero-arg commands with trailing `Enter`.
4. Insert arg-taking and unknown commands without `Enter`.
5. Keep `Close Shell` in the same menu and reuse the existing close semantics.

Verification commands:

1. `npm run test:unit`
2. `npm run test:integration`
3. `npm run check`
4. `cargo check --manifest-path src-tauri/Cargo.toml`

#### Exit Criteria

1. hybrid command behavior is correct
2. Claude tiles retain `Close Shell`
3. targeted unit and integration coverage is green

## Implementation Checklist

- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Phase 2 complete
- [x] Phase 3 complete
- [x] Integration and regression checks complete
- [x] PRD status updated to `Completed`

## Command Log

1. `npm run test:unit -- src/lib/stores/appState.test.ts`
   - result: pass
   - notes: store and selector coverage
2. `npm run test:integration -- tests/integration/test-driver.test.ts`
   - result: pass
   - notes: typed-driver and live app wiring
3. `cargo test --manifest-path src-tauri/Cargo.toml`
   - result: pass for `commands::tests`
   - notes: backend role and discovery coverage
4. `npm run check`
   - result: pass
   - notes: TS and Svelte validation
5. `cargo check --manifest-path src-tauri/Cargo.toml`
   - result: pass with existing non-blocking warnings
   - notes: final Rust compile validation
6. `npm run test:unit`
   - result: pass
   - notes: full frontend unit suite
7. `npm run test:integration`
   - result: pass
   - notes: full in-app integration suite
