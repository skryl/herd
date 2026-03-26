# Fixture Agents For Browser-Game Integration

## Status
Completed

## Date
2026-03-24

## Context
The browser-game integration suite currently uses real Claude-managed Root and worker agents. That makes the tests slower and less deterministic than they need to be, and it couples game verification to model behavior rather than to Herd's collaboration/runtime surfaces.

Herd already has a real agent event channel over the socket API:

- agents subscribe with `agent_events_subscribe`
- Herd sends `direct`, `public`, `network`, `root`, `system`, and `ping` events
- agents ack liveness with `agent_ping_ack`
- agents issue normal Herd socket commands with their sender identity

The missing piece is a first-class test agent mode that keeps the real Herd channel but does not launch Claude.

## Goals
- Add a test-only `fixture` agent type that does not launch the Claude process.
- Allow test runtimes to create Root and worker agents as fixtures.
- Drive fixture agents from deterministic integration-test state machine scripts over the normal Herd agent channel.
- Migrate the browser-game integration suite so all scenario actions come from scripted Root/workers and each game goes to completion.

## Non-goals
- Replacing Claude hook tests or other Claude-launch coverage with fixture agents.
- Adding a general public product feature for fixture agents.
- Changing the game rules or replacing browser-game unit tests.

## Scope
- Rust backend agent model and spawn/repair paths.
- Test runtime configuration.
- Integration-only scripted agent harness.
- Browser-game integration suite migration.

## Risks And Mitigations
- Root auto-spawn may assume a Claude-side `agent_register`.
  - Mitigation: fixture agents register in the backend at spawn time and only use subscription to transition `alive`.
- Test harness could cheat with custom backdoors.
  - Mitigation: scripted agents consume `agent_events_subscribe` and issue only normal Herd socket commands with real sender identity.
- Shared integration runtime behavior could regress non-browser-game suites.
  - Mitigation: fixture mode is opt-in per test runtime; default integration runtime behavior stays Claude-backed.

## Acceptance Criteria
- Fixture-mode runtimes create Root and worker agents with `agent_type=fixture`.
- Fixture-mode agents do not launch a `claude` process.
- A scripted external controller can attach to a fixture agent, receive Herd events, ack pings, and act through normal Herd commands.
- `tests/integration/browser-games.test.ts` uses scripted Root/workers instead of prompting live Claude agents.
- All four browser-game integration tests finish the game, not just setup.

## Phase 0
### Objective
Add red coverage for the fixture agent runtime seam.

### Red
- Add failing Rust/integration checks that prove:
  - fixture runtimes create Root as `fixture`
  - fixture worker creation does not produce `claude`
  - fixture agents can subscribe and transition to `alive`

### Expected Failure Signal
- `fixture` agent type unsupported or missing in projections.
- Spawn path still tries to execute `claude`.
- Root/worker agents never become alive without Claude-side registration.

### Green
- Add the core `fixture` agent type, test-runtime gating, and backend registration path.

### Verification Commands
- `cargo test --manifest-path src-tauri/Cargo.toml`
- targeted integration checks for fixture spawn/subscription

### Exit Criteria
- Fixture mode exists and basic spawn/subscription coverage is green.

## Phase 1
### Objective
Build the scripted fixture-agent harness over the normal Herd channel.

### Red
- Add failing integration-harness tests for:
  - attaching to auto-created fixture Root
  - auto-attaching worker scripts by deterministic title
  - ping ack and direct-message-driven actions

### Expected Failure Signal
- No harness support for fixture agent subscriptions and scripted actions.

### Green
- Add an integration-only scripted agent controller that:
  - subscribes with `agent_events_subscribe`
  - auto-acks `ping`
  - exposes role-specific Root/worker action helpers
  - runs deterministic async state machine scripts

### Verification Commands
- targeted Vitest runs for the scripted harness

### Exit Criteria
- Root and worker fixture scripts can coordinate through real Herd events and commands.

## Phase 2
### Objective
Migrate browser-game integration tests to scripted fixture agents.

### Red
- Convert browser-game tests away from prompting real workers; expect them to fail until scripted orchestration lands.

### Expected Failure Signal
- Missing scripted helper APIs or fixture runtime behavior.

### Green
- Root script performs in-session orchestration.
- Worker scripts drive their connected browser tiles to completion.
- Final assertions still verify browser state directly from the test harness.

### Verification Commands
- `npm run test:integration -- tests/integration/browser-games.test.ts`
- browser-game unit tests and adjacent checks

### Exit Criteria
- All four browser-game integration tests pass with scripted fixture Root/workers.

## Execution Checklist
- [x] Phase 0 complete
- [x] Phase 1 complete
- [x] Phase 2 complete
- [x] Integration/regression checks complete
- [x] Documentation/status updated

## Command Log
1. `sed -n '1,220p' /Users/skryl/.codex/skills/phased-prd-red-green/SKILL.md`
   - result: pass
   - notes: confirmed phased PRD + red/green workflow.
2. `rg -n "AgentType|agent type|claude process|spawn.*agent|spawn_agent|HERD_AGENT_ROLE|role_specific_herd_skills|browser-games.test|worker-root-mcp|state machine|fixture" -S .`
   - result: pass
   - notes: located current agent spawn, type, and browser-game integration seams.
3. `cargo test --manifest-path src-tauri/Cargo.toml`
   - result: pass
   - notes: full Rust suite green after adding fixture agents and direct tmux `new-window` creation for test-heavy tile allocation.
4. `npm run check`
   - result: pass
   - notes: frontend/type checks green with fixture-agent types and integration harness imports.
5. `npx vitest run extensions/browser/**/*.test.ts`
   - result: pass
   - notes: browser game rules and room-sync suites remain green.
6. `npm run test:integration -- tests/integration/fixture-agents.test.ts`
   - result: pass
   - notes: fixture Root/worker attachment and browser-driving smoke are green through the real Herd agent channel.
7. `npm run test:integration -- tests/integration/browser-games.test.ts`
   - result: pass
   - notes: all four scripted fixture-agent matches run to terminal completion.
8. `git diff --check`
   - result: pass
   - notes: no whitespace or patch formatting issues remain.
