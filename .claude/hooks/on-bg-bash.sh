#!/bin/bash
# Hook: PreToolUse (Bash) — create a read-only tile for background commands
exec >/dev/null 2>&1

HERD_SOCK="${HERD_SOCK:-/tmp/herd.sock}"
[ ! -S "$HERD_SOCK" ] && { echo '{"continue": true}'; exit 0; }

INPUT=$(cat)

# Check if run_in_background is true
IS_BG=$(printf '%s' "$INPUT" | python3 -c "
import sys, json
d = json.load(sys.stdin)
ti = d.get('tool_input', {})
print('yes' if ti.get('run_in_background') else 'no')
" 2>/dev/null)

[ "$IS_BG" != "yes" ] && { echo '{"continue": true}'; exit 0; }

eval "$(printf '%s' "$INPUT" | python3 -c "
import sys, json, shlex
d = json.load(sys.stdin)
ti = d.get('tool_input', {})
cmd = ti.get('command', '')
desc = ti.get('description', cmd[:40])
print(f'CMD={shlex.quote(cmd)}')
print(f'DESC={shlex.quote(desc[:50])}')
" 2>/dev/null)" || { echo '{"continue": true}'; exit 0; }

PARENT_PANE_ID="${TMUX_PANE:-}"

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

set_tile_read_only() {
  local sid="$1"
  socket_request "$(python3 -c '
import json, sys
sid = sys.argv[1]
print(json.dumps({"command": "set_read_only", "session_id": sid, "read_only": True}))
' "$sid" 2>/dev/null)" >/dev/null 2>&1
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

RESPONSE="$(spawn_tile)"
SID=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('session_id',''))" 2>/dev/null)

if [ -n "$SID" ]; then
  set_tile_title "$SID" "BG: $DESC"
  set_tile_read_only "$SID"
  send_tile_input "$SID" "echo Running: $CMD"$'\n'
fi

echo '{"continue": true}'
