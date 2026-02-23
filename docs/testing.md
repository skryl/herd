# Testing

## Local Test Commands

Run all tests:

```bash
cargo test --tests
```

Run a single integration target:

```bash
cargo test --test tui_app
```

## Scripted Test Runner

Run full test tier:

```bash
./scripts/run-integration-tests.sh --tier full
```

Run fast test tier:

```bash
./scripts/run-integration-tests.sh --tier fast
```

Run custom cargo args through the script:

```bash
./scripts/run-integration-tests.sh --test integration_tmux_runtime -- --nocapture
```

Generate documentation screenshots from test render states:

```bash
./scripts/capture-doc-screenshots.sh
```

Generate screenshots as part of integration test execution:

```bash
HERD_CAPTURE_DOC_SCREENSHOTS=1 ./scripts/run-integration-tests.sh --tier fast
```

## Docker Test Runner

Run the same tests in the containerized environment:

```bash
./scripts/run-docker-integration-tests.sh
```

Fast tier in container:

```bash
./scripts/run-docker-integration-tests.sh --tier fast
```
