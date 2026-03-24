---
name: herd
description: Control the local Herd runtime through the supported herd CLI. Workers can message plus inspect and operate visible local-network shell/browser tiles; Root can use the full surface.
---

# Herd

Use the Herd CLI, not raw socket JSON.

## Resolve The CLI

Prefer the installed binary on `PATH`. Inside the repo, fall back to `bin/herd`.

```bash
if command -v herd >/dev/null 2>&1; then
  HERD_BIN=herd
else
  HERD_BIN="$PWD/bin/herd"
fi
```

When calling Herd from an Agent, always include:

```bash
--agent-pid "${CLAUDE_AGENT_PID:-${CLAUDE_PID:-$PPID}}"
```

Inside Herd-managed Agent tiles, `HERD_AGENT_ID`, `HERD_AGENT_ROLE`, and `HERD_SOCK` are already injected.

## Role Model

Every session has one Root agent and zero or more worker agents.

- Root agents can use the full Herd CLI and MCP surface.
- Worker agents can message plus inspect and operate visible local-network `shell` and `browser` tiles.
- If you are not Root, ask Root to do privileged Herd operations for you.

Check your role with:

```bash
printf 'agent=%s role=%s\n' "${HERD_AGENT_ID:-unknown}" "${HERD_AGENT_ROLE:-worker}"
```

## Worker Commands

If `HERD_AGENT_ROLE` is not `root`, use these commands:

```bash
"$HERD_BIN" --agent-pid "${CLAUDE_AGENT_PID:-${CLAUDE_PID:-$PPID}}" \
  message direct agent-1234 "Can you review #prd-7?"

"$HERD_BIN" --agent-pid "${CLAUDE_AGENT_PID:-${CLAUDE_PID:-$PPID}}" \
  message public "I am starting #prd-7 and syncing with @agent-1234"

"$HERD_BIN" --agent-pid "${CLAUDE_AGENT_PID:-${CLAUDE_PID:-$PPID}}" \
  message network "Need help on this local network"

"$HERD_BIN" --agent-pid "${CLAUDE_AGENT_PID:-${CLAUDE_PID:-$PPID}}" \
  message root "Please list local work items and assign me something useful."

"$HERD_BIN" --agent-pid "${CLAUDE_AGENT_PID:-${CLAUDE_PID:-$PPID}}" \
  sudo "Please list local work items and assign me something useful."

"$HERD_BIN" --agent-pid "${CLAUDE_AGENT_PID:-${CLAUDE_PID:-$PPID}}" \
  network list

"$HERD_BIN" --agent-pid "${CLAUDE_AGENT_PID:-${CLAUDE_PID:-$PPID}}" \
  network get %12

"$HERD_BIN" --agent-pid "${CLAUDE_AGENT_PID:-${CLAUDE_PID:-$PPID}}" \
  browser drive %12 dom_query '{"js":"document.title"}'

"$HERD_BIN" --agent-pid "${CLAUDE_AGENT_PID:-${CLAUDE_PID:-$PPID}}" \
  tile call %12 output_read

"$HERD_BIN" --agent-pid "${CLAUDE_AGENT_PID:-${CLAUDE_PID:-$PPID}}" \
  tile call %12 input_send '{"input":"pwd\n"}'
```

Notes:

- `message public` is the preferred public chatter command.
- `message network` sends to the other agents on your current local network.
- `message root` sends only to the Root agent for your current session.
- `sudo` is a shortcut for `message root`.
- `network list` and `network get` are the discoverability path for worker-safe local-network tools.
- `browser drive` is the supported way to click, type, query, or evaluate inside a visible local-network browser tile.
- `tile call` is only for the actions listed in a tile's `allowed_actions`.
- In v1, worker `tile call` is limited to visible local-network `shell` and `browser` tiles.
- Use `@agent_id` mentions and `#topic` tags in public messages when useful.

## Message Channel Model

Herd pushes incoming session traffic into the agent through the Claude channel hook.

Treat the incoming hook as a transport, not a command by itself:

- `kind=direct`
  - private message to you
  - usually needs a direct response or action
- `kind=public`
  - session-wide chatter
  - useful for status, claims, and coordination
- `kind=network`
  - message scoped to your current connected tile network
  - treat it as local-cluster coordination
- `kind=root`
  - message intended for the session Root agent
  - workers should normally send these, not receive them
- `kind=system`
  - sign-on/sign-off and other Herd lifecycle notices
  - informational unless the event affects current work
- `kind=ping`
  - transport liveness only
  - Herd/MCP handles it automatically; do not treat it as work

Hook metadata matters:

- `from_agent_id` and `from_display_name` identify the sender
- `to_agent_id` and `to_display_name` identify the intended target when present
- `topics` carries `#topic` tags from public chatter
- `mentions` carries `@agent_id` mentions from public chatter
- `replay=true` means historical context, not a fresh request
- `replay=false` means live traffic

Operational rules:

- Do not answer replayed chatter as if someone just asked you something.
- If a message arrives through the Claude channel and you want Herd, Root, or another agent to see your response, answer through the Herd messaging interface.
- Plain assistant text in your local Claude session is not a Herd message and will not be delivered back onto the session channels.
- Prefer `message direct` for one-to-one requests, reviews, and handoffs.
- Prefer `message public` for session-visible status and coordination.
- Prefer `message network` for agents on your current connected tile graph.
- Use `network list` or `network get` before calling a local-network tool.
- Use `browser drive` for browser-page DOM interaction.
- Use `tile call` only for actions explicitly advertised by that tile.
- Prefer `message root` or `sudo` when you need Root to inspect or act.
- If an incoming message is ambiguous, inspect the sender, channel kind, and `replay` flag before acting.

## Root Commands

If `HERD_AGENT_ROLE=root`, you can inspect and control the full session:

```bash
"$HERD_BIN" --agent-pid "${CLAUDE_AGENT_PID:-${CLAUDE_PID:-$PPID}}" list shells
"$HERD_BIN" --agent-pid "${CLAUDE_AGENT_PID:-${CLAUDE_PID:-$PPID}}" list agents
"$HERD_BIN" --agent-pid "${CLAUDE_AGENT_PID:-${CLAUDE_PID:-$PPID}}" list topics
"$HERD_BIN" --agent-pid "${CLAUDE_AGENT_PID:-${CLAUDE_PID:-$PPID}}" list network
"$HERD_BIN" --agent-pid "${CLAUDE_AGENT_PID:-${CLAUDE_PID:-$PPID}}" work list
```

Work and network commands are available from the CLI. Work stage updates still require you to be the derived owner of that work item through the graph connection:

```bash
"$HERD_BIN" --agent-pid "${CLAUDE_AGENT_PID:-${CLAUDE_PID:-$PPID}}" work show work-s4-001
"$HERD_BIN" --agent-pid "${CLAUDE_AGENT_PID:-${CLAUDE_PID:-$PPID}}" work create "Socket follow-up"
"$HERD_BIN" --agent-pid "${CLAUDE_AGENT_PID:-${CLAUDE_PID:-$PPID}}" network connect %7 left work:work-s4-001 left
"$HERD_BIN" --agent-pid "${CLAUDE_AGENT_PID:-${CLAUDE_PID:-$PPID}}" network disconnect %7 left
"$HERD_BIN" --agent-pid "${CLAUDE_AGENT_PID:-${CLAUDE_PID:-$PPID}}" work stage start work-s4-001
"$HERD_BIN" --agent-pid "${CLAUDE_AGENT_PID:-${CLAUDE_PID:-$PPID}}" work stage complete work-s4-001
```

Shell control is also root-only for agents:

```bash
"$HERD_BIN" shell spawn --x 180 --y 140 --width 640 --height 400 --parent-pane-id %1
"$HERD_BIN" shell send %2 "pwd\n"
"$HERD_BIN" shell exec %2 "echo hello from herd"
"$HERD_BIN" shell read %2
"$HERD_BIN" shell title %2 "Agent"
"$HERD_BIN" shell role %2 claude
```

Compatibility note: the shell commands still use `session_id` fields under the hood, but the value is the pane ID of the tile you are targeting.

## Session Scope

Agent, topic, chatter, network, and work commands are session-private. They only return data from the current tmux tab/session.

## Agent Workflow

When Herd signs you on, it sends:

1. a welcome DM from `HERD`
2. the last hour of public chatter replay on the channel stream

Expected workflow:

1. Review the `/herd` skill.
2. If you are a worker, inspect recent public activity, inspect your local network, and use `tile call` for visible local-network shell/browser tools when useful.
3. If you are Root, inspect the local session directly with `list ...` and `work ...`.
4. Coordinate through direct, public, network, and root messages.

## Do Not

- Do not use raw `socat` socket calls when the `herd` CLI can do the job.
- Do not target DMs by tile ID; direct messages target `agent_id`.
- Do not assume a worker agent can call `list`, `shell`, `topic`, or `work` commands directly outside the worker-safe `network list`, `network get`, and `tile call` path.
- Do not assume you are alone in the current session; coordinate through messages or Root.
