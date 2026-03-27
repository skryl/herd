# Herd Sessions And Layout

Use this guide for the session-level controls that sit above the raw CLI and socket APIs: saved session files, browser backend selection, and canvas layout workflows.

## Session Basics

- A Herd tab is a tmux session.
- Session-private state includes tiles, networks, chatter, channel subscriptions, work items, the Root agent, and session settings such as spawn directory and browser backend.
- Open the `TREE` sidebar with `b` and the `SETTINGS` sidebar with `,`.

## Settings Sidebar

The `SETTINGS` sidebar exposes the session-scoped controls:

- `SPAWN DIR`
  - sets the working directory used for new shells and agents in the current session
- `SESSION NAME`
  - renames the current session
  - drives the current saved-session file name target
  - includes `SAVE`, `DELETE`, and `LOAD` controls
- `BROWSER BACKEND`
  - switches the current session between `LIVE WEBVIEW` and `AGENT BROWSER`
- `PORTS`
  - changes the visible port count per tile between `4`, `8`, `12`, and `16`
- `WIRE SPARKS`
  - toggles animated network-call effects on canvas wires

## Saved Session Files

Saved session files live under the repo-local [`sessions/`](../sessions/) directory:

```text
sessions/<config_name>_session.json
```

`config_name` is derived from the current session name by:

- lowercasing it
- replacing each run of non-alphanumeric characters with `_`
- trimming leading and trailing `_`

Current behavior:

- `SAVE` writes the current session to that file name.
- saving over an existing file asks for confirmation first
- `LOAD` in the settings sidebar restores the saved configuration into the current tab/session
- `DELETE` removes the saved file for the current sanitized session name
- the toolbar `OPEN SESSION` dropdown loads a saved configuration into a new tab instead of replacing the current one

Saved session files currently persist:

- session name
- root spawn directory
- browser backend
- shell, agent, Root, browser, and work tiles
- per-tile layout, including lock state
- minimized tiles
- browser tile load-path or navigate-url state
- work item titles, stages, reviews, and ownership references
- network connections
- per-port access and networking overrides
- tile-event subscriptions

## Browser Backends

Each session chooses one browser backend:

- `live_webview`
  - the default embedded backend
- `agent_browser`
  - an optional external runtime used per session

Current runtime behavior:

- on supported platforms, Herd may prompt on startup to install `agent-browser` and Chrome for Testing when the runtime is available but not ready
- selecting `AGENT BROWSER` in the settings sidebar triggers the same install flow on demand if needed
- switching backends reconnects the current session's existing browser tiles through the new backend
- when Herd can recover a browser tile's current URL, it reopens that URL after the switch

## Layout Workflows

Selection and movement:

- click a tile or work card to select it
- `Shift+click` adds or removes a tile from the current selection
- drag a selected tile by its title bar
- drag a work card by its title bar

Locking and minimizing:

- right-click a selected tile or work card to open the context menu
- multi-selection context menus expose batch `Close` and `Lock` / `Unlock`
- locked tiles and work cards ignore normal drag moves
- use the tile header minimize button to send a tile to the minimized dock
- restore a minimized tile from the bottom dock

Arrange and view controls:

- `a` cycles anchored arrangements for the current session: `circle`, `snowflake`, `stack-down`, `stack-right`, `spiral`
- `Shift+A` runs the ELK arranger using the current session's network connections and port sides
- `f` fits the current session to the viewport
- `0` resets canvas zoom and pan

## Port Controls

Port visibility and overrides are split between the settings sidebar and the canvas:

- the `PORTS` setting changes how many visible port slots each tile exposes
- right-click a visible port on the canvas to set:
  - `Access`: `Read` or `Read/Write`
  - `Networking`: `Broadcast` or `Gateway`

For the deeper runtime rules behind those choices, see [Architecture](./architecture.md).
