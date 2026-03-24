# Generic Session Tile Commands PRD

## Header

1. Title: Generic Session Tile Commands
2. Status: In Progress
3. Date: 2026-03-22

## Context

The socket, CLI, and MCP surfaces still expose tile creation and destruction through type-specific commands such as `shell_create`, `browser_create`, `agent_create`, `work_create`, `shell_destroy`, and `browser_destroy`. Session-scoped listing is also exposed as `session_list`. That leaves duplicate public APIs for the same session-level concept and conflicts with the repo rule against keeping legacy paths after a behavior replacement.

The session receiver already owns the session-scoped message bus path for these operations. The remaining work is to collapse the public command surface onto generic session tile commands without keeping the old wrappers.

## Goals

- Replace the public session-scoped tile creation API with `tile_create`.
- Replace the public session-scoped tile destruction API with `tile_destroy`.
- Replace the public session-scoped tile listing API with `tile_list`.
- Remove the old per-type `*_create`, `*_destroy`, and `session_list` commands from socket, CLI, MCP, docs, and tests in the same change.
- Keep the message-bus boundary intact: session-scoped commands go through the session receiver, tile-instance commands go through tile receivers.

## Non-goals

- Changing tile-instance commands such as `tile_get`, `tile_call`, `tile_send`, `tile_move`, `tile_resize`, `shell_exec`, `browser_navigate`, or work stage transitions.
- Changing `network_list` or `network_get`.
- Introducing compatibility aliases for removed commands.

## Scope

- Socket protocol enum and handler routing.
- Session receiver message surface and dispatch.
- CLI help and payload builders.
- MCP tool registrations and root tool surface.
- Integration/unit tests and docs.

## Risks and mitigations

- Risk: `agent_create` currently returns immediate launch metadata, while session tile info may lag agent registration.
  - Mitigation: keep `tile_create` behavior correct first; for agent creation, return a coherent create response based on the created tile/session context and targeted tests.
- Risk: `work_create` is not pane-backed and needs different destroy cleanup than tmux tiles.
  - Mitigation: route `tile_destroy` through a single session receiver path that branches by tile kind and uses the existing work cleanup helpers for work tiles.
- Risk: CLI/MCP churn can leave stale commands behind.
  - Mitigation: remove old registrations/builders entirely and add parity tests for the new surface.

## Acceptance criteria

- `tile_create`, `tile_destroy`, and `tile_list` exist in the socket protocol and route through `SessionMessageReceiver`.
- `shell_create`, `browser_create`, `agent_create`, `work_create`, `shell_destroy`, `browser_destroy`, and `session_list` are removed from the public socket API.
- CLI and MCP expose the new generic tile session commands and no longer expose the removed commands.
- `tile_destroy` handles pane-backed tiles and work tiles correctly.
- Targeted tests demonstrate that the old commands are gone and the new commands are wired through the session receiver and logs.

## Phased Plan (Red/Green)

### Phase 0

1. Objective
   - Lock the intended command replacement and remove ambiguity before code changes.
2. Red
   - Inspect protocol, CLI, MCP, receiver routing, and tests for every old public command to be removed.
   - Expected failure signal: n/a, discovery phase.
3. Green
   - Record the replacement map in this PRD.
4. Exit criteria
   - The replacement surface is explicit:
     - `tile_create`
     - `tile_destroy`
     - `tile_list`
     - existing tile-instance commands unchanged.

### Phase 1

1. Objective
   - Replace the socket/session receiver public command surface.
2. Red
   - Update protocol/tests first so the new commands are required and the old commands are rejected.
   - Expected failure signal: compile/test failures because `tile_create`, `tile_destroy`, and `tile_list` do not exist yet.
3. Green
   - Add `tile_create`, `tile_destroy`, and `tile_list` to the protocol.
   - Route them through `SessionMessageReceiver.send(...)`.
   - Remove `shell_create`, `browser_create`, `agent_create`, `work_create`, `shell_destroy`, `browser_destroy`, and `session_list`.
4. Exit criteria
   - Socket command parsing and routing work only through the new generic commands.

### Phase 2

1. Objective
   - Replace CLI and MCP public surfaces.
2. Red
   - Update CLI and MCP parity tests to require the new tool/command names.
   - Expected failure signal: payload/help/parity tests still reference removed commands.
3. Green
   - Replace CLI subcommands with `tile create`, `tile destroy`, and `tile list`.
   - Replace MCP root tools with generic tile session tools.
   - Remove old CLI/MCP registrations.
4. Exit criteria
   - CLI and MCP no longer expose removed commands.

### Phase 3

1. Objective
   - Update docs and integration coverage, then verify regressions.
2. Red
   - Update focused integration assertions to expect the new wrapper names and failures for removed commands.
   - Expected failure signal: integration/doc parity mismatches.
3. Green
   - Update docs and integration helpers to the new generic commands.
   - Run targeted backend, CLI, MCP, and integration checks.
4. Exit criteria
   - Targeted verification is green and the documentation matches the live API.

## Execution Checklist

- [x] Phase 0 complete
- [ ] Phase 1 complete
- [ ] Phase 2 complete
- [ ] Phase 3 complete
- [ ] Integration/regression checks complete
- [ ] Documentation/status updated

## Command Log

1. `pwd && git status --short`
   - result: pass
   - notes: confirmed active repo state before this change
2. `sed -n '1,220p' /Users/skryl/.codex/skills/phased-prd-red-green/SKILL.md`
   - result: pass
   - notes: loaded required workflow instructions
3. `sed -n '1,220p' /Users/skryl/.codex/skills/phased-prd-red-green/references/prd_red_green_template.md`
   - result: pass
   - notes: loaded template before writing this PRD
4. `rg -n "enum SocketCommand|tile_create|tile_destroy|tile_list|session_list|shell_create|browser_create|agent_create|work_create|shell_destroy|browser_destroy" ...`
   - result: pass
   - notes: mapped old/public command usage across protocol, CLI, MCP, docs, and tests
