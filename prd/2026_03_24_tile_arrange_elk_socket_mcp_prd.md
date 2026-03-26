# Title
Add `tile_arrange_elk` to the Socket API and Root MCP Surface

## Status
Completed

## Date
2026-03-24

## Context
Herd already has an ELK-based arrange mode in the frontend, triggered by `Shift+A`. Root agents do not have a socket or MCP tool for this behavior, so they cannot invoke the same arrangement path after creating and connecting tiles. The current root skill also does not teach Root to use ELK arrangement after building connected groups of tiles.

## Goals
- Add a root-only `tile_arrange_elk` socket command.
- Expose `tile_arrange_elk` through the Root MCP surface.
- Route the socket command into the existing frontend ELK arrangement behavior instead of adding a second layout engine.
- Update the Root Herd skill so Root uses `tile_arrange_elk` after adding more than one connected tile.

## Non-goals
- Do not change lowercase `a` behavior.
- Do not add a worker MCP tool for ELK arrangement.
- Do not add a second backend ELK implementation.
- Do not add compatibility aliases or alternate arrange commands.

## Scope
- Rust socket protocol and server handling
- Frontend app event listener bridge
- Root MCP tool registration and parity tests
- Root skill guidance

## Risks and mitigations
- Risk: creating a second layout implementation would drift from `Shift+A`.
  - Mitigation: emit a frontend event that calls the existing `autoArrangeWithElk`.
- Risk: the root tool could be added without root gating.
  - Mitigation: use the same root-only sender validation path as `tile_move` and `tile_resize`.
- Risk: root agents keep manually moving tiles after connecting them.
  - Mitigation: update the root skill with an explicit post-connection rule.

## Acceptance criteria
- `tile_arrange_elk` is accepted by the socket protocol and handled as a root-only session mutation.
- Root MCP exposes `tile_arrange_elk`; worker MCP does not.
- The frontend receives the backend event and runs `autoArrangeWithElk(sessionId)` for the target session.
- The root Herd skill explicitly tells Root to use `tile_arrange_elk` after creating multiple connected tiles.
- Targeted tests and checks pass.

## Phased Plan (Red/Green)

### Phase 0
#### Objective
Add failing assertions for the new root surface and session-message support.

#### Red
- Extend MCP parity expectations to require `tile_arrange_elk` in the root-only tool list.
- Add socket-server assertions that the session message surface includes `tile_arrange_elk`.
- Expected failure signal:
  - root MCP parity test fails because `tile_arrange_elk` is missing
  - socket-server unit test fails because the session receiver does not advertise `tile_arrange_elk`

#### Green
- Add the new root tool name to the MCP registry and session receiver surface.
- Add socket protocol and command handling for `tile_arrange_elk`.

#### Exit criteria
- The new tests pass and the command is recognized end-to-end through Rust and MCP registration.

### Phase 1
#### Objective
Bridge the socket command to the existing frontend ELK arrangement path.

#### Red
- Add a frontend store/app test proving the new event listener calls `autoArrangeWithElk(sessionId)`.
- Expected failure signal:
  - the new listener test fails because there is no listener or no callback into the ELK arranger

#### Green
- Emit a new Tauri app event from the socket server.
- Listen for that event in `App.svelte`.
- Call `autoArrangeWithElk` with the requested session id.

#### Exit criteria
- The new listener/event path is covered and `tile_arrange_elk` invokes the same arrange logic as `Shift+A`.

### Phase 2
#### Objective
Teach Root to use the new tool after building connected layouts.

#### Red
- Update the root skill text and verify the file contains explicit guidance for post-connection arrangement.
- Expected failure signal:
  - stale skill text omits the new tool and the workflow rule

#### Green
- Add `tile_arrange_elk` to the root skill surface.
- Add an explicit workflow rule to use it after creating more than one connected tile.

#### Exit criteria
- Root skill reflects the current MCP surface and the new usage rule.

## Execution Checklist
- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Phase 2 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log
1. `sed -n '1,260p' src-tauri/src/socket/protocol.rs`
   - result: pass
   - notes: confirmed no `tile_arrange_elk` command exists yet
2. `sed -n '1,260p' mcp-server/src/index.test.ts`
   - result: pass
   - notes: confirmed root tool parity list is missing `tile_arrange_elk`
3. `sed -n '1,240p' .claude/skills/herd-root/SKILL.md`
   - result: pass
   - notes: confirmed root skill does not mention ELK arrangement
4. `npx vitest run --root mcp-server src/index.test.ts`
   - result: fail
   - notes: root tool parity failed because `tile_arrange_elk` was missing
5. `cargo test --manifest-path src-tauri/Cargo.toml socket::server::tests::session_message_surface_includes_tile_arrange_elk`
   - result: fail
   - notes: session receiver surface failed because `tile_arrange_elk` was missing
6. `npx vitest run --root mcp-server src/index.test.ts`
   - result: pass
   - notes: root MCP parity includes `tile_arrange_elk`
7. `cargo test --manifest-path src-tauri/Cargo.toml socket::server::tests::session_message_surface_includes_tile_arrange_elk`
   - result: pass
   - notes: session receiver advertises `tile_arrange_elk`
8. `npx vitest run src/lib/appEvents.test.ts src/lib/interaction/keyboard.test.ts`
   - result: pass
   - notes: event bridge calls `autoArrangeWithElk`, and keyboard ELK shortcut regression still passes
9. `npm run check`
   - result: pass
   - notes: Svelte and TypeScript checks are clean
10. `npm --prefix mcp-server run build`
   - result: pass
   - notes: root MCP package builds successfully
11. `git diff --check`
   - result: pass
   - notes: no whitespace or patch formatting issues
