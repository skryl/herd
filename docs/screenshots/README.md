# Screenshots

These screenshots are generated from deterministic, styled TUI render states during test runs.
Raw snapshots are written as JSON in `docs/screenshots/raw/`.

To regenerate:

```bash
./scripts/capture-doc-screenshots.sh
```

Or during integration tests:

```bash
HERD_CAPTURE_DOC_SCREENSHOTS=1 ./scripts/run-integration-tests.sh --tier fast
```

## Integration Suite Recording

![Integration Suite Recording](integration_suite.gif)

## Happy Path GIF

![Happy Path Demo](happy_path.gif)

## Gallery

### TUI Overview

![TUI Overview](tui_overview.png)

### Settings Overlay

![Settings Overlay](tui_settings_overlay.png)

### Content Input Mode

![Content Input Mode](tui_input_mode.png)

### Herder Log Filter

![Herder Log Filter](tui_herder_log_filter.png)
