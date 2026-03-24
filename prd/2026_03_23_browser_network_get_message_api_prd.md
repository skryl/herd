## Title
Expose Structured Browser Message API Through `network_get`

## Status
Completed

## Date
2026-03-23

## Context
`network_get` and `network_list` currently expose tile capabilities only as a flat `responds_to: string[]` list. That is enough to tell an agent that a browser tile supports `drive`, but not enough to tell it which `drive` subcommands exist or which args each action requires.

This makes browser tiles harder to use through worker-safe `network_call`, because the caller has to guess nested browser-drive action names and arg shapes instead of reading them from the returned tile payload.

## Goals
- Add structured per-tile message metadata to the public tile payload shape.
- Make browser tiles advertise the full `drive` surface, including subcommands and action-specific args.
- Keep the metadata filtered by the same access rules already used for `responds_to`.
- Update docs and MCP guidance so agents know where to look for arg details.

## Non-goals
- Replacing `responds_to` with a different permission model.
- Changing the underlying browser drive implementation or action names.
- Adding full JSON Schema generation for every command in the system.

## Scope
- Backend tile/network DTOs and access-filtered serialization
- Shared TypeScript tile DTOs
- Browser/network integration coverage
- MCP tool descriptions/instructions that talk about `network_get`
- Socket docs for tile payloads

## Risks and mitigations
- Risk: new API metadata drifts from the real dispatch behavior.
  - Mitigation: derive it from the same tile kind/access rules already used for `responds_to`.
- Risk: read-only network visibility leaks write-only message details.
  - Mitigation: build the structured metadata with the same access filter used for `responds_to`.
- Risk: additive payload changes are only partially documented.
  - Mitigation: update the protocol docs and MCP guidance in the same change.

## Acceptance criteria
- `network_get` on a read/write-visible browser tile returns structured browser message metadata with:
  - `navigate(url)`
  - `load(path)`
  - `drive(action, args?)`
  - `drive` subcommands `click`, `type`, `dom_query`, and `eval` with their arg requirements
- Read-only browser visibility exposes only the read-safe `message_api` entries.
- Shared TS types include the new structured metadata field.
- MCP guidance tells agents to inspect the structured tile message API for args/subcommands.
- Docs describe the new tile payload field and browser `drive` subcommands.

## Phased Plan (Red/Green)

### Phase 0
Objective: Lock the desired public payload shape before implementation.

Red:
- Add failing tests for structured browser message metadata on `network_get`.
- Add failing tests for access-filtered `message_api` on read-only browser visibility.
- Expected failure signal:
  - tile payloads have only `responds_to`
  - browser `drive` has no subcommand or arg metadata

Green:
- Create the PRD and define the public `message_api` contract.

Verification commands:
- targeted Rust and integration tests after each phase

Exit criteria:
- The payload shape and browser metadata requirements are explicit and testable.

### Phase 1
Objective: Implement structured message metadata in backend tile payloads.

Red:
- Add failing backend tests for:
  - full browser `message_api`
  - access-filtered `message_api` for read-only callers
- Expected failure signal:
  - builder functions do not exist or do not match the expected shape

Green:
- Add shared backend message metadata structs/builders.
- Serialize `message_api` on session/network tile payloads.
- Filter `message_api` with the same network access rules as `responds_to`.

Verification commands:
- `cargo test --manifest-path src-tauri/Cargo.toml network::tests`

Exit criteria:
- Backend tile payloads expose correct structured browser message metadata.

### Phase 2
Objective: Propagate the contract through public clients and docs.

Red:
- Add failing integration/type assertions that browser `network_get` returns the structured API.
- Expected failure signal:
  - shared TS types are missing the field
  - integration expectations cannot read browser `drive` subcommands

Green:
- Update shared TypeScript DTOs.
- Update MCP descriptions/guidance.
- Update protocol docs and README where they describe browser worker flows.

Verification commands:
- `cargo test --manifest-path src-tauri/Cargo.toml`
- `npm run check`
- targeted integration/type checks

Exit criteria:
- Public callers can see and consume the new metadata end to end.

## Execution Checklist
- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Phase 2 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log
1. `rg -n "network_get|responds_to|browser_drive|drive" src-tauri mcp-server src tests docs README.md`
   - result: pass
   - notes: confirmed the current public tile payload only exposes flat `responds_to` names and browser docs describe `drive` args separately.
2. `cargo test --manifest-path src-tauri/Cargo.toml network::tests`
   - result: fail
   - notes: red signal was `cannot find function 'message_api' in this scope` and `cannot find function 'message_api_for_access' in this scope` after adding the new browser payload assertions.
3. `cargo test --manifest-path src-tauri/Cargo.toml network::tests`
   - result: pass
   - notes: green signal after adding structured `message_api` builders and access filtering; the new browser `drive` subcommand assertions passed.
4. `cargo test --manifest-path src-tauri/Cargo.toml`
   - result: pass
   - notes: full Rust suite stayed green after threading `message_api` through session/network serialization.
5. `npm run check`
   - result: pass
   - notes: shared TypeScript types compile with the new `SessionTileInfo.message_api` field.
6. `npm --prefix mcp-server run build`
   - result: pass
   - notes: MCP server guidance/tool descriptions compile after the `message_api` wording update.
7. `npx vitest run --root mcp-server src/index.test.ts`
   - result: pass
   - notes: MCP root/worker tool surface parity remains unchanged.
8. `npx tsc --noEmit --target ES2023 --lib ES2023 --module ESNext --moduleResolution bundler --allowImportingTsExtensions --verbatimModuleSyntax --strict --skipLibCheck --types node,vitest/globals tests/integration/*.ts`
   - result: pass
   - notes: the integration suite typechecks with the new browser `message_api` assertions.
9. `git diff --check`
   - result: pass
   - notes: no patch formatting or whitespace issues remain.
