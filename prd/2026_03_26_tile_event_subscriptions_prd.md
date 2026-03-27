# Tile Event Subscriptions PRD

## Goal

Add live tile-call subscriptions so:

- Root can subscribe any same-session agent to tile-call events on any tile with `tile_subscribe`.
- Workers can subscribe themselves to local-network tile-call events with `network_subscribe`.
- External calls on an agent or root-agent tile always notify that target agent even without an explicit subscription.

Delivery goes through the existing agent event stream / MCP channel hook as `kind="tile_event"`.

## Phases

### Phase 1: Backend Model

Status: Complete

- Add selector parsing for `in:<action>`, `out:<action>`, `both:<action>`, and `*:<action>`.
- Add persistent tile subscription records in runtime state and SQLite.
- Add socket command support for subscribe / unsubscribe / list.

### Phase 2: Event Delivery

Status: Complete

- Emit `tile_event` notifications from `network_call` and `tile_call`.
- Deliver explicit subscription events.
- Deliver implicit self-target events for external calls on `agent` / `root_agent` tiles.
- Gate worker `network_*` subscriptions by current network visibility at delivery time.

### Phase 3: API Surface

Status: Complete

- Add worker MCP tools: `network_subscribe`, `network_unsubscribe`, `network_subscription_list`.
- Add root MCP tools: `tile_subscribe`, `tile_unsubscribe`, `tile_subscription_list`.
- Add matching CLI verbs and command serialization coverage.
- Update Root and Worker skills with `tile_event` semantics and subscription guidance.

### Phase 4: Persistence And Verification

Status: In Progress

- Save and load subscriptions through saved session configurations.
- Add focused integration coverage for explicit subscription delivery and implicit self-target delivery.
- Run targeted backend, MCP, CLI, and integration checks.
