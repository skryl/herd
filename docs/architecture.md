# Herd Architecture

Herd is an experiment platform for agent collaboration: explicit message channels, visible local-network discovery, and a Root agent that can coordinate a shared canvas. This document describes the current runtime architecture that makes that model work.

It focuses on the concepts that matter when you are changing behavior or debugging the system:

- sessions and tabs
- tile kinds and identity
- lineage vs networks
- Root vs worker agent roles
- the Herd message model
- dynamic Work ownership
- persistence and runtime surfaces

## System Layers

Herd is split into 4 cooperating layers:

1. `tmux`
   - owns terminal process lifecycle
   - owns panes, windows, sessions, focus, and scrollback
2. Rust backend
   - owns the Herd socket API
   - owns session-private registries
   - owns runtime persistence in SQLite
   - translates between tmux state, agent state, work state, and frontend state
3. Svelte/Tauri frontend
   - owns canvas layout, selection, zoom/pan, overlays, context menus, and keyboard UX
   - renders tiles, connections, sidebar state, debug state, and per-agent activity
4. MCP bridge
   - exposes Herd capabilities to Claude agents over stdio
   - also acts as the inbound Claude channel server for Herd-managed agents

The key architectural split is:

- `tmux` owns terminal reality
- Herd owns semantic reality

“Semantic reality” here means agents, work items, public chatter, networks, ownership, and UI state.

## Sessions And Tabs

A Herd tab maps to one tmux session.

Session scope is the main isolation boundary. These are session-private:

- agent registry
- topic registry
- chatter log
- tile network graph
- work registry
- Root agent

Cross-session reads and writes are rejected for those domains.

Every session has:

- one visible Root agent with stable id `root:<session_id>`
- zero or more worker agents
- zero or more shell/browser/work tiles

## Tile Model

Herd currently renders these tile kinds:

- Shell
- Agent
- Root Agent
- Browser
- Work

Terminal-backed tiles map to a tmux window and primary pane. Work tiles are registry-backed and do not map to tmux panes.

Important identity fields:

- `tile_id`
  - canonical tile identity used in the network graph
  - assigned by Herd, not by tmux
  - tmux-backed tiles use short mixed-case Herd ids such as `AbCdEf`
  - work tiles use synthetic ids such as `work:work-s4-001`
- `window_id`
  - tmux window id when applicable
- `session_id`
  - the containing tmux session/tab

Herd keeps the backing `tile_id -> tmux window/pane` mapping internally. Public control APIs target `tile_id`; tmux pane ids are implementation detail used for reconciliation and runtime operations.

## Lineage vs Networks

Herd has two different relationships between tiles:

1. Lineage
2. Network connectivity

They are not the same thing.

### Lineage

Lineage is provenance. It answers:

- “what spawned this tile?”
- “should a parent/child line be drawn?”

Rules:

- user-created tiles are rooted at the hidden session root
- only agent-created Agent tiles use visible agent parentage
- parent window metadata is preserved even when the line is not drawn
- parent lines are only rendered for hook-triggered lineage

Lineage does not affect:

- `network_list`
- `message_network`
- Work ownership

### Networks

Networks are session-local connected components over manual port connections.

They answer:

- “which tiles are physically connected?”
- “who receives `message_network`?”
- “which Agent owns this Work tile?”

Only manual port connections participate in the graph.

## Ports And Connections

Every visible tile has 4 side ports:

- `left`
- `top`
- `right`
- `bottom`

Each port has a mode:

- `read`
- `read_write`

Current port rules:

- Agent, Root Agent, Shell
  - all 4 ports are `read_write`
- Work, Browser
  - `left = read_write`
  - `top/right/bottom = read`

Connection validation rules:

- connections are session-local only
- a tile cannot connect to itself
- `read -> read` is invalid
- at least one endpoint must be `read_write`
- one connection may occupy a visible port at a time
- Work and Browser `left` ports only accept Agent or Root Agent tiles

The graph is undirected for connectivity purposes, even though each stored connection has a normalized endpoint ordering.

## Agents

Agent records currently carry:

- `agent_id`
- `agent_type`
- `agent_role`
- `tile_id`
- `window_id`
- `session_id`
- `display_name`
- liveness and topic state

### Agent Type

Today the only agent type is:

- `claude`

The type field exists so the registry can grow to support other agent families later.

### Agent Roles

There are two roles:

- `root`
- `worker`

#### Root agent

Each session has exactly one Root agent.

Properties:

- stable id `root:<session_id>`
- visible red tile
- automatically created and repaired by Herd
- closable only through confirmation
- immediately respawned if closed or if Herd detects it as dead
- full Herd MCP surface

The Root agent is the session coordinator.

#### Worker agents

Workers are normal session agents.

Properties:

- worker-safe local-network MCP surface
- browser tile automation through `network_call` with browser action `drive`
- visible local-network tiles may be inspected through `network_list` / `network_get`
- direct control is limited to worker-safe `shell` and `browser` actions
- `agent` and `root_agent` tiles stay read-only on the network, even when directly connected
- no direct access to privileged Herd actions through MCP
- expected to ask Root for privileged actions

## MCP Surface And Permissions

All Herd-managed agents launch against the same checked-in MCP entry:

- `server:herd`

The server changes behavior at runtime based on:

- `HERD_AGENT_ROLE`
- `HERD_AGENT_ID`

### Worker MCP surface

Workers get:

- `message_direct`
- `message_public`
- `message_network`
- `message_root`
- `network_list`
- `network_get`
- `network_call`

### Root MCP surface

Root gets the worker tools plus the full session control surface:

- shell tools
- browser tools
- topic listing and session-scoped tile discovery
- session and network mutation tools
- work inspection and work-stage tools

### Backend permission boundary

The MCP tool restriction is not the only guardrail. The Rust socket backend also enforces the role boundary.

Meaning:

- workers should not be able to gain privileged behavior by bypassing MCP and talking to the socket directly as agents
- workers may inspect visible local-network tiles, but the callable network surface is filtered by tile kind and network access
- workers may control `shell` and eligible `browser` tiles through the worker-safe generic tile-message subset
- `agent` and `root_agent` tiles remain observational only on the network
- privileged session mutations still require Root or user-originated paths

## Messaging Model

Messaging is central to Herd.

There are 4 semantic message paths:

- direct
- public
- network
- root

### Direct

Direct messages are private point-to-point coordination.

- socket command: `message_direct`
- CLI: `herd message direct ...`
- MCP: `message_direct`
- chatter display: `Sender -> Recipient: message`

### Public

Public messages are session-wide chatter.

- socket command: `message_public`
- CLI: `herd message public ...`
- MCP: `message_public`
- chatter display: `Sender -> Chatter: message`

Public messages may carry:

- `@mentions`

Channel messages are subscription-scoped chatter.

- socket command: `message_channel`
- CLI: `herd message channel ...`
- MCP: `message_channel`
- chatter display: `Sender -> #channel: message`

### Network

Network messages go to the other agents on the sender’s current connected component.

- socket command: `message_network`
- CLI: `herd message network ...`
- MCP: `message_network`
- chatter display: `Sender -> Network: message`

Recipients are:

- only agents on the same session-local connected component
- excluding the sender

### Root

Root messages go only to the current session Root agent.

- socket command: `message_root`
- CLI: `herd message root ...`
- MCP: `message_root`
- CLI alias: `sudo`
- chatter display: `Sender -> Root: message`

### Sender identities

Messages may originate as:

- an Agent
- `HERD`
  - system-driven runtime messages
- `User`
  - UI-originated command-bar messages such as `:sudo`, `:dm`, and `:cm`

## Inbound Claude Channel

When a Herd-managed agent is running, the MCP bridge:

1. registers the agent
2. subscribes to agent events
3. forwards those events to Claude through `notifications/claude/channel`
4. acknowledges backend `PING` events for liveness

Channel event kinds:

- `direct`
- `public`
- `network`
- `root`
- `system`
- `ping`

Important metadata fields:

- `from_agent_id`
- `from_display_name`
- `to_agent_id`
- `to_display_name`
- `channels`
- `mentions`
- `replay`
- `timestamp_ms`

Critical rule:

- if an agent wants Herd or another agent to see a response to channel traffic, it must reply through the Herd messaging tools
- plain assistant text in the local Claude session does not go back onto Herd channels

`replay=true` means historical context, not a fresh request.

## Agent Activity And Logs

Each agent tile has an activity window below the shell.

That activity view aggregates:

- incoming DMs
- outgoing DMs
- outgoing public chatter
- relevant public chatter by mention/topic
- agent log entries

Agent log entries currently include:

- incoming MCP channel hooks
- outgoing MCP tool calls

Those logs are persisted and projected into the activity view so operators can see what an agent actually heard and what it tried to do.

## Work Model

A Work item is a session-local tracked artifact with:

- stable `work_id`
- title
- topic `#<work_id>`
- current stage
- per-stage status
- review history
- derived owner

### Stages

Stages are ordered:

- `plan`
- `prd`
- `artifact`

Each stage has SQLite-backed markdown content stored alongside its workflow state.

### Statuses

Each active stage moves through:

- `ready`
- `in_progress`
- `completed`
- `approved`

Rules:

- only the owner may start or complete a stage
- user review approves or sends back for improvement
- `improve` requires a comment and returns the stage to `in_progress`
- approving `artifact` completes the item

### Ownership

Work ownership is dynamic.

It is not assigned by a stored owner field in the product model. It is derived from the network graph:

- the owner is the live Agent connected directly to the Work tile’s `left` port
- if that connection disappears, ownership disappears immediately
- if the owning agent dies and its edges are removed, ownership disappears automatically

This is why network connectivity is not cosmetic. It is part of the authorization model.

## Persistence

Herd persists runtime state in SQLite under the repo `tmp/` directory:

- default: `tmp/herd.sqlite`
- runtime-scoped: `tmp/herd-<runtime_id>.sqlite`

SQLite stores:

- tile/layout state
- stable tile registry and tmux backing metadata
- agent registry
- channels
- chatter
- agent logs
- work metadata and stage content
- network connections

There is no separate persisted `work/` content directory in the current runtime model; work stage documents live in SQLite.

## UI Surfaces

The main UI surfaces are:

- canvas
  - tiles
  - network edges
  - hook-triggered lineage lines
- sidebar
  - `SETTINGS`
  - `WORK`
  - `AGENTS`
  - `TMUX`
- debug pane
  - `Info`
  - `Logs`
  - `Chatter`
- per-agent activity windows

The sidebar is compact and selection-oriented. The canvas is the detailed spatial view.

## Typical Flow

### Session startup

1. Herd reconnects to or creates its isolated tmux server.
2. The active session/tab is hydrated into frontend state.
3. Herd ensures one Root agent exists for each session.
4. Agent/work/topic/chatter/network state is loaded from SQLite.

### Worker coordination

1. Worker receives a message over the Claude channel.
2. Worker interprets the message kind and `replay` flag.
3. Worker replies with Herd message tools, not plain assistant text, if the reply should be visible.
4. If the task requires privileged Herd operations, the worker escalates to Root with `message_root`.

### Work ownership

1. An Agent connects to a Work tile’s left port.
2. That agent becomes the derived owner.
3. The owner starts and completes stages.
4. The user approves or improves the current stage.
5. Disconnecting the owner clears ownership immediately.

## Mental Model

If you need a compact mental model for Herd, use this:

- tmux owns terminals
- SQLite owns session state
- ports own connectivity
- networks own local coordination
- the left Work port owns authorization
- Root owns privileged session control
- channel messages are input only until an agent explicitly replies through Herd messaging
