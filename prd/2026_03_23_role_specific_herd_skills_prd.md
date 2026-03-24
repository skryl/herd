## Title
Role-Specific Herd Skills

## Status
Completed

## Date
2026-03-23

## Context
The Root and worker MCP interfaces are intentionally different, but the current Herd skill is shared. That leaves both roles with one mixed document that describes tools they do not actually have.

## Goals
- Split the Herd skill into role-specific skills.
- Point workers at a worker-only skill and Root at a root-only skill.
- Remove the shared mixed skill so there is no stale fallback.

## Non-goals
- Change the MCP surface itself.
- Change non-Herd role guidance beyond the minimum needed to reference the right skill.

## Scope
- Replace `.claude/skills/herd/SKILL.md` with separate role-specific skill files.
- Update runtime welcome strings and role prompts to reference the right skill names.
- Update tests that assert the worker welcome message.

## Risks and mitigations
- Risk: stale references still point to `/herd`.
  - Mitigation: grep all relevant files and update them in the same change.

## Acceptance criteria
- Workers are told to use `/herd-worker`.
- Root is told to use `/herd-root`.
- No shared `/herd` skill remains.
- The worker integration test string is updated and typechecks.

## Phased Plan (Red/Green)

### Phase 0
Objective: prove the current repo still uses a shared `/herd` skill reference.

Red:
- Search for `/herd skill` and `.claude/skills/herd`.
- Expected failure signal: worker welcome and the shared skill file still exist.

Green:
- Add `/herd-root` and `/herd-worker`.
- Remove the shared `/herd` skill file.
- Update welcome and role references.

Exit criteria:
- No runtime or prompt path still points at the shared `/herd` skill.

### Phase 1
Objective: keep tests aligned with the role-specific worker welcome.

Red:
- Existing integration string asserts the worker welcome points at `/herd`.
- Expected failure signal: grep shows the stale string in tests.

Green:
- Update the worker welcome test string.
- Run targeted checks.

Exit criteria:
- Updated checks pass and the new role-specific wording is in place.

## Execution Checklist
- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log
1. `rg -n "/herd|skills/herd|Review the /herd skill" .claude src-tauri tests -S`
   - result: `pass`
   - notes: confirmed the shared skill and worker welcome references were still present.
2. `cargo test --manifest-path src-tauri/Cargo.toml cli::tests -- --nocapture`
   - result: `pass`
   - notes: Rust targeted tests still pass after the welcome-string updates.
3. `npx tsc --noEmit --target ES2023 --lib ES2023 --module ESNext --moduleResolution bundler --allowImportingTsExtensions --verbatimModuleSyntax --strict --skipLibCheck --types node,vitest/globals tests/integration/work-registry.test.ts tests/integration/client.ts tests/integration/helpers.ts tests/integration/runtime.ts`
   - result: `pass`
   - notes: the updated worker welcome test string typechecks.
4. `find .claude/skills -maxdepth 2 -type f | sort`
   - result: `pass`
   - notes: only `herd-root` and `herd-worker` skill files remain.
5. `git diff --check`
   - result: `pass`
   - notes: no patch hygiene issues.
