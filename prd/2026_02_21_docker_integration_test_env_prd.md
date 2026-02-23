# Docker Integration Test Environment PRD

## Status

Completed (2026-02-21)

## Context

The integration test suite depends on `tmux`. Local developer machines may have different `tmux` versions or missing dependencies, which makes test reliability inconsistent. We need a reproducible, containerized environment where integration tests can run consistently.

## Goals

1. Provide a Docker-based environment with `tmux` installed.
2. Provide one command to build and run integration tests inside the container.
3. Keep repository setup simple for local developers and CI adoption.

## Non-goals

1. Replacing local development workflow for regular coding.
2. Replacing existing local test commands outside Docker.
3. Setting up full CI pipeline configuration in this task.

## Phased Plan (Red/Green)

### Phase 1: Baseline and interface

Red:
1. Attempt running `./scripts/run-docker-integration-tests.sh` before implementation and capture failure.

Green:
1. Add `scripts/run-docker-integration-tests.sh` host entrypoint.
2. Add `scripts/run-integration-tests.sh` in-container command wrapper.

Exit criteria:
1. Host entrypoint exists and is executable.
2. In-container wrapper exists and supports default + passthrough args.

### Phase 2: Docker environment

Red:
1. Ensure there is no integration Docker environment definition.

Green:
1. Add `docker/integration/Dockerfile` with Rust toolchain and `tmux`.
2. Add `docker-compose.integration.yml` to run tests from repository mount.
3. Add `.dockerignore` to reduce build context size.

Exit criteria:
1. Docker image builds successfully.
2. Container can execute integration tests with mounted workspace.

### Phase 3: Validation and docs

Red:
1. Validate command output before documentation update.

Green:
1. Run `./scripts/run-docker-integration-tests.sh --test phase0_cli` successfully as a Dockerized integration smoke test.
2. Update `README.md` with Docker integration test instructions.

Exit criteria:
1. Docker build + run path is validated in-container with `tmux` installed.
2. README contains exact command usage.

## Acceptance Criteria

1. `./scripts/run-docker-integration-tests.sh` works on a host with Docker + Compose.
2. Integration tests can be executed inside the container with `tmux` available.
3. Documentation clearly explains how to run default and custom test commands.

## Risks and Mitigations

1. Risk: Docker unavailable or daemon not running.
   Mitigation: script emits clear prerequisite error.
2. Risk: Slow cold-start image builds.
   Mitigation: persistent cargo caches via compose volumes.
3. Risk: Version drift between local and container Rust.
   Mitigation: explicit Rust base image in Dockerfile.
4. Risk: Existing repo test failures can be mistaken for Docker environment failure.
   Mitigation: validate with a targeted smoke test and report full-suite failures separately.

## Implementation Checklist

- [x] Phase 1 complete (host + in-container scripts)
- [x] Phase 2 complete (Dockerfile + compose + ignore)
- [x] Phase 3 complete (validation + docs)
