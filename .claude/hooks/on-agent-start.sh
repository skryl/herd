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
emit('LEGACY_SUBAGENT_TYPE', ti.get('subagent_type', ''))
emit('MODEL', ti.get('model', ''))
emit('TRANSCRIPT', d.get('transcript_path', ''))
emit('SESSION_ID', d.get('session_id', ''))
emit('CWD', d.get('cwd', ''))
emit('PERMISSION_MODE', d.get('permission_mode', ''))
" 2>/dev/null)" || { echo '{"continue": true}'; exit 0; }

HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
PARENT_PANE_ID="${TMUX_PANE:-}"
if [ -z "$PARENT_PANE_ID" ] && [[ "$SESSION_ID" == %* ]]; then
  PARENT_PANE_ID="$SESSION_ID"
fi

socket_request() {
  printf '%s\n' "$1" | socat - UNIX-CONNECT:"$HERD_SOCK" 2>/dev/null
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

send_tile_input() {
  local sid="$1"
  local command_input="$2"
  socket_request "$(python3 -c '
import json, sys
sid, command_input = sys.argv[1], sys.argv[2]
print(json.dumps({"command": "send_input", "session_id": sid, "input": command_input}))
' "$sid" "$command_input" 2>/dev/null)" >/dev/null 2>&1
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

  [ -n "$launch_command" ] && send_tile_input "$sid" "$launch_command"
}

launch_legacy_transcript_tile() {
  local sid title subagent_dir command_input

  sid="$1"
  title="${LEGACY_SUBAGENT_TYPE:-Agent}: ${AGENT_PROMPT:0:60}"
  set_tile_title "$sid" "$title"

  socket_request "$(python3 -c '
import json, sys
sid = sys.argv[1]
print(json.dumps({"command": "set_read_only", "session_id": sid, "read_only": True}))
' "$sid" 2>/dev/null)" >/dev/null 2>&1

  if [ -n "$TRANSCRIPT" ]; then
    subagent_dir="$(dirname "$TRANSCRIPT")/subagents"
    command_input="echo 'Waiting for agent transcript...'; while [ ! -d '${subagent_dir}' ]; do sleep 0.3; done; LATEST=''; while [ -z \"\$LATEST\" ]; do LATEST=\$(ls -t '${subagent_dir}'/*.jsonl 2>/dev/null | head -1); sleep 0.3; done; echo \"Tailing \$LATEST\"; tail -f -n +1 \"\$LATEST\" | python3 '${HOOKS_DIR}/stream-transcript.py'"
    send_tile_input "$sid" "${command_input}"$'\n'
  fi
}

RESPONSE="$(spawn_tile)"
SID="$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('session_id',''))" 2>/dev/null)"

if [ -n "$SID" ]; then
  if [ -n "$AGENT_NAME" ] && [ -n "$TEAM_NAME" ] && [ -n "$SESSION_ID" ]; then
    launch_team_agent_tile "$SID"
  else
    launch_legacy_transcript_tile "$SID"
  fi
fi

echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"Herd launched an agent tile"}}'
