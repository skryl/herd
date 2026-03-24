# Root MCP Mode And Role Skill Coverage

Status: Completed
Date: 2026-03-23

## Context

Root and worker agents intentionally share one checked-in `server:herd` MCP entry, but they must not expose the same tool surface. The current launcher path can force the MCP bridge into worker mode, which leaves a Root-registered agent without Root-only tools. At the same time, the role-specific Herd skill split needs explicit test coverage so Root and worker prompts keep teaching the correct MCP surface.

## Goals

- Ensure Herd-managed Root agents resolve to Root MCP mode.
- Keep a single MCP server implementation and a neutral launcher.
- Add tests that lock in the role-specific Herd skill guidance for Root and worker prompts.

## Non-goals

- Do not create separate Root and worker MCP server implementations.
- Do not expand the Root or worker MCP surface beyond the existing intended split.
- Do not add compatibility fallbacks for the removed shared `/herd` skill.

## Scope

- MCP mode resolution in `mcp-server/src/index.ts`.
- Launcher wrapper behavior in `bin/herd-mcp-server`.
- Role-prompt and skill-content coverage for `/herd-root` and `/herd-worker`.
- Focused PRD, tests, and verification commands.

## Risks and mitigations

- Risk: fixing the wrapper alone still leaves precedence bugs if conflicting env vars appear.
  - Mitigation: make role-derived mode resolution explicit and test it directly.
- Risk: prompt or skill files drift away from the actual worker/root MCP split.
  - Mitigation: add content assertions for the role prompts and skill files.
- Risk: broad test runs obscure the signal.
  - Mitigation: use focused Rust and MCP test targets first.

## Acceptance criteria

- A Root-managed agent resolves to Root MCP mode even if a stale worker-mode env var is present.
- The checked-in launcher no longer forces worker mode.
- Root prompt content points at `/herd-root`, worker prompt content points at `/herd-worker`.
- The role-specific skill files describe the appropriate MCP surfaces.
- Targeted Rust and MCP tests pass.

## Phased Plan

### Phase 0

Objective: capture the current Root-mode regression and role-skill expectations in tests.

Red:
- Add MCP tests for role/mode resolution and launcher neutrality.
- Add Rust tests for role prompts and role-specific skill content.
- Expected failure signal: Root mode still resolves to worker or the launcher still hardcodes worker mode.

Green:
- No implementation in this phase.

Exit criteria:
- New targeted coverage fails against the current regression.

### Phase 1

Objective: fix Root mode resolution and preserve the role-specific skill guidance.

Red:
- Run the new targeted tests and capture the failure.

Green:
- Remove the launcher’s forced worker mode.
- Resolve MCP mode from the agent role first.
- Keep the role-specific skill split and make the tests pass.
- Verification commands:
  - targeted MCP tests
  - targeted Rust tests
  - `git diff --check`

Exit criteria:
- Root resolves to Root mode and targeted tests pass.

## Execution Checklist

- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log

1. `npx vitest run --root mcp-server src/index.test.ts`
   - result: fail
   - notes: red phase; `resolveAgentRole`/`resolveMcpMode` were missing and the launcher still contained `HERD_MCP_MODE=worker`.
2. `cargo test --manifest-path src-tauri/Cargo.toml role_ -- --nocapture`
   - result: pass
   - notes: the new prompt and skill-content assertions passed against the in-tree role-specific skill split.
3. `npx vitest run --root mcp-server src/index.test.ts`
   - result: pass
   - notes: green phase; Root mode now resolves from the agent role and the wrapper is neutral.
4. `cargo test --manifest-path src-tauri/Cargo.toml commands::tests:: -- --nocapture`
   - result: pass
   - notes: verifies launch command wiring plus the role-prompt and skill-content assertions.
5. `npm --prefix mcp-server run build`
   - result: pass
   - notes: verifies the MCP server TypeScript still builds cleanly.
6. `cargo test --manifest-path src-tauri/Cargo.toml`
   - result: pass
   - notes: full Rust suite, including the new Root/worker welcome-message assertion in `socket/server.rs`.
7. `npm run test:integration -- tests/integration/work-registry.test.ts -t "sends the welcome DM and replays the last hour of public chatter on first agent subscription"`
   - result: pass
   - notes: keeps the worker bootstrap welcome path covered end to end.
8. `find .claude/skills -maxdepth 2 -type f | sort`
   - result: pass
   - notes: only `herd-root` and `herd-worker` skill files remain.
9. `git diff --check -- bin/herd-mcp-server mcp-server/src/index.ts mcp-server/src/index.test.ts src-tauri/src/commands.rs src-tauri/src/socket/server.rs .claude/roles/root/CLAUDE.md .claude/roles/worker/CLAUDE.md .claude/skills/herd-root/SKILL.md .claude/skills/herd-worker/SKILL.md tests/integration/work-registry.test.ts prd/2026_03_23_root_mcp_mode_and_role_skill_coverage_prd.md`
   - result: pass
   - notes: final patch hygiene check.
