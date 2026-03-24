# Herd CLI, Socket API, And Test Driver

This page documents Herd's supported local control surface.

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
herd session list
herd session list agent
herd session list work
herd tile get %7
herd tile move %7 1180 260
herd tile resize %7 760 520
herd topic list
```

Agent, topic, chatter, network, and work operations are session-private. They resolve against the caller's current tmux tab/session and do not expose cross-session registry data.

Send a direct message to another agent by `agent_id`:

```bash
herd --agent-pid "$PPID" message direct agent-1234 "Can you take #prd-7?"
```

Broadcast to public chatter:

```bash
herd --agent-pid "$PPID" message public "I am picking up #prd-7 and syncing with @agent-1234"
```

Send to the sender's local network:

```bash
herd --agent-pid "$PPID" message network "Need another pass on this local network"
```

Send directly to the current session Root agent:

```bash
herd --agent-pid "$PPID" message root "Please inspect local work items and assign follow-up"
herd --agent-pid "$PPID" sudo "Please inspect local work items and assign follow-up"
```

Publish to a topic explicitly:

```bash
herd --agent-pid "$PPID" message topic '#prd-7' "Starting the socket refactor now"
```

Subscribe the current agent to a topic:

```bash
export HERD_AGENT_ID=agent-1234
herd --agent-pid "$PPID" topic subscribe '#prd-7'
```

Shell operations:

```bash
herd shell create --x 180 --y 140 --width 640 --height 400 --parent-pane-id %1
herd shell send %2 "pwd\n"
herd shell exec %2 "claude --help"
herd shell read %2
herd shell title %2 "Agent"
herd shell role %2 claude
```

Browser operations:

```bash
herd browser create --parent-pane-id %1
herd browser navigate %9 https://example.com
herd browser load %9 ./index.html
herd browser destroy %9
```

Command-bar equivalents in the UI:

- `:sudo <message>` sends a Root message as `User`
- `:dm <agent_id|AgentNumber|root> <message>` sends a direct message as `User`
- `:cm <message>` sends a public message as `User`

If a message arrives through the Claude channel and you want your reply to be visible to Herd or other agents, answer through the Herd messaging interface. Plain assistant text in the local session does not publish a Herd message.

Work operations:

```bash
herd --agent-pid "$PPID" work create "Socket refactor follow-up"
herd --agent-pid "$PPID" network connect %7 left work:work-s4-001 left
herd --agent-pid "$PPID" network disconnect %7 left
herd --agent-pid "$PPID" work stage start work-s4-001
herd --agent-pid "$PPID" work stage complete work-s4-001
```

Worker MCP exposes the message tools plus `network_list`, `network_get`, and `network_call`. The local CLI/socket surface also exposes broader session-scoped network and work commands for Root, the app, and local automation.

## Socket API

Herd exposes a newline-delimited JSON protocol on `/tmp/herd.sock` by default. If `HERD_RUNTIME_ID` is set, the socket path becomes `/tmp/herd-<runtime_id>.sock`.

Socket commands follow `category_command` naming.

### Session-level tile commands

- `tile_create`
- `tile_list`
- `tile_destroy`
- `tile_rename`
- `network_list`
- `network_get`
- `tile_get`
- `tile_move`
- `tile_resize`
- `network_connect`
- `network_disconnect`

`tile_create` accepts `tile_type = shell | agent | browser | work`, plus optional `title`, `x`, `y`, `width`, `height`, `parent_session_id`, and `parent_tile_id`.

`tile_list` returns every tile in the current session. `network_list` returns the sender tile's connected component. Both accept optional `tile_type` filter `shell | agent | browser | work`.

`tile_destroy` is the generic session-scoped destroy path for any tile type.

`tile_rename` is root-only and accepts `tile_id` and `title`. It works for shell, browser, agent, and work tiles and returns the updated tile object.

`network_get` is a worker-safe lookup by `tile_id` inside the sender's current connected component. It returns the same tile object shape used by `network_list.tiles`.

`tile_get` is a root-only lookup by `tile_id` in the current session. It returns the full tile object, including `details` for that tile type.

`tile_move` is root-only and accepts `tile_id`, `x`, and `y`. It updates the canvas position for the tile and returns the updated tile object.

`tile_resize` is root-only and accepts `tile_id`, `width`, and `height`. It updates the canvas size for the tile and returns the updated tile object.

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

`browser_drive` targets the child browser webview directly. It does not use `test_dom_query` or `test_dom_keys`, which only operate on the main Herd UI webview.

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
- `message_network`
- `message_root`
- `message_topic_list`
- `message_topic_subscribe`
- `message_topic_unsubscribe`
- `sudo` on the CLI is an alias that routes to `message_root`

Use `tile_list` with `tile_type = agent` for session-scoped agent discovery and `network_list` with `tile_type = agent` for connected-component agent discovery. Agent metadata is returned inside the tile `details` payload.

Permission boundary:

- Worker MCP tools expose the message surface plus:
  - `network_list`
  - `network_get`
  - `network_call`
- `tile_get`, `tile_rename`, `tile_move`, and `tile_resize` are root-only.
- Root MCP also exposes `browser_drive`.
- Worker `network_call` is limited to visible local-network tiles and only to the worker-safe message subset for each tile kind. `shell` and directly controlled `browser` tiles expose write actions; `agent` and `root_agent` tiles stay read-only even when directly connected.
- The raw socket is also used by the app, tests, and local CLI automation for session-scoped network/work actions.
- Direct work stage mutation is still gated by the derived owner connection.

Message-channel behavior:

- Herd delivers incoming agent traffic through `notifications/claude/channel`.
- Event metadata includes `from_agent_id`, `from_display_name`, `to_agent_id`, `to_display_name`, `topics`, `mentions`, `replay`, and `timestamp_ms`.
- `replay=true` means historical context, usually last-hour chatter replay, not a fresh request.
- `replay=false` means live traffic.
- Replies that should be seen by Herd or other agents must go back out through `message_direct`, `message_public`, `message_network`, or `message_root`.

### Topic messaging

- `message_topic_list`
- `message_topic_subscribe`
- `message_topic_unsubscribe`

Topics are normalized lowercase and always stored with a leading `#`. Topic list and subscription data are session-private. Subscribing to a missing topic creates it in the caller's current session.

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

`message_api` is filtered by the same access rules as `responds_to`.

Today the read interface is:

- `shell`: `get`, `call`, `output_read`
- `agent` / `root_agent`: `get`, `call`, `output_read`
- `browser`: `get`, `call`
- `work`: `get`, `call`

`network_get` is a worker-safe lookup by `tile_id` inside the sender's current connected component. It returns the same tile object shape used by `network_list.tiles`. For actionable calls, inspect `message_api` for required args and browser `drive` subcommands instead of guessing nested payload shapes.

`network_call` is a worker-safe generic tile call by `tile_id` inside the sender's current connected component. It accepts:

- `tile_id`
- `action`
- optional `args` object

`network_call` enforces the same port-aware access model used by `network_list` / `network_get`. A worker can only invoke message names exposed in that target tile's network-visible `responds_to` list for its current sender tile.

Agents should use `message_direct`, `message_network`, `message_public`, or `message_root` to coordinate with other agents. The network tile interface for `agent` and `root_agent` tiles is intentionally observational only.

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

For shell tiles, `exec` submits `<command>` plus Enter to the existing pane. It does not respawn or replace the target shell process.

For generic `network_call` / `tile_call`, browser `drive` expects:

- `action`: `click` | `type` | `dom_query` | `eval`
- optional nested `args` object for that browser-drive action

Browser tile `message_api` now spells this out directly:

- `navigate`
  - `url: string`
- `load`
  - `path: string`
- `drive`
  - `action: "click" | "type" | "dom_query" | "eval"`
  - optional `args: object`
  - `click`
    - `selector: string`
  - `type`
    - `selector: string`
    - `text: string`
    - optional `clear: boolean` defaulting to `true`
  - `dom_query`
    - `js: string`
  - `eval`
    - `js: string`

Generic tile messages reject:

- tiles outside the sender's local network
- other sessions
- tile-specific action names not exposed for that tile kind

Every socket-backed command now passes through the same internal message-delivery layer except the dedicated streaming `agent_events_subscribe` path. Session-scoped list, create, destroy, registry, topic, network, and message operations route through the session receiver, tile-instance operations route through tile receivers, and test/debug commands route through the herd receiver. Herd records structured `tile_message_logs` entries with `channel = cli | socket | mcp | internal`, target metadata, wrapper command, message name, args, outcome, and timing.

`tile_move` is root-only and accepts `tile_id`, `x`, and `y`. It updates the canvas position for the tile and returns the updated tile object.

`tile_resize` is root-only and accepts `tile_id`, `width`, and `height`. It updates the canvas size for the tile and returns the updated tile object.

Work items are session-scoped. Use `tile_list` with `tile_type = work` for work discovery and `tile_get` for a single work tile payload. `tile_get` returns the common tile fields plus work-specific `details`. Tile creation for `tile_type = work` routes through the session receiver/message path, while `work_stage_start`, `work_stage_complete`, `work_review_approve`, and `work_review_improve` route through the work tile receiver/message path. Work items follow:

- stages: `plan -> prd -> artifact`
- statuses: `ready -> in_progress -> completed -> approved`

Each work item auto-creates topic `#<work_id>` and SQLite-backed stage content for:

- `plan`
- `prd`
- `artifact`

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
- Toolbar and sidebar control: `toolbar_select_tab`, `toolbar_add_tab`, `toolbar_spawn_shell`, `toolbar_spawn_agent`, `toolbar_spawn_work`, `sidebar_open`, `sidebar_close`, `sidebar_select_item`, `sidebar_move_selection`, `sidebar_begin_rename`
- Tile and canvas control: `tile_select`, `tile_close`, `tile_drag`, `tile_resize`, `tile_title_double_click`, `canvas_pan`, `canvas_context_menu`, `canvas_zoom_at`, `canvas_wheel`, `canvas_fit_all`, `canvas_reset`, `tile_context_menu`, `context_menu_select`, `context_menu_dismiss`
  These tile-oriented requests now take Herd `tile_id`, not tmux pane ids.
- Close-confirm flow: `confirm_close_tab`, `cancel_close_tab`

The projection now includes debug and agent state such as:

- `debug_tab`
- `agents`
- `topics`
- `chatter`
- `connections`
- per-tile port/network-derived state used by the canvas and activity views

For programmatic examples, see [tests/integration/client.ts](/Users/skryl/Dev/herd/tests/integration/client.ts).

`test_dom_query` and `test_dom_keys` are still available behind the same gate, but they are manual debugging helpers rather than the supported automated integration surface.
