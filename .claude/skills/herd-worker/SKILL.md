---
name: herd-worker
description: Worker-only Herd skill. Use message tools and local-network MCP calls only.
---

# Herd Worker

Use Herd through the worker MCP tools only. Do not run `herd`, `bin/herd`, `HERD_BIN`, `sudo`, or manual socket writes.

## Your Surface

You only have the worker MCP interface:

Messaging:
- `message_direct`
- `message_public`
- `message_channel`
- `message_network`
- `message_root`

Self tile status and display:
- `self_info`
- `self_display_draw`
- `self_led_control`
- `self_display_status`

Local-network discovery and calls:
- `network_list`
- `network_get`
- `network_call`
- `network_subscribe`
- `network_unsubscribe`
- `network_subscription_list`

## Operating Rules

- If Root gives you an explicit tile id and an exact `network_call` shape to execute, do that first.
- In that explicit-dispatch case, skip `network_list` / `network_get` unless the call fails.
- Otherwise, use `network_list` or `network_get` before `network_call`.
- Call only actions advertised in a tile's `responds_to`.
- Inspect `message_api` for required args and browser-drive subcommands.
- Browser automation goes through `network_call` with browser action `drive`.
- Use `network_subscribe` with selectors like `in:exec`, `out:get`, `both:extension_call`, or `*:navigate` when you need live tile-call notifications from local-network tiles.
- Agent and `root_agent` tiles are read-only on the network.
- If the action you need is not on your local-network surface, ask Root through `message_root`.
- Use `self_display_status` for concise user-visible progress updates in your tile chrome.
- Use `self_led_control` sparingly when you need to draw the user's attention to a state change, warning, or completion.
- Reserve `self_display_draw` for richer frame-style output. Do not use it as a substitute for short status updates.

## Message Model

Incoming Herd traffic arrives through the Claude channel hook.

- `kind=direct`: private message to you
- `kind=public`: session-wide chatter
- `kind=network`: your local connected-network traffic
- `kind=system`: lifecycle notices
- `kind=tile_event`: live notifications for subscribed tile calls, plus implicit external calls on your own agent tile
- `kind=ping`: transport only
- `replay=true`: history, not a fresh assignment

Operational rules:

- Treat replay as context, not a new request.
- Use `message_direct` for targeted one-to-one replies.
- Use `message_public` for session-visible updates.
- Use `message_network` for local-network coordination.
- Use `message_root` when you need privileged session actions or Root-only tools.
- Plain assistant text in your local session does not publish back into Herd.

## Workflow

1. Review `/herd-worker`.
2. Read recent chatter and current channel traffic.
3. If Root sent an exact one-shot tile action, execute it directly.
4. Otherwise inspect your local network.
5. Use `network_call` only when the tile advertises the action.
6. Report findings and blockers through the message tools.

## Do Not

- Do not use `tile_call`.
- Do not use `browser_drive`.
- Do not try to control other agents through the network.
- Do not shell out to the Herd binary.
