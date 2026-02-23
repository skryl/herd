# Docker Workflows

## Run Herd in Seeded Container

Use the host-facing runtime wrapper:

```bash
./scripts/run-herd.sh
```

This will:

- Build the integration image
- Start a seeded tmux server in-container
- Seed interactive shell and codex panes
- Run `cargo run -- --tmux-socket <socket> tui` by default

Run another herd command in the same workflow:

```bash
./scripts/run-herd.sh sessions
```

## Useful Environment Variables

- `HERD_DOCKER_TMUX_SOCKET` (default: `herd`)
- `HERD_HOST_CONFIG_DIR` (default: `$HOME/.config/herd`)
- `HERD_HOST_CODEX_DIR` (default: `$HOME/.codex`)
- `HERD_HOST_RUNTIME_DIR` (default: `$PWD/tmp`)
- `HERD_CONTAINER_CONFIG_DIR` (default: `/root/.config/herd`)
- `HERD_CONTAINER_CODEX_DIR` (default: `/root/.codex`)
- `HERD_CONTAINER_RUNTIME_DIR` (default: `/workspace/tmp`)

`run-herd.sh` is the host wrapper and calls `run-herd-container-entrypoint.sh` inside the container.

## Docker Integration Tests

Run all integration/unit test targets in container:

```bash
./scripts/run-docker-integration-tests.sh
```

Run fast tier in container:

```bash
./scripts/run-docker-integration-tests.sh --tier fast
```

Pass through explicit cargo test args:

```bash
./scripts/run-docker-integration-tests.sh --test tmux_discovery -- --nocapture
```
