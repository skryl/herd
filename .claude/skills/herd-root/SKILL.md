---
name: herd-root
description: Root-only Herd skill. Use the full session MCP surface to inspect, configure, and coordinate the canvas.
---

# Herd Root

Use Herd through Root's MCP tools only. Do not run `herd`, `bin/herd`, `HERD_BIN`, `sudo`, or manual socket writes.

## Your Surface

You have the worker message tools plus the full session-wide Root surface.

Messaging:
- `message_direct`
- `message_public`
- `message_network`
- `message_root`

Discovery and generic calls:
- `tile_list`
- `tile_get`
- `tile_call`
- `network_list`
- `network_get`
- `network_call`

Canvas and network control:
- `tile_create`
- `tile_destroy`
- `tile_rename`
- `tile_move`
- `tile_resize`
- `tile_arrange_elk`
- `network_connect`
- `network_disconnect`

Tile-specific Root tools:
- `shell_input_send`
- `shell_exec`
- `shell_output_read`
- `shell_role_set`
- `browser_navigate`
- `browser_load`
- `browser_drive`
- `work_stage_start`
- `work_stage_complete`
- `work_review_approve`
- `work_review_improve`
- `message_topic_list`
- `message_topic_subscribe`
- `message_topic_unsubscribe`

`browser_drive` supports `click`, `select`, `type`, `dom_query`, `eval`, and `screenshot`. `screenshot` can return an image, dithered Braille text, ASCII grayscale text, ANSI-colored text, or layout-preserving DOM text via `args.format`.

## Operating Rules

- Inspect the session with `tile_list` and `tile_get` before mutating it.
- Use `tile_call` or the dedicated Root tools only for actions the tile advertises.
- Use `browser_drive` only as Root.
- Keep workers on their narrower local-network surface; route privileged actions through Root.
- After you add more than one tile and connect them, call `tile_arrange_elk` to reflow the canvas instead of manually nudging connected groups tile by tile.
- If you want Herd traffic to be visible to agents, answer through the message tools, not plain assistant text.

## Message Model

Incoming Herd traffic arrives through the Claude channel hook.

- `kind=direct`: private message
- `kind=public`: session-wide chatter
- `kind=network`: local connected-network chatter
- `kind=root`: direct traffic for Root
- `kind=system`: lifecycle notices
- `kind=ping`: transport only
- `replay=true`: history, not a fresh assignment

Operational rules:

- Treat replay as context, not a new request.
- Use `message_direct` for targeted replies.
- Use `message_public` for session-visible updates.
- Use `message_network` when you want only a local connected component to see the reply.
- Use `message_root` only when you need to explicitly route through the Root channel.

## Workflow

1. Review `/herd-root`.
2. Inspect session state.
3. Triage incoming Root requests.
4. Configure the canvas or network when needed.
5. Coordinate workers with short, explicit messages.

## Do Not

- Do not use worker-only assumptions about local visibility.
- Do not tell workers to use Root-only tools.
- Do not shell out to the Herd binary.
