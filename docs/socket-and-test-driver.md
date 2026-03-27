# Herd CLI, Socket API, And Test Driver

This page is the detailed mechanics/reference companion to the high-level README. It documents Herd's supported local control surface.

Use the `herd` CLI for normal automation. The raw socket protocol is still available for low-level integration and for the MCP bridge.

## CLI

Herd exposes a grouped CLI through the app binary itself:

- installed usage: `herd`
- repo-local usage: `bin/herd`

On app startup Herd refreshes `~/.local/bin/herd` so the installed app is available on `PATH` without sudo. Inside the repo, `bin/herd` wraps the Rust CLI directly.

Global flags:

- `--socket <path>` overrides the socket path
- `--agent-pid <pid>` marks the call as agent-originated metadata; Herd-managed agents should always include it

Examples:

```bash
herd network list
herd network list shell
herd tile list
herd tile list agent
herd tile list work
herd tile get AbCdEf
herd tile move AbCdEf 1180 260
herd tile resize AbCdEf 760 520
herd message channel list
```

Agent, channel, chatter, network, and work operations are session-private. They resolve against the caller's current tmux tab/session and do not expose cross-session registry data.

Public control APIs use Herd `tile_id`, not tmux pane ids. Tmux-backed tiles get short Herd-owned IDs such as `AbCdEf`; work tiles use `work:<work_id>`.

Send a direct message to another agent by `agent_id`:

```bash
herd --agent-pid "$PPID" message direct agent-1234 "Can you take #prd-7?"
```

Broadcast to public chatter:

```bash
herd --agent-pid "$PPID" message public "I am picking up #prd-7 and syncing with @agent-1234" --mention agent-1234
```

Send to a subscribed channel:

```bash
herd --agent-pid "$PPID" message channel '#prd-7' "Starting the socket refactor now"
```

Send directly to the current session Root agent:

```bash
herd --agent-pid "$PPID" message root "Please inspect local work items and assign follow-up"
herd --agent-pid "$PPID" sudo "Please inspect local work items and assign follow-up"
```

Send to the sender's local network:

```bash
herd --agent-pid "$PPID" message network "Need another pass on this local network"
```

List channels or manage channel subscriptions:

```bash
herd message channel list
herd message channel subscribe agent-1234 '#prd-7'
herd message channel unsubscribe agent-1234 '#prd-7'
```

Acknowledge a backend ping for the current or named agent:

```bash
export HERD_AGENT_ID=agent-1234
herd agent ack-ping
herd agent ack-ping agent-1234
```

Shell operations:

```bash
herd tile create shell --x 180 --y 140 --width 640 --height 400 --parent-tile-id AbCdEf
herd shell send GhIjKl "pwd\n"
herd shell exec GhIjKl "claude --help"
herd shell read GhIjKl
herd shell role GhIjKl claude
```

Browser operations:

```bash
herd tile create browser --parent-tile-id AbCdEf
herd tile create browser --browser-incognito true --parent-tile-id AbCdEf
herd tile create browser --browser-path extensions/browser/checkers/index.html --parent-tile-id AbCdEf
herd tile create browser --browser-path extensions/browser/game-boy/index.html --parent-tile-id AbCdEf
herd browser navigate MnOpQr https://example.com
herd browser load MnOpQr ./index.html
herd browser load MnOpQr extensions/browser/texas-holdem/index.html
herd tile destroy MnOpQr
```

Command-bar equivalents in the UI:

- `:sudo <message>` sends a Root message as `User`
- `:dm <agent_id|AgentNumber|root> <message>` sends a direct message as `User`
- `:cm <message>` sends a public message as `User`

If a message arrives through the Claude channel and you want your reply to be visible to Herd or other agents, answer through the Herd messaging interface. Plain assistant text in the local session does not publish a Herd message.

Work operations:

```bash
herd tile create work --title "Socket refactor follow-up"
herd --agent-pid "$PPID" network connect AbCdEf left work:work-s4-001 left
herd --agent-pid "$PPID" network disconnect AbCdEf left
herd --agent-pid "$PPID" work stage start work-s4-001
herd --agent-pid "$PPID" work stage complete work-s4-001
herd self info
```

Worker tile-event subscriptions for network-visible tiles use `direction:action` selectors:

```bash
herd --agent-pid "$PPID" network subscribe MnOpQr in:exec
herd --agent-pid "$PPID" network unsubscribe MnOpQr in:exec
herd --agent-pid "$PPID" network subscriptions MnOpQr
```

Root can manage session-wide tile-event subscriptions for any same-session tile:

```bash
herd tile subscribe MnOpQr both:extension_call agent-1234
herd tile unsubscribe MnOpQr both:extension_call agent-1234
herd tile subscriptions MnOpQr agent-1234
```

Worker MCP exposes the message tools plus `self_info`, `self_display_draw`, `self_led_control`, `self_display_status`, `network_list`, `network_get`, `network_subscribe`, `network_unsubscribe`, `network_subscription_list`, and `network_call`. Root also gets the broader session-scoped tile and subscription controls.

## Socket API

Herd exposes a newline-delimited JSON protocol on `/tmp/herd.sock` by default. If `HERD_RUNTIME_ID` is set, the socket path becomes `/tmp/herd-<runtime_id>.sock`.

Socket commands follow `category_command` naming.

Normal control surfaces target Herd `tile_id` only. Tmux pane/window ids remain internal backing metadata and are not part of the public control API.

### Self-targeted commands

- `self_info`
- `self_display_draw`
- `self_led_control`
- `self_display_status`

`self_info` requires sender context and returns the sender tile's native `get` payload. It does not apply sender-visible network filtering.

`self_display_draw` requires an agent sender and updates only that calling agent tile's display drawer. It accepts `text`, `columns`, and `rows`.

`self_led_control` requires sender tile context and updates only that calling tile's 8-LED chrome strip. It accepts either `commands` or `pattern_name`, and the resulting sequence loops until replaced.

`self_display_status` requires sender tile context and updates only that calling tile's single-line ANSI status strip. Long text scrolls automatically in the tile chrome.

### Session-level tile commands

- `tile_create`
- `tile_list`
- `tile_destroy`
- `tile_rename`
- `network_list`
- `network_get`
- `tile_get`
- `tile_call`
- `tile_move`
- `tile_resize`
- `network_connect`
- `network_disconnect`

`tile_create` accepts `tile_type = shell | agent | browser | work`, plus optional `title`, `x`, `y`, `width`, `height`, `parent_session_id`, and `parent_tile_id`. Browser creation also accepts optional `browser_incognito` / CLI `--browser-incognito true` to start the browser tile in incognito mode instead of the shared default profile, plus optional `browser_path` / CLI `--browser-path <path>` to immediately load a local page such as an existing browser extension.

`tile_list` returns every tile in the current session. `network_list` returns the sender tile's sender-visible local network. Both accept optional `tile_type` filter `shell | agent | browser | work`.

`tile_destroy` is the generic session-scoped destroy path for any tile type.

`tile_rename` is root-only and accepts `tile_id` and `title`. It works for shell, browser, agent, and work tiles and returns the updated tile object.

`network_get` is a worker-safe lookup by `tile_id` inside the sender's sender-visible local network. It returns the same tile object shape used by `network_list.tiles`, including `message_api` for the network-visible interface. On browser tiles, that `message_api` advertises the `drive > screenshot` formats for PNG image plus Braille, ASCII, ANSI, and layout-preserving text output. If the loaded page is a browser extension, the payload also includes `details.extension`, and `message_api` may expose `extension_call` with the extension's declared methods.

`tile_get` is a root-only lookup by `tile_id` in the current session. It returns the full tile object, including `details` for that tile type and the full `message_api`. On browser tiles, that interface also advertises the full `drive > screenshot` format set and any currently loaded browser-extension methods.

`tile_move` is root-only and accepts `tile_id`, `x`, and `y`. It updates the canvas position for the tile and returns the updated tile object.

`tile_resize` is root-only and accepts `tile_id`, `width`, and `height`. It updates the canvas size for the tile and returns the updated tile object.

### Tile-event subscription commands

- `network_subscribe`
- `network_unsubscribe`
- `network_subscription_list`
- `tile_subscribe`
- `tile_unsubscribe`
- `tile_subscription_list`

Subscription selectors use `direction:action` syntax:

- directions: `in`, `out`, `both`, `*`
- actions: tile message names such as `exec`, `get`, `navigate`, or `extension_call`

Worker `network_*` subscription commands only target network-visible tiles in the sender's connected component. Root `tile_*` subscription commands can target any same-session tile.

### Shell instance commands

- `shell_input_send`
- `shell_exec`
- `shell_output_read`
- `shell_role_set`

The shell instance commands target Herd `tile_id`. `shell_exec` submits `<command>` plus a trailing newline to the existing shell tile. It runs the command inside the current shell process and keeps the tile usable for later reads and writes.

### Browser instance commands

- `browser_navigate`
- `browser_load`
- `browser_drive`

`browser_navigate` accepts `tile_id` and `url`, and returns the browser state payload with `currentUrl`.

`browser_load` accepts `tile_id` and a local `path`. Relative paths resolve from the Herd project root, and the file must exist.

`browser_drive` accepts `tile_id`, `action`, and optional `args`.

Supported `action` values:

- `click`
  - requires `args.selector`
- `select`
  - requires `args.selector`
  - requires `args.value`
- `type`
  - requires `args.selector`
  - requires `args.text`
  - accepts optional `args.clear`
- `dom_query`
  - requires `args.js`
  - returns serialized data from the child browser page
- `eval`
  - requires `args.js`
  - evaluates arbitrary child-page JavaScript and returns serialized data when possible
- `screenshot`
  - captures the current browser tile view
  - accepts optional `args.format` of `image`, `braille`, `ascii`, `ansi`, or `text`
  - accepts optional `args.columns` when `args.format` is `braille`, `ascii`, `ansi`, or `text`
  - returns `{ "mimeType": "image/png", "dataBase64": "<base64 png>" }` by default on the socket/test-driver surface
  - returns `{ "format": "braille", "text": "<braille>", "columns": 80, "rows": 24 }` when `args.format` is `braille`
  - returns `{ "format": "ascii", "text": "<ascii>", "columns": 80, "rows": 24 }` when `args.format` is `ascii`
  - returns `{ "format": "ansi", "text": "<ansi escape text>", "columns": 80, "rows": 24 }` when `args.format` is `ansi`
  - returns `{ "format": "text", "text": "<layout-preserving text grid>", "columns": 80, "rows": 24 }` when `args.format` is `text`
  - on the MCP surface, screenshot-shaped results are emitted as actual image/text content instead of raw base64 JSON blobs

`browser_drive` targets the child browser webview directly. It does not use `test_dom_query` or `test_dom_keys`, which only operate on the main Herd UI webview.

### Browser extension pages

Browser tiles loaded from `extensions/browser/...` may expose a discoverable extension API through:

- `globalThis.HerdBrowserExtension.manifest`
  - requires `extension_id`
  - requires `label`
  - may declare `methods`
- `globalThis.HerdBrowserExtension.call(method, args, caller)`
  - must return synchronously
  - receives caller context including `sender_tile_id`, optional `sender_agent_id`, optional `sender_agent_role`, `target_tile_id`, and `target_pane_id`

When a page exposes that contract:

- `tile_get` / `network_get` include `details.extension`
- the browser tile `responds_to` list includes `extension_call`
- `message_api` exposes the extension methods as discoverable subcommands

Built-in extension-backed pages currently include local games and emulators such as Texas Hold'em, Game Boy, and JSNES.

### Agents and messaging

- `agent_register`
- `agent_unregister`
- `agent_events_subscribe`
- `agent_ping_ack`
- `network_list`
- `tile_get`
- `tile_rename`
- `tile_move`
- `tile_resize`
- `message_direct`
- `message_public`
- `message_channel`
- `message_network`
- `message_root`
- `message_channel_list`
- `message_channel_subscribe`
- `message_channel_unsubscribe`
- `sudo` on the CLI is an alias that routes to `message_root`

Use `tile_list` with `tile_type = agent` for session-scoped agent discovery and `network_list` with `tile_type = agent` for connected-component agent discovery. Agent metadata is returned inside the tile `details` payload.

Permission boundary:

- Worker MCP tools expose the message surface plus:
  - `self_info`
  - `self_display_draw`
  - `self_led_control`
  - `self_display_status`
  - `network_list`
  - `network_get`
  - `network_subscribe`
  - `network_unsubscribe`
  - `network_subscription_list`
  - `network_call`
- `tile_get`, `tile_rename`, `tile_move`, and `tile_resize` are root-only.
- Root MCP also exposes `browser_drive`, `tile_subscribe`, `tile_unsubscribe`, and `tile_subscription_list`.
- Worker `network_call` is limited to visible local-network tiles and only to the worker-safe message subset for each tile kind. `shell` and directly controlled `browser` tiles expose write actions, including `extension_call` when a loaded browser page advertises it; `agent` and `root_agent` tiles stay read-only even when directly connected.
- The raw socket is also used by the app, tests, and local CLI automation for session-scoped network/work actions.
- Direct work stage mutation is still gated by the derived owner connection.

Message-channel behavior:

- Herd delivers incoming agent traffic through `notifications/claude/channel`.
- Event metadata includes `from_agent_id`, `from_display_name`, `to_agent_id`, `to_display_name`, `channels`, `mentions`, `replay`, and `timestamp_ms`.
- `replay=true` means historical context, usually last-hour chatter replay, not a fresh request.
- `replay=false` means live traffic.
- Replies that should be seen by Herd or other agents must go back out through `message_direct`, `message_public`, `message_channel`, `message_network`, or `message_root`.

### Tile-event notifications

Tile-event subscriptions deliver Claude channel events with `kind = "tile_event"`.

Important metadata fields on those events include:

- `delivery_reason`
  - `subscription`
  - `implicit_self_target`
- `subscription_scope`
  - `network`
  - `tile`
- `subscription_direction`
  - `in`
  - `out`
  - `both`
- `action`
- `subject_tile_id`
- `peer_tile_id`
- `caller_tile_id`
- `caller_agent_id`
- `target_tile_id`
- `target_agent_id`
- `rpc_channel`
- `outcome`
- `args_json`
- `result_json`

### Channel messaging

- `message_channel_list`
- `message_channel_subscribe`
- `message_channel_unsubscribe`
- `message_channel`

Channels are normalized lowercase and always stored with a leading `#`. Channel list and subscription data are session-private. Subscribing to a missing channel creates it in the caller's current session. `message_public` remains session-wide chatter; `message_channel` is the subscription-gated path.

### Work

- `work_stage_start`
- `work_stage_complete`
- `work_review_approve`
- `work_review_improve`

`network_list` returns the sender tile's connected component. `tile_list` returns every tile in the current session. Both accept optional `tile_type` filter `shell | agent | browser | work` and replace the old dedicated shell/agent/work list commands. They return:

- `session_id`
- `sender_tile_id` on `network_list`
- `tiles`
- `connections`

Each tile entry includes common fields:

- `tile_id`
- `session_id`
- `kind`
- `title`
- `x`
- `y`
- `width`
- `height`
- `window_id` when the tile is backed by a tmux window
- `parent_window_id` when the tmux window has tracked lineage
- `command` when the tile is backed by a tmux pane
- `responds_to` exposing the generic tile operations `get`, `call` plus the tile-specific message names for that kind
- `message_api` exposing structured message metadata for the same visible operations, including args and browser `drive` subcommands
- `details` with type-specific metadata

`network_list` and `network_get` are port-aware for non-root callers:

- direct connection to the target tile's read/write port returns the full tile RPC surface in `responds_to`, except `agent` and `root_agent` tiles, which always stay read-only on the network
- direct connection to a read-only target port returns only the read interface for that tile kind
- indirect visibility through the same connected component also returns only the read interface
- if traversal reaches another tile through that tile's gateway port, the tile is still visible but automatic traversal stops there
- the gateway tile itself can still see every segment directly attached to its own ports when it is the sender

`message_api` is filtered by the same access rules as `responds_to`.

Today the read interface is:

- `shell`: `get`, `call`, `output_read`
- `agent` / `root_agent`: `get`, `call`, `output_read`
- `browser`: `get`, `call`
- `work`: `get`, `call`

`network_get` is a worker-safe lookup by `tile_id` inside the sender's sender-visible local network. It returns the same tile object shape used by `network_list.tiles`. For actionable calls, inspect `message_api` for required args and browser `drive` subcommands instead of guessing nested payload shapes.

`network_call` is a worker-safe generic tile call by `tile_id` inside the sender's sender-visible local network. It accepts:

- `tile_id`
- `action`
- optional `args` object

`network_call` enforces the same port-aware access model used by `network_list` / `network_get`. A worker can only invoke message names exposed in that target tile's network-visible `responds_to` list for its current sender tile.

Agents should use `message_direct`, `message_network`, `message_public`, or `message_root` to coordinate with other agents. The network tile interface for `agent` and `root_agent` tiles is intentionally observational only.

`self_info` is the self-targeted path for getting the sender tile's own full `get` payload when `network_get` would otherwise return the network-visible projection.

Per-port settings are UI-driven in this pass:

- right-click a visible port to open `Access > Read | Read/Write` and `Networking > Broadcast | Gateway`
- red left indicator means the effective access mode is `read`
- orange right indicator means the effective networking mode is `gateway`
- changing access disconnects any live edge that would otherwise become `read -> read`

`tile_get` is a root-only lookup by `tile_id` in the current session. It returns the full tile object, including `details` for that tile type.

`tile_call` is the root-level generic tile-message surface for any tile in the current session. It accepts:

- `tile_id`
- `action`
- optional `args` object

Current worker-safe messages are:

- `shell`
  - `get`
  - `output_read`
  - `input_send`
  - `exec`
- `agent` / `root_agent`
  - `get`
  - `output_read`
- `browser`
  - `get`
  - `navigate`
  - `load`
  - `drive`
  - `extension_call` when the loaded page advertises `HerdBrowserExtension`

For shell tiles, `exec` submits `<command>` plus Enter to the existing pane. It does not respawn or replace the target shell process.

For generic `network_call` / `tile_call`, browser `drive` expects:

- `action`: `click` | `select` | `type` | `dom_query` | `eval` | `screenshot`
- optional nested `args` object for that browser-drive action

For extension-backed browser tiles, `extension_call` expects:

- `method`: string
- optional `args`: object

The available methods are declared by the loaded page and surfaced in `details.extension.methods` and `message_api`.

Browser tile `message_api` now spells this out directly:

- `navigate`
  - `url: string`
- `load`
  - `path: string`
- `drive`
  - `action: "click" | "select" | "type" | "dom_query" | "eval" | "screenshot"`
  - optional `args: object`
  - `click`
    - `selector: string`
  - `select`
    - `selector: string`
    - `value: string`
  - `type`
    - `selector: string`
    - `text: string`
    - optional `clear: boolean` defaulting to `true`
  - `dom_query`
    - `js: string`
  - `eval`
    - `js: string`
  - `screenshot`
    - optional `format: "image" | "braille" | "ascii" | "ansi" | "text"`
    - optional `columns: number`
    - returns `{ "mimeType": "image/png", "dataBase64": "<base64 png>" }` by default
    - returns `{ "format": "braille", "text": "<braille>", "columns": 80, "rows": 24 }` when `format` is `braille`
    - returns `{ "format": "ascii", "text": "<ascii>", "columns": 80, "rows": 24 }` when `format` is `ascii`
    - returns `{ "format": "ansi", "text": "<ansi escape text>", "columns": 80, "rows": 24 }` when `format` is `ansi`
    - returns `{ "format": "text", "text": "<layout-preserving text grid>", "columns": 80, "rows": 24 }` when `format` is `text`
- `extension_call`
  - `method: string`
  - optional `args: object`
  - the declared methods appear as `subcommands` in `message_api`
  - extension method results are method-specific
  - extension `screenshot` methods use the same `image` / `braille` / `ascii` / `ansi` / `text` payload shapes as `drive > screenshot`

Generic tile messages reject:

- tiles outside the sender's local network
- other sessions
- tile-specific action names not exposed for that tile kind

Every socket-backed command now passes through the same internal message-delivery layer except the dedicated streaming `agent_events_subscribe` path. Session-scoped list, create, destroy, registry, channel, network, and message operations route through the session receiver, tile-instance operations route through tile receivers, and test/debug commands route through the herd receiver. Herd records structured `tile_message_logs` entries with `channel = cli | socket | mcp | internal`, target metadata, wrapper command, message name, args, outcome, and timing.

`tile_move` is root-only and accepts `tile_id`, `x`, and `y`. It updates the canvas position for the tile and returns the updated tile object.

`tile_resize` is root-only and accepts `tile_id`, `width`, and `height`. It updates the canvas size for the tile and returns the updated tile object.

Work items are session-scoped. Use `tile_list` with `tile_type = work` for work discovery and `tile_get` for a single work tile payload. `tile_get` returns the common tile fields plus work-specific `details`. Tile creation for `tile_type = work` routes through the session receiver/message path, while `work_stage_start`, `work_stage_complete`, `work_review_approve`, and `work_review_improve` route through the work tile receiver/message path. Work items follow:

- stages: `plan -> prd -> artifact`
- statuses: `ready -> in_progress -> completed -> approved`

Each work item auto-creates work channel `#<work_id>` and SQLite-backed stage content for:

- `plan`
- `prd`
- `artifact`

There is no separate persisted `work/` document tree anymore; stage content lives in SQLite with the rest of the session state.

Only the owner may perform Herd-managed work updates. `work_review_approve` and `work_review_improve` are intended for the user-facing review flow.

### Test and debug

- `test_driver`
- `test_dom_query`
- `test_dom_keys`

Low-level example with the raw socket:

```bash
export HERD_SOCK=/tmp/herd.sock
export HERD_TILE_ID=AbCdEf

printf '%s\n' '{"command":"tile_list","sender_tile_id":"AbCdEf","tile_type":"agent"}' \
  | socat - UNIX-CONNECT:$HERD_SOCK
```

## Agent Runtime Model

Herd-managed agent launches use:

```bash
claude --teammate-mode tmux --dangerously-load-development-channels server:herd
```

Each launch gets:

- `HERD_AGENT_ID`
- `HERD_SOCK`
- tile/session context such as `HERD_TILE_ID`

The checked-in Herd MCP server is also the agent channel server. When it sees `HERD_AGENT_ID`, it:

1. registers the agent with Herd
2. subscribes to agent events over the Herd socket
3. forwards backend events to Claude through `notifications/claude/channel`
4. acknowledges Herd `PING` events so the backend can track liveness

Herd persists chatter/debug history in SQLite alongside the rest of the runtime registry state.

Every session also has one Root agent with stable id `root:<session_id>`. Root and worker agents both launch against the same checked-in `server:herd` entry; the MCP server switches between message-only worker mode and full-tool root mode by inspecting `HERD_AGENT_ROLE` and `HERD_AGENT_ID`.

The Root agent is visible in red on the canvas. If you close it through the UI confirmation flow, Herd immediately recreates it for that session.

## Test Driver

The typed `test_driver` API is the supported UI automation surface for integration tests. It is available in debug builds and can also be enabled with `HERD_ENABLE_TEST_DRIVER=1`.

Example:

```bash
printf '%s\n' '{"command":"test_driver","request":{"type":"ping"}}' \
  | socat - UNIX-CONNECT:$HERD_SOCK
```

The current request surface includes:

- Readiness and status: `ping`, `wait_for_ready`, `wait_for_bootstrap`, `wait_for_idle`, `get_status`
- State snapshots: `get_state_tree`, `get_projection`
- Keyboard and command bar control: `press_keys`, `command_bar_open`, `command_bar_set_text`, `command_bar_submit`, `command_bar_cancel`
- Toolbar and sidebar control: `toolbar_select_tab`, `toolbar_add_tab`, `toolbar_spawn_shell`, `toolbar_spawn_agent`, `toolbar_spawn_work`, `sidebar_open`, `sidebar_close`, `settings_sidebar_open`, `settings_sidebar_close`, `sidebar_select_item`, `sidebar_move_selection`, `sidebar_begin_rename`
- Tile and canvas control: `tile_select`, `tile_close`, `tile_drag`, `tile_resize`, `tile_title_double_click`, `canvas_pan`, `canvas_context_menu`, `canvas_zoom_at`, `canvas_wheel`, `canvas_fit_all`, `canvas_reset`, `tile_context_menu`, `port_context_menu`, `context_menu_select`, `context_menu_dismiss`
  These tile-oriented requests take Herd `tile_id`, not tmux pane ids. `tile_select` also accepts optional `shift_key: true` for multi-select, and the context-menu requests cover batch lock/unlock, batch close, and per-port access/networking changes.
- Close-confirm flow: `confirm_close_tab`, `cancel_close_tab`

Current integration coverage also exercises settings-sidebar saved-session save/load/delete flows and the toolbar `OPEN SESSION` restore flow, using the typed requests above plus `test_dom_query` where there is no dedicated request type for a specific button or select control.

The projection now includes debug and agent state such as:

- `debug_tab`
- `agents`
- `channels`
- `chatter`
- `connections`
- per-tile port/network-derived state used by the canvas and activity views

For programmatic examples, see [tests/integration/client.ts](/Users/skryl/Dev/herd/tests/integration/client.ts).

`test_dom_query` and `test_dom_keys` are still available behind the same gate, but they are manual debugging helpers rather than the supported automated integration surface.
