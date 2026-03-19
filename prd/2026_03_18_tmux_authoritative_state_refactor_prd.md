# Herd TMUX-Authoritative State Refactor PRD

## Status

Proposed

## Date

2026-03-18

## Summary

Refactor Herd so `tmux` is the sole source of truth for runtime shell topology, lifecycle, focus, tab/window selection, and user-visible names. The frontend must stop creating or deleting tiles/tabs locally and instead become a projection of:

1. Authoritative tmux runtime state
2. Herd-owned canvas layout metadata keyed by tmux IDs

All topology-changing UX flows must follow:

1. User action emits a UI intent
2. Backend issues a tmux command
3. Backend emits a fresh tmux snapshot
4. Frontend state tree updates from that snapshot
5. UI re-renders from the state tree

The frontend must also move to a single, normalized state tree with pure reducers/selectors so UI behavior can be covered by unit tests against state expectations rather than DOM-driven integration tests.

## Context

The current implementation mixes tmux state and frontend-local topology state:

1. Some UX flows create frontend tiles before tmux confirms the runtime object exists.
2. Multiple Svelte stores jointly represent tabs, terminals, selection, mode, and layout.
3. Backend events are fragmented across spawn/destroy/title flows instead of exposing a single canonical runtime snapshot.
4. Tests are biased toward end-to-end DOM checks instead of deterministic state-level assertions.

This makes topology synchronization fragile and forces two-way syncing between UI state and tmux state. The refactor should collapse that to a one-way model where tmux is authoritative and the UI is a derived view.

## Goals

1. Make tmux authoritative for shell and tab topology.
2. Remove all frontend-local topology creation/deletion flows.
3. Introduce a canonical tmux snapshot API and event stream.
4. Replace scattered frontend stores with a single state tree.
5. Route all topology-changing controls through a shared intent/effect layer.
6. Cover all UI controls with unit tests against state-tree transitions and tmux-effect expectations.

## Non-goals

1. Replacing tmux with a different terminal/runtime backend.
2. Eliminating freeform canvas layout.
3. Making canvas geometry authoritative in tmux.
4. Designing a multi-session or multi-user model.
5. Removing all integration tests; lightweight smoke coverage may remain optional.

## Core Decisions

1. Herd continues to use a single tmux session named `herd`.
2. Tabs map 1:1 to tmux windows.
3. Tiles map 1:1 to tmux panes.
4. Multiple tiles per tab are supported via tmux panes inside the active tmux window.
5. User-visible tab names come from tmux window names.
6. User-visible tile titles come from tmux pane titles.
7. Freeform canvas geometry remains Herd-owned metadata keyed by tmux IDs.
8. Tile resize remains visual-only and does not issue `resize-pane`.
9. Runtime topology changes must always be `Command -> TMUX -> UI reflects TMUX`.

## Target Architecture

### Backend truth model

The backend exposes a canonical `TmuxSnapshot` containing:

1. Session identity
2. Active window ID
3. Active pane ID
4. Ordered windows
5. Ordered panes by window
6. Window names
7. Pane titles
8. Pane command/status metadata

The backend emits this snapshot:

1. At startup
2. After every topology-changing tmux command
3. After control-mode events that imply topology, focus, or naming changes

`pty-output` remains incremental and is only for terminal byte streams.

### Frontend truth model

The frontend owns one root `AppStateTree` with three slices:

1. `tmux`
   Contains normalized authoritative runtime state from `TmuxSnapshot`
2. `layout`
   Contains canvas metadata keyed by tmux pane/window IDs
3. `ui`
   Contains only local presentation state such as mode, help, debug pane, sidebar, command bar, and selected pane for spatial navigation

The UI must render only from selectors over `AppStateTree`.

### Ownership boundary

tmux owns:

1. Window existence
2. Pane existence
3. Active tab/window
4. Pane/window naming
5. Focus/lifecycle/topology

Herd owns:

1. Canvas `x/y/width/height`
2. View-only interactions like fit/reset/auto-arrange
3. Non-topology UI state such as overlays, command bar, and local selection

## Public Interfaces and Types

### Backend / IPC

Add:

1. `get_tmux_state`
   Returns the current authoritative `TmuxSnapshot`
2. `tmux-state`
   Event carrying the full authoritative snapshot plus a monotonic version

Prefer explicit tmux-aligned commands for internal use:

1. `new_window`
2. `split_pane`
3. `kill_window`
4. `kill_pane`
5. `select_window`
6. `rename_window`
7. `set_pane_title`

Existing socket/MCP commands may remain as compatibility wrappers, but must be implemented in terms of the tmux-first model.

### Frontend

Add:

1. `TmuxSnapshot`
2. `TmuxWindowNode`
3. `TmuxPaneNode`
4. `LayoutEntry`
5. `AppStateTree`
6. `UiIntent`
7. Reducers/selectors/effect descriptors for state application and command dispatch

## Phased Red/Green Plan

### Phase 1: Canonical TMUX Snapshot

**Objective**: replace fragmented lifecycle events with one authoritative runtime feed.

Red:
1. Frontend runtime topology can be created locally before tmux confirms it.
2. Backend emits fragmented events like spawned/destroyed/title-changed instead of a single snapshot.
3. Frontend cannot bootstrap entirely from backend truth.

Green:
1. Implement a canonical `TmuxSnapshot` generated from tmux control/listing state.
2. Add `get_tmux_state` for bootstrap.
3. Add `tmux-state` for authoritative updates.
4. Emit a fresh snapshot on startup and after topology/focus/title changes.
5. Keep `pty-output` only for terminal output streaming.

Exit criteria:
1. Frontend can fully hydrate topology from `get_tmux_state`.
2. No frontend code needs synthetic runtime IDs for panes/windows.

### Phase 2: Single Frontend State Tree

**Objective**: consolidate frontend state into one normalized, testable model.

Red:
1. Tabs, terminals, selection, mode, and layout are split across many stores.
2. Components mutate topology state directly.
3. Rendering logic depends on ad hoc store coordination.

Green:
1. Introduce `AppStateTree` with normalized `tmux`, `layout`, and `ui` slices.
2. Add pure reducers for:
   - applying tmux snapshots
   - reconciling layout entries
   - updating local UI state
3. Add selectors for:
   - active tab
   - visible tiles
   - sidebar tree
   - status bar state
4. Move all component rendering to selectors over the root state tree.

Exit criteria:
1. Visible topology is fully reconstructable from `AppStateTree`.
2. Components no longer own topology state.

### Phase 3: Intent and Effect Architecture

**Objective**: ensure controls dispatch intents instead of mutating topology directly.

Red:
1. Toolbar, keyboard handlers, command bar, and tile controls call stores and Tauri commands directly.
2. Some commands can create dead local tiles or bypass tmux authority.

Green:
1. Introduce a shared `UiIntent` dispatcher.
2. Introduce an effect layer that maps intents to either local UI updates or tmux commands.
3. Route all topology-changing actions through tmux effects only.
4. Route all view-only actions through local reducers only.
5. Remove direct topology mutation from components.

Exit criteria:
1. No user control creates/deletes/renames/switches topology locally.
2. All topology changes appear only after tmux snapshot updates.

### Phase 4: Layout Metadata Reconciliation

**Objective**: keep freeform canvas layout without letting it become topology truth.

Red:
1. Layout persistence is partial and not merged as authoritative render data.
2. New panes get ad hoc placement.
3. Removed panes can leave stale layout state.

Green:
1. Key layout metadata by tmux pane/window IDs.
2. On every tmux snapshot:
   - preserve layout for existing IDs
   - create defaults for new IDs
   - remove stale IDs
3. Persist drag and visual-resize changes in Herd metadata only.
4. Keep move/resize commands local to layout state and persistence.

Exit criteria:
1. Layout survives restarts for the current tmux topology.
2. Layout changes do not mutate tmux topology.

### Phase 5: TMUX-Aligned UX Commands

**Objective**: make tabs/tiles/naming/focus flows fully tmux-driven.

Red:
1. Current commands use mixed frontend/backend paths for creation, closure, and naming.
2. Tab and tile naming sources are inconsistent.
3. Frontend selection and topology can diverge from tmux.

Green:
1. `new shell` creates a tmux pane in the active tmux window.
2. `new tab` creates a tmux window.
3. `close tile` kills the selected tmux pane.
4. `close tab` kills the active tmux window.
5. Tab switching selects tmux windows.
6. Rename tab updates tmux window names.
7. Rename tile updates tmux pane titles.
8. Toolbar, keyboard shortcuts, command bar, sidebar, and tile controls all use the intent/effect layer.

Exit criteria:
1. User-visible tabs always match tmux windows.
2. User-visible tiles always match tmux panes.
3. User-visible names always match tmux names/titles.

### Phase 6: State-Tree Unit Tests

**Objective**: replace DOM-heavy UI verification with deterministic unit coverage.

Red:
1. Verification depends mainly on DOM-driven integration tests.
2. UI controls are not covered through pure state assertions.

Green:
1. Add unit test infrastructure for reducers, selectors, and intent/effect handling.
2. Add snapshot fixtures covering startup, pane add/remove, rename, focus, and window changes.
3. Add tests for all user controls:
   - toolbar actions
   - keyboard shortcuts
   - command-bar verbs
   - tab actions
   - sidebar actions
   - tile controls
4. Assert state-tree transitions and emitted tmux effects instead of DOM output.

Exit criteria:
1. Every user control has at least one unit test.
2. Core UI behavior can be validated without mounting the full app DOM.

## Command Mapping Requirements

The following controls must be tmux-first:

1. Toolbar shell button
2. `s`
3. `:sh`, `:shell`, `:new`
4. Tab add button
5. `t`
6. `:tn`, `:tabnew`
7. Tab close button/flow
8. `w`
9. `:tc`, `:tabclose`
10. Tile close button
11. `q`
12. Rename tab/tile commands
13. Tab selection clicks
14. `N` / `P`

The following controls remain local/UI-only:

1. Help toggle
2. Debug pane toggle
3. Sidebar toggle
4. Command bar visibility/text
5. Input/command mode state
6. Fit/reset/auto-arrange
7. Drag/move tile
8. Visual-only tile resize
9. Local spatial selection/highlighting

## Test Cases and Scenarios

1. Bootstrap from an empty tmux snapshot.
2. Bootstrap from a populated multi-window, multi-pane snapshot.
3. Create a shell from toolbar, shortcut, and command bar; verify only a tmux effect is emitted and the tile appears after snapshot application.
4. Create, switch, rename, and close tabs; verify active tab follows tmux active window.
5. Rename and close tiles; verify pane title/kill flows are tmux-first.
6. Apply a snapshot that removes panes/windows; verify stale tiles/tabs disappear from the state tree.
7. Move and visual-resize a tile; verify only layout metadata changes.
8. Toggle help, debug pane, sidebar, command bar, and mode; verify only `ui` slice changes.
9. Reconcile saved layout metadata against changed tmux topology; verify new panes get defaults and stale IDs are removed.
10. Verify selectors for active tab, visible tiles, sidebar tree, and status bar from fixed snapshot fixtures.

## Risks and Mitigations

1. **Risk**: freeform canvas layout and real tmux split geometry diverge.
   **Mitigation**: explicitly treat canvas geometry as Herd-owned visual metadata and keep resize visual-only.
2. **Risk**: control-mode event timing causes stale frontend topology.
   **Mitigation**: rebuild and emit authoritative snapshots after every topology-changing command and on relevant control-mode events.
3. **Risk**: migration leaves old component paths mutating topology directly.
   **Mitigation**: centralize all control entry points behind intents/effects and remove direct store/tmux calls from components.
4. **Risk**: tests still depend on DOM mounting.
   **Mitigation**: keep reducers/selectors/effects pure and fixture-driven so unit tests can assert state and side effects directly.

## Acceptance Criteria

1. The frontend no longer creates or deletes topology locally.
2. Tabs, tiles, active tab, and names are always derived from tmux state.
3. The frontend can fully bootstrap topology from `get_tmux_state`.
4. A single `AppStateTree` is sufficient to derive visible UI state.
5. All topology-changing controls go through `Command -> TMUX -> UI reflects TMUX`.
6. Canvas layout remains persistent and freeform without becoming topology truth.
7. Every UI control is covered by unit tests against state-tree expectations and tmux-effect expectations.
8. DOM-driven integration tests are no longer required for core UI correctness.

## Execution Checklist

- [ ] Phase 1: canonical tmux snapshot API and event stream
- [ ] Phase 2: single frontend state tree
- [ ] Phase 3: intent and effect architecture
- [ ] Phase 4: layout reconciliation and persistence
- [ ] Phase 5: tmux-aligned UX commands
- [ ] Phase 6: state-tree unit test coverage
