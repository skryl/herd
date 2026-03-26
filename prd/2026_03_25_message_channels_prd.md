# Message Channels And Channel-Scoped Chatter

## Status
Complete

## Date
2026-03-25

## Context
Herd currently stores message topics as metadata on public chatter, exposes `message_topic_*` APIs, and broadcasts public chatter to every live agent in the session whether or not they subscribe to those topics. The requested behavior is to replace topics with channels, add an explicit `message_channel` command surface, let root manage channel subscriptions for agents, and enforce channel-scoped visibility so agents only receive channel chatter when they are subscribed.

## Goals
- Replace the message topic API and data model with channels.
- Add a first-class `message_channel` socket, CLI, and MCP command.
- Let root subscribe or unsubscribe any agent to channels in its session.
- Require agents to be subscribed before they can publish to a channel.
- Deliver live and replayed channel chatter only to agents subscribed to the relevant channel.

## Non-goals
- Reworking direct, root, or local-network message flows.
- Changing the existing work-item `topic` field or work registry semantics in this change.
- Keeping topic aliases or compatibility fallbacks after the rename.

## Scope
- Rust chatter/channel state, socket protocol, dispatch, and replay logic.
- CLI help text, payload builders, and tests.
- MCP tool names, schemas, server prompt text, and tests.
- Frontend/shared types and activity classification for channel metadata.
- Focused integration coverage for root-managed subscriptions and channel delivery.

## Risks And Mitigations
- Renaming the public types from topics to channels touches Rust, TypeScript, MCP, and tests together.
  - Mitigation: add failing coverage first and replace the command surface in one change instead of carrying aliases.
- Channel delivery changes could accidentally hide regular session-wide public chatter.
  - Mitigation: keep `message_public` as the session-wide broadcast path and confine channel gating to `message_channel`.
- Replay semantics could leak channel history to unsubscribed agents.
  - Mitigation: filter replayed channel chatter against the subscribing agent’s current channel set.

## Acceptance Criteria
- `message_topic_list`, `message_topic_subscribe`, and `message_topic_unsubscribe` no longer exist in the public socket/CLI/MCP surface.
- Root uses `message_channel_list`, `message_channel_subscribe`, and `message_channel_unsubscribe`.
- Agents can call `message_channel` only when subscribed to the requested channel.
- Live `message_channel` events are delivered only to agents subscribed to that channel in the same session.
- First agent event subscription replays only the recent channel chatter for channels that agent is currently subscribed to.
- Shared types and activity metadata use `channels` terminology instead of `topics` for chatter/agent messaging state.

## Phase 0
### Objective
Lock the new command surface and channel delivery behavior with failing coverage.

### Red
- Add/update tests that expect:
  - CLI payloads for `message channel list|subscribe|unsubscribe|<channel> <message>`
  - MCP tool names to expose `message_channel`, `message_channel_list`, `message_channel_subscribe`, and `message_channel_unsubscribe`
  - agent event delivery to exclude unsubscribed agents from channel chatter
  - sender rejection when calling `message_channel` without a subscription

### Expected Failure Signal
- Existing tests still reference topic commands, no `message_channel` path exists, and unsubscribed agents still receive all public chatter.

### Green
- Replace the tests and tool surfaces to the new channel names and assertions.

### Verification Commands
- `cargo test --manifest-path src-tauri/Cargo.toml cli::tests`
- `npx vitest run --root mcp-server src/index.test.ts`

### Exit Criteria
- Tests fail specifically because the old topic/public-broadcast behavior still exists.

## Phase 1
### Objective
Implement channel state, command routing, and channel-scoped delivery.

### Red
- Run focused Rust/integration checks after the protocol/state changes.

### Expected Failure Signal
- Compile or runtime failures around renamed commands, agent metadata, or event routing/replay logic.

### Green
- Replace topic data/types/commands with channel equivalents and add `message_channel`.
- Enforce subscription checks and channel-filtered live/replay delivery.

### Verification Commands
- `cargo test --manifest-path src-tauri/Cargo.toml agent::tests`
- `cargo test --manifest-path src-tauri/Cargo.toml cli::tests`
- `cargo check --manifest-path src-tauri/Cargo.toml`

### Exit Criteria
- Rust builds with the new channel semantics and no topic command path remains.

## Phase 2
### Objective
Update MCP, frontend/shared types, and integration coverage to the final channel semantics.

### Red
- Re-run focused MCP and integration tests against the renamed command surface.

### Expected Failure Signal
- MCP still advertises topic tools, integration clients still call topic commands, or channel delivery assertions fail.

### Green
- Update MCP tools/docs, integration clients/helpers, and frontend/shared types/activity classification to channels.

### Verification Commands
- `npx vitest run --root mcp-server src/index.test.ts`
- `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "routes session-scoped socket commands through the session receiver"`
- `npm run test:integration -- tests/integration/work-registry.test.ts -t "delivers channel chatter only to subscribed agents and replays subscribed channel history"`

### Exit Criteria
- Root and worker tool surfaces reflect channels only, and focused integration coverage passes.

## Execution Checklist
- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Phase 2 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log
1. `sed -n '1,220p' /Users/skryl/.codex/skills/phased-prd-red-green/SKILL.md`
   - result: pass
   - notes: loaded the required phased PRD workflow.
2. `sed -n '1,260p' /Users/skryl/.codex/skills/phased-prd-red-green/references/prd_red_green_template.md`
   - result: pass
   - notes: loaded the PRD template and red/green checklist.
3. `rg -n "chatter|subscribe|topic|publish|unsubscribe" src src-tauri tests -S`
   - result: pass
   - notes: traced the current topic/chatter implementation across Rust and integration code.
4. `rg -n "message_topic|topic subscribe|topic unsubscribe|message public|message chatter|topic list|topics" mcp-server src-tauri/src tests README.md docs -S`
   - result: pass
   - notes: captured the full rename surface across MCP, CLI, docs, tests, and shared types.
5. `cargo test --manifest-path src-tauri/Cargo.toml cli::tests`
   - result: pass
   - notes: verified the CLI channel command payloads and the removal of topic-based public payload metadata.
6. `cargo test --manifest-path src-tauri/Cargo.toml agent::tests`
   - result: pass
   - notes: verified channel normalization and display formatting helpers.
7. `cargo check --manifest-path src-tauri/Cargo.toml`
   - result: pass
   - notes: Rust builds cleanly with the channel-based socket/state model.
8. `npx vitest run --root mcp-server src/index.test.ts`
   - result: pass
   - notes: MCP tool surface now exposes `message_channel` and the root-only channel management tools.
9. `npm run test:unit -- --run src/lib/stores/appState.test.ts`
   - result: pass
   - notes: frontend shared types and activity classification now use channel metadata.
10. `npm run test:integration -- tests/integration/worker-root-mcp.test.ts -t "routes session-scoped socket commands through the session receiver"`
    - result: pass
    - notes: verified the renamed session receiver command surface through the MCP/root path.
11. `npm run test:integration -- tests/integration/work-registry.test.ts -t "delivers channel chatter only to subscribed agents and replays subscribed channel history"`
    - result: pass
    - notes: verified root-managed subscriptions, live channel delivery, filtered replay, and sender rejection after unsubscribe.
