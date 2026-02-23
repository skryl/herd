# Herd Modes and Rule Engine

Each herd mode points to a JSON rule file used to decide if/what command herd should send to a pane.

## Where Rules Live

- Rule files are referenced from `settings.json` under `herd_modes`.
- Default location is `~/.config/herd/herd_modes/*.json`.

## Rule File Shape

```json
{
  "version": 1,
  "rules": [
    {
      "id": "default_nudge",
      "type": "regex",
      "enabled": true,
      "input_scope": "full_buffer",
      "pattern": "(?s).*",
      "command_template": "Please continue until the task is fully complete."
    },
    {
      "id": "llm_suggested_command",
      "type": "llm",
      "enabled": false,
      "input_scope": "visible_window",
      "prompt": "Return strict JSON: {\"match\":bool,\"command\":string?,\"variables\":object?}.",
      "command_template": "{command}"
    }
  ]
}
```

## Execution Model

1. Rules execute in order.
2. The first matching rule wins.
3. If matched, herd renders `command_template` and dispatches via `tmux send-keys`.
4. Cooldown and max-nudge limits are applied before dispatch.

## Rule Types

Regex rule:

- Input: `full_buffer` or `visible_window`.
- Match output: true/false plus named regex captures as variables.

LLM rule:

- Input: `full_buffer` or `visible_window`.
- Expected response JSON:
  - `match` (boolean, required)
  - `command` (string, optional)
  - `variables` (object, optional)

## Template Variables

`command_template` supports placeholders like:

- `{command}` from LLM decision payload
- Regex named captures, for example `{ticket}`
- Runtime context variables such as:
  - `{pane_id}`
  - `{session_name}`
  - `{status_state}`
  - `{status_display}`
  - `{status_inactive_secs}`
  - `{status_waiting_secs}`
  - `{status_confidence}`

## Safety and Triggering

- Rules only run for herd-eligible process states.
- `finished` panes are never nudged.
- Low-confidence states are suppressed by config threshold.
- Verbose herder logs are emitted for rule start, match, skip, and dispatch decisions.
