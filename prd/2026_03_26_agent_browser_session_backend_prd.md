Status: In Progress

# Context

Herd browser tiles are currently hard-wired to Tauri child webviews. Work tiles are the one major tile kind that still do not have a tmux backing pane. The next runtime step is to add `agent-browser` as a session-scoped browser backend while also unifying all tile kinds under the same tmux-backed model.

# Goals

- Add a per-session browser backend setting with `live_webview` and `agent_browser`.
- Make `agent-browser` opt-in and Herd-managed, including first-run/install prompting and remembered decline state.
- Route browser tile operations through the selected session backend.
- Keep browser extension parity in `agent_browser` mode.
- Give work tiles a real tmux backing pane and a terminal drawer while keeping the existing work-card UI.

# Non-Goals

- Splitting Herd into a standalone long-lived server process.
- Adding a per-tile browser backend override.
- Exposing work-tile panes as shell-style public RPC surfaces.

# Phased Plan

## Phase 1: Session State And Work-Pane Unification

Red:
- Add failing tests for session browser-backend persistence/defaulting.
- Add failing tests for work tiles carrying tmux-backed tile records and surfacing a terminal drawer path.

Green:
- Persist session browser backend in tmux session env and include it in session snapshots/types.
- Add app/frontend settings state and commands for reading/updating the session backend.
- Extend `TileRecordKind` with `Work`.
- Create a hidden tmux window/pane for each work item and register it in the tile registry.
- Update session snapshots and projections so work tiles have pane/window ids internally while remaining hidden from the normal tmux tree and canvas terminal list.
- Add a work-card terminal drawer backed by the tmux pane.

Exit criteria:
- Work item create/delete/load/save restore their tmux backing panes.
- Active session settings surface the browser backend value.
- Targeted unit/integration tests for work-pane backing and session backend state pass.

## Phase 2: Agent-Browser Runtime Bootstrap

Red:
- Add failing tests for Herd-managed agent-browser install status and remembered decline behavior.

Green:
- Add Herd-managed agent-browser runtime/install state under a dedicated runtime directory.
- Bootstrap the platform-native `agent-browser` binary from the npm tarball into the Herd runtime.
- Run `agent-browser install` with `AGENT_BROWSER_HOME` pointed at Herd-managed storage.
- Add commands for install status, prompting/install trigger, and first-run remembered-decline state.
- Make new sessions default to `agent_browser` once the runtime is ready.

Exit criteria:
- A fresh app can decline installation and stay on `live_webview`.
- An explicit backend switch can trigger installation later.
- Install status survives restarts and is visible in Settings.

## Phase 3: Browser Backend Routing

Red:
- Add failing tests for browser tile backend selection, backend switching, screenshot/text preview parity, and extension discovery/calls in `agent_browser` mode.

Green:
- Replace browser-webview-only routing with a backend abstraction.
- Keep `live_webview` support, but route all browser commands through a shared backend interface.
- Implement `agent_browser` backend operations via the native CLI using Herd-managed `AGENT_BROWSER_HOME`, per-tile session ids, and per-tile profile directories.
- In `agent_browser` mode, render browser tiles as screenshot-backed snapshot surfaces with the existing text preview drawer preserved.
- Support `navigate`, `load`, `back`, `forward`, `reload`, `drive`, `screenshot`, extension discovery, and `extension_call`.
- Use `--allow-file-access` for local extension pages.

Exit criteria:
- Browser tiles work in both backends.
- Switching session backend migrates existing browser tiles after confirmation.
- Extension pages such as Game Boy / JSNES remain callable in `agent_browser` mode.

# Acceptance Criteria

- Sidebar Settings contains a session-level browser backend control and agent-browser install status/actions.
- Once agent-browser is installed, new sessions default to `agent_browser`.
- Work tiles create hidden tmux backing panes and expose a terminal drawer.
- Browser tiles in `agent_browser` mode provide screenshot-backed UI, browser drive actions, and extension calls.
- Saved sessions restore browser backend choice, work tiles, browser tiles, connections, and port settings.

# Risks And Mitigations

- Risk: `agent-browser` CLI semantics differ from the current webview-based browser API.
  Mitigation: keep screenshot/text formatting and extension-call shaping in Herd, and add backend parity tests before swapping call sites.

- Risk: hidden work windows leak into sidebar/tree projections.
  Mitigation: tag work panes explicitly and filter them from the user-facing tmux tree while retaining internal access.

- Risk: runtime bootstrap becomes brittle on packaged machines.
  Mitigation: bootstrap from the published npm tarball’s native binary and use Herd-managed `AGENT_BROWSER_HOME` instead of relying on user-global installs.

# Implementation Checklist

- [ ] Add session browser-backend types, tmux env helpers, and frontend settings state.
- [ ] Add work tile records/panes and hidden-window filtering.
- [ ] Add work terminal drawer UI and read path.
- [ ] Add agent-browser runtime/install management.
- [ ] Add first-run prompt and remembered decline state.
- [ ] Add backend abstraction and route browser commands through it.
- [ ] Add agent-browser backend support for navigation, drive, preview, screenshot, and extensions.
- [ ] Update saved session serialization/restoration for browser backend and tmux-backed work tiles.
- [ ] Update docs and mark this PRD complete.
