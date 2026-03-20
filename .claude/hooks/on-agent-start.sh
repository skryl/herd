#!/bin/bash
# Hook: PreToolUse (Agent) — spawn a Herd tile and launch the Claude child-agent command
exec >/dev/null 2>&1

HERD_SOCK="${HERD_SOCK:-/tmp/herd.sock}"
[ ! -S "$HERD_SOCK" ] && { echo '{"continue": true}'; exit 0; }

INPUT=$(cat)

eval "$(printf '%s' "$INPUT" | python3 -c "
import json, shlex, sys
d = json.load(sys.stdin)
ti = d.get('tool_input', {})

def emit(name, value):
    print(f'{name}={shlex.quote(str(value or \"\"))}')

emit('AGENT_NAME', ti.get('name', ''))
emit('TEAM_NAME', ti.get('team_name', ''))
emit('AGENT_PROMPT', ti.get('prompt', ''))
emit('AGENT_DESC', ti.get('description', ''))
emit('SUBAGENT_TYPE', ti.get('subagent_type', ''))
emit('MODEL', ti.get('model', ''))
emit('RUN_IN_BACKGROUND', 'yes' if ti.get('run_in_background') else 'no')
emit('TRANSCRIPT', d.get('transcript_path') or d.get('transcriptPath', ''))
emit('SESSION_ID', d.get('session_id') or d.get('sessionId', ''))
emit('CWD', d.get('cwd', ''))
emit('PERMISSION_MODE', d.get('permission_mode') or d.get('permissionMode', ''))
emit('TOOL_USE_ID', d.get('tool_use_id') or d.get('toolUseID') or d.get('toolUseId', ''))
" 2>/dev/null)" || { echo '{"continue": true}'; exit 0; }

HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
PARENT_PANE_ID="${TMUX_PANE:-}"
if [ -z "$PARENT_PANE_ID" ] && [[ "$SESSION_ID" == %* ]]; then
  PARENT_PANE_ID="$SESSION_ID"
fi

socket_request() {
  python3 - "$HERD_SOCK" "$1" <<'PY' 2>/dev/null
import socket, sys

sock_path, payload = sys.argv[1], sys.argv[2]
client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
client.connect(sock_path)
client.sendall((payload + "\n").encode("utf-8"))

buffer = b""
while b"\n" not in buffer:
    chunk = client.recv(65536)
    if not chunk:
        break
    buffer += chunk

client.close()
sys.stdout.write(buffer.decode("utf-8", "replace").strip())
PY
}

spawn_tile() {
  local offset_x offset_y
  offset_x=$(( (RANDOM % 400) + 50 ))
  offset_y=$(( (RANDOM % 300) + 50 ))

  if [ -n "$PARENT_PANE_ID" ]; then
    socket_request "$(python3 -c '
import json, sys
x, y, parent = sys.argv[1], sys.argv[2], sys.argv[3]
print(json.dumps({
    "command": "spawn_shell",
    "x": float(x),
    "y": float(y),
    "width": 640,
    "height": 400,
    "parent_pane_id": parent,
}))
' "$offset_x" "$offset_y" "$PARENT_PANE_ID" 2>/dev/null)"
  else
    socket_request "$(python3 -c '
import json, sys
x, y = sys.argv[1], sys.argv[2]
print(json.dumps({
    "command": "spawn_shell",
    "x": float(x),
    "y": float(y),
    "width": 640,
    "height": 400,
}))
' "$offset_x" "$offset_y" 2>/dev/null)"
  fi
}

set_tile_title() {
  local sid="$1"
  local title="$2"
  socket_request "$(python3 -c '
import json, sys
sid, title = sys.argv[1], sys.argv[2]
print(json.dumps({"command": "set_title", "session_id": sid, "title": title}))
' "$sid" "$title" 2>/dev/null)" >/dev/null 2>&1
}

set_tile_role() {
  local sid="$1"
  local role="$2"
  socket_request "$(python3 -c '
import json, sys
sid, role = sys.argv[1], sys.argv[2]
print(json.dumps({"command": "set_tile_role", "session_id": sid, "role": role}))
' "$sid" "$role" 2>/dev/null)" >/dev/null 2>&1
}

send_tile_input() {
  local sid="$1"
  local command_input="$2"
  socket_request "$(python3 -c '
import json, sys
sid, command_input = sys.argv[1], sys.argv[2]
print(json.dumps({"command": "send_input", "session_id": sid, "input": command_input}))
' "$sid" "$command_input" 2>/dev/null)" >/dev/null 2>&1
}

exec_tile_command() {
  local sid="$1"
  local command_input="$2"
  socket_request "$(python3 -c '
import json, sys
sid, command_input = sys.argv[1], sys.argv[2]
print(json.dumps({"command": "exec_in_shell", "session_id": sid, "shell_command": command_input}))
' "$sid" "$command_input" 2>/dev/null)" >/dev/null 2>&1
}

start_agent_task_watcher() {
  local sid="$1"
  [ -z "$sid" ] && return
  [ -z "$TRANSCRIPT" ] && return
  [ -z "$TOOL_USE_ID" ] && return

  nohup python3 "${HOOKS_DIR}/watch-agent-task.py" \
    "$TRANSCRIPT" \
    "$TOOL_USE_ID" \
    "$HERD_SOCK" \
    "$sid" >/dev/null 2>&1 &
}

resolve_claude_bin() {
  if [ -n "${HERD_CLAUDE_AGENT_BIN:-}" ]; then
    printf '%s' "$HERD_CLAUDE_AGENT_BIN"
    return
  fi

  python3 -c '
import os, shutil
path = shutil.which("claude")
if path:
    print(os.path.realpath(path))
' 2>/dev/null
}

resolve_agent_color() {
  python3 -c '
import json, os, sys

team_name, agent_name = sys.argv[1], sys.argv[2]
palette = ["blue", "green", "yellow", "purple", "orange", "pink", "cyan", "red"]
if not team_name or not agent_name:
    print("blue")
    raise SystemExit(0)

config_path = os.path.expanduser(f"~/.claude/teams/{team_name}/config.json")
if not os.path.exists(config_path):
    print("blue")
    raise SystemExit(0)

try:
    data = json.load(open(config_path, "r", encoding="utf-8"))
except Exception:
    print("blue")
    raise SystemExit(0)

members = data.get("members", [])
for member in members:
    if member.get("name") == agent_name and member.get("color"):
        print(member["color"])
        raise SystemExit(0)

used = {member.get("color") for member in members if member.get("color")}
for color in palette:
    if color not in used:
        print(color)
        raise SystemExit(0)

print(palette[len(members) % len(palette)])
' "$TEAM_NAME" "$AGENT_NAME" 2>/dev/null
}

resolve_parent_session_id() {
  if [ -n "$SESSION_ID" ]; then
    printf '%s' "$SESSION_ID"
    return
  fi

  if [ -n "$TRANSCRIPT" ]; then
    basename "$TRANSCRIPT" .jsonl
    return
  fi
}

slugify_text() {
  python3 -c '
import re, sys
text = sys.argv[1].strip().lower()
slug = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
print(slug[:40] or "agent")
' "$1" 2>/dev/null
}

shell_quote() {
  python3 -c '
import shlex, sys
print(shlex.quote(sys.argv[1]))
' "$1" 2>/dev/null
}

generic_agent_name() {
  local base short_tool
  base="$(slugify_text "${SUBAGENT_TYPE:-${AGENT_DESC:-${AGENT_PROMPT:-agent}}}")"
  short_tool="$(printf '%s' "${TOOL_USE_ID:-agent}" | tr -cd '[:alnum:]' | tail -c 8)"
  if [ -n "$short_tool" ]; then
    printf '%s-%s' "$base" "$short_tool"
  else
    printf '%s' "$base"
  fi
}

generic_team_name() {
  local parent_id short_parent
  parent_id="$(resolve_parent_session_id)"
  short_parent="$(printf '%s' "${parent_id:-session}" | tr -cd '[:alnum:]' | head -c 8)"
  printf 'adhoc-%s' "${short_parent:-session}"
}

launch_team_agent_tile() {
  local sid title claude_bin agent_id agent_color launch_command
  local permission_flags model_flags test_marker

  sid="$1"
  title="${AGENT_NAME}@${TEAM_NAME}"
  set_tile_title "$sid" "$title"

  claude_bin="$(resolve_claude_bin)"
  [ -z "$claude_bin" ] && return

  agent_id="${AGENT_NAME}@${TEAM_NAME}"
  agent_color="$(resolve_agent_color)"
  [ -z "$agent_color" ] && agent_color="blue"

  permission_flags=()
  if [ "$PERMISSION_MODE" = "bypassPermissions" ]; then
    permission_flags+=("--dangerously-skip-permissions")
  elif [ -n "$PERMISSION_MODE" ]; then
    permission_flags+=("--permission-mode" "$PERMISSION_MODE")
  fi

  model_flags=()
  if [ -n "$MODEL" ]; then
    model_flags+=("--model" "$MODEL")
  fi

  test_marker=""
  if [ -n "${HERD_CLAUDE_AGENT_BIN:-}" ]; then
    test_marker="__HERD_AGENT_LAUNCH__ ${agent_id} ${AGENT_NAME} ${TEAM_NAME} ${agent_color} ${SESSION_ID} ${PERMISSION_MODE:-default} ${MODEL:-default}"
  fi

  launch_command="$(python3 -c '
import shlex, sys

cwd = sys.argv[1]
test_marker = sys.argv[2]
argv = sys.argv[3:]
parts = []
if cwd:
    parts.append(f"cd {shlex.quote(cwd)}")
if test_marker:
    parts.append(f"printf '\''%s\\n'\'' {shlex.quote(test_marker)}")
parts.append("exec " + " ".join(shlex.quote(arg) for arg in argv))
print(" && ".join(parts) + "\n")
' "$CWD" "$test_marker" "$claude_bin" \
    --agent-id "$agent_id" \
    --agent-name "$AGENT_NAME" \
    --team-name "$TEAM_NAME" \
    --agent-color "$agent_color" \
    --parent-session-id "$SESSION_ID" \
    "${permission_flags[@]}" \
    "${model_flags[@]}" 2>/dev/null)"

  [ -n "$launch_command" ] && exec_tile_command "$sid" "$launch_command"
}

launch_generic_agent_tile() {
  local sid title generic_label claude_bin agent_name team_name agent_color parent_session_id launch_command attach_command
  local permission_flags model_flags test_marker
  local q_cwd q_test_marker q_resolve q_stream_output q_transcript q_tool_use_id q_claude_bin arg

  sid="$1"
  generic_label="${AGENT_DESC:-${AGENT_PROMPT:-Agent}}"
  title="${SUBAGENT_TYPE:-Agent}: ${generic_label:0:60}"
  set_tile_title "$sid" "$title"

  claude_bin="$(resolve_claude_bin)"
  [ -z "$claude_bin" ] && return

  parent_session_id="$(resolve_parent_session_id)"
  [ -z "$parent_session_id" ] && return
  [ -z "$TRANSCRIPT" ] && return
  [ -z "$TOOL_USE_ID" ] && return

  agent_name="$(generic_agent_name)"
  team_name="$(generic_team_name)"
  agent_color="blue"

  permission_flags=()
  if [ "$PERMISSION_MODE" = "bypassPermissions" ]; then
    permission_flags+=("--dangerously-skip-permissions")
  elif [ -n "$PERMISSION_MODE" ]; then
    permission_flags+=("--permission-mode" "$PERMISSION_MODE")
  fi

  model_flags=()
  if [ -n "$MODEL" ]; then
    model_flags+=("--model" "$MODEL")
  fi

  test_marker=""
  if [ -n "${HERD_CLAUDE_AGENT_BIN:-}" ]; then
    test_marker="__HERD_AGENT_LAUNCH__ generic ${agent_name} ${team_name} ${agent_color} ${parent_session_id} ${TOOL_USE_ID} ${PERMISSION_MODE:-default} ${MODEL:-default}"
  fi

  q_cwd="$(shell_quote "$CWD")"
  q_resolve="$(shell_quote "${HOOKS_DIR}/resolve-agent-launch.py")"
  q_stream_output="$(shell_quote "${HOOKS_DIR}/stream-agent-output.py")"
  q_transcript="$(shell_quote "$TRANSCRIPT")"
  q_tool_use_id="$(shell_quote "$TOOL_USE_ID")"
  q_claude_bin="$(shell_quote "$claude_bin")"

  launch_command="cd ${q_cwd} || exit 1"
  if [ "$RUN_IN_BACKGROUND" = "yes" ]; then
    launch_command="${launch_command}; printf '%s\\n' 'Waiting for agent output file...'"
    launch_command="${launch_command}; OUTPUT_FILE=\"\$(python3 ${q_resolve} ${q_transcript} ${q_tool_use_id} output_file)\" || exit 1"
    launch_command="${launch_command}; [ -n \"\$OUTPUT_FILE\" ] || { echo 'Failed to resolve agent output file'; exit 1; }"
    if [ -n "$test_marker" ]; then
      q_test_marker="$(shell_quote "$test_marker")"
      launch_command="${launch_command}; printf '%s\\n' ${q_test_marker} \"\$OUTPUT_FILE\""
    fi
    launch_command="${launch_command}; printf '%s %s\\n' 'Following agent output:' \"\$OUTPUT_FILE\""
    launch_command="${launch_command}; exec python3 ${q_stream_output} \"\$OUTPUT_FILE\""
  else
    attach_command="${q_claude_bin} --agent-id \"\$AGENT_ID\""
    for arg in \
      --agent-name "$agent_name" \
      --team-name "$team_name" \
      --agent-color "$agent_color" \
      --parent-session-id "$parent_session_id" \
      "${permission_flags[@]}" \
      "${model_flags[@]}"; do
      attach_command="${attach_command} $(shell_quote "$arg")"
    done

    launch_command="${launch_command}; printf '%s\\n' 'Waiting for agent session id...'"
    launch_command="${launch_command}; AGENT_ID=\"\$(python3 ${q_resolve} ${q_transcript} ${q_tool_use_id} agent_id)\" || exit 1"
    launch_command="${launch_command}; [ -n \"\$AGENT_ID\" ] || { echo 'Failed to resolve agent id'; exit 1; }"
    if [ -n "$test_marker" ]; then
      q_test_marker="$(shell_quote "$test_marker")"
      launch_command="${launch_command}; printf '%s\\n' ${q_test_marker} \"\$AGENT_ID\""
    fi
    launch_command="${launch_command}; ATTACH_RETRY_COUNT=0"
    launch_command="${launch_command}; while true; do ATTACH_START=\$(date +%s); ${attach_command}; ATTACH_STATUS=\$?; ATTACH_END=\$(date +%s); ATTACH_DURATION=\$((ATTACH_END - ATTACH_START)); if [ \"\$ATTACH_DURATION\" -ge 2 ]; then exit \"\$ATTACH_STATUS\"; fi; ATTACH_RETRY_COUNT=\$((ATTACH_RETRY_COUNT + 1)); if [ \"\$ATTACH_RETRY_COUNT\" -ge 30 ]; then echo 'Failed to attach to agent session after retries.'; exit \"\$ATTACH_STATUS\"; fi; echo 'Retrying agent attach...'; sleep 1; done"
  fi

  if [ -n "$launch_command" ]; then
    start_agent_task_watcher "$sid"
    exec_tile_command "$sid" "$launch_command"
  fi
}

HOOK_MODE=""
if [ -n "$AGENT_NAME" ] && [ -n "$TEAM_NAME" ] && [ -n "$SESSION_ID" ]; then
  HOOK_MODE="team"
elif [ -n "$TRANSCRIPT" ] && [ -n "$TOOL_USE_ID" ] && [ -n "$SESSION_ID" ]; then
  HOOK_MODE="generic"
fi

if [ -z "$HOOK_MODE" ]; then
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"Herd skipped unsupported agent payload"}}'
  exit 0
fi

RESPONSE="$(spawn_tile)"
SID="$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('session_id',''))" 2>/dev/null)"

if [ -n "$SID" ]; then
  if [ "$HOOK_MODE" = "team" ]; then
    set_tile_role "$SID" "claude"
    launch_team_agent_tile "$SID"
  else
    if [ "$RUN_IN_BACKGROUND" = "yes" ]; then
      set_tile_role "$SID" "output"
    else
      set_tile_role "$SID" "claude"
    fi
    launch_generic_agent_tile "$SID"
  fi
fi

echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"Herd launched an agent tile"}}'
