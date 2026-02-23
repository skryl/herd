# Configuration

## Default Paths

By default, herd stores everything in your home config directory:

- `~/.config/herd/settings.json`
- `~/.config/herd/state.json`
- `~/.config/herd/herd_modes/*.json`

`settings.json` is created automatically on first boot when missing.

## Overrides

CLI flags:

- `--config <path>`
- `--state <path>`

Environment variables:

- `HERD_CONFIG`
- `HERD_STATE`
- `HERD_TMUX_SOCKET`

## Example `settings.json`

```json
{
  "refresh_interval_ms": 500,
  "capture_lines": 300,
  "stall_threshold_secs": 120,
  "cooldown_secs": 120,
  "max_nudges": 3,
  "nudge_message": "Please continue until the task is fully complete.",
  "finished_markers": ["finished", "complete", "done"],
  "waiting_markers": ["waiting for input", "need your input"],
  "marker_lookback_lines": 8,
  "status_track_exact_commands": ["tmux"],
  "agent_process_markers": ["claude", "codex"],
  "status_waiting_grace_secs": 120,
  "status_transition_stability_secs": 5,
  "status_confidence_min_for_trigger": 60,
  "live_capture_line_multiplier": 8,
  "live_capture_min_lines": 400,
  "herd_count": 5,
  "openai_api_key": "",
  "anthropic_api_key": "",
  "llm_provider": "openai",
  "llm_model": "",
  "herd_modes": [
    { "name": "Balanced", "rule_file": "herd_modes/balanced.json" },
    { "name": "Conservative", "rule_file": "herd_modes/conservative.json" },
    { "name": "Aggressive", "rule_file": "herd_modes/aggressive.json" }
  ]
}
```

## Notes

- Herd count default is `5`.
- Provider name is normalized to `openai` or `anthropic`.
- Herd mode rule files are normalized JSON and kept in sync during settings save/load.
