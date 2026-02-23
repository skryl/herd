# Docker Codex Install + Real Codex tmux Seed PRD

## Status

Completed (2026-02-22)

## Context

The Docker integration/test container currently includes Rust and tmux, but not `codex`. Demo tmux seeding also fakes Codex panes using `exec -a codex bash ...`, which does not run the real Codex binary.

## Goals

1. Install `codex` in the Docker integration container image.
2. Seed tmux demo sessions with real interactive `codex` processes.
3. Keep existing demo workflow and command surface unchanged.

## Non-goals

1. Adding authentication/bootstrap flows for Codex API credentials.
2. Changing integration test behavior unrelated to container runtime dependencies.
3. Building persistent scripted Codex conversations.

## Phased Plan (Red/Green)

### Phase 1: Container dependency update

Red:
1. Confirm container definition lacks Codex installation.

Green:
1. Add Node/npm dependency required for Codex CLI install.
2. Install `@openai/codex` globally during image build.
3. Validate `codex --version` during build.

Exit criteria:
1. Docker integration image includes a working `codex` binary.

### Phase 2: Real Codex tmux seeding

Red:
1. Confirm demo seeding uses fake Codex process names (`exec -a codex`).

Green:
1. Update seed script to require `codex` binary.
2. Replace fake Codex loop panes with real `codex` interactive commands that generate thread/turn state.
3. Keep session/window topology stable.

Exit criteria:
1. Seeded windows report `pane_current_command=codex` from real Codex processes and have live Codex thread state.

### Phase 3: Verification + docs

Red:
1. Capture baseline expectations in docs.

Green:
1. Update README Docker demo wording to reflect real Codex-seeded panes and Codex auth/state mount requirements.
2. Run targeted and full tests to ensure no regressions.

Exit criteria:
1. Documentation matches behavior and tests remain green.

## Acceptance Criteria

1. `docker/integration/Dockerfile` installs Codex.
2. `scripts/run-herd-demo-container-entrypoint.sh` starts real interactive Codex panes.
3. Existing demo commands still work.
4. Touched tests pass.

## Risks and Mitigations

1. Risk: npm package install failures in build environment.
   Mitigation: fail build early via `codex --version` check.
2. Risk: Codex process exits immediately in seeded tmux panes.
   Mitigation: launch interactive `codex` with seed prompts and auto-confirm workspace trust in demo panes.
3. Risk: Larger Docker image size.
   Mitigation: keep package install minimal and clean apt caches.

## Implementation Checklist

- [x] Phase 1 complete (container codex install)
- [x] Phase 2 complete (real codex tmux seeding)
- [x] Phase 3 complete (docs + verification)
- [x] Touched tests green
- [x] PRD status updated to Completed with date
