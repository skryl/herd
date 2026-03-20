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
print(f'TRANSCRIPT={shlex.quote(str(d.get(\"transcript_path\") or d.get(\"transcriptPath\") or \"\"))}')
print(f'TOOL_USE_ID={shlex.quote(str(d.get(\"tool_use_id\") or d.get(\"toolUseID\") or d.get(\"toolUseId\") or \"\"))}')
" 2>/dev/null)" || { echo '{"continue": true}'; exit 0; }

HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
PARENT_PANE_ID="${TMUX_PANE:-}"

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

set_tile_read_only() {
  local sid="$1"
  socket_request "$(python3 -c '
import json, sys
sid = sys.argv[1]
print(json.dumps({"command": "set_read_only", "session_id": sid, "read_only": True}))
' "$sid" 2>/dev/null)" >/dev/null 2>&1
}

set_tile_role() {
  local sid="$1"
  socket_request "$(python3 -c '
import json, sys
sid = sys.argv[1]
print(json.dumps({"command": "set_tile_role", "session_id": sid, "role": "output"}))
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

start_task_watcher() {
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

RESPONSE="$(spawn_tile)"
SID=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('session_id',''))" 2>/dev/null)

if [ -n "$SID" ]; then
  set_tile_title "$SID" "BG: $DESC"
  set_tile_read_only "$SID"
  set_tile_role "$SID"
  start_task_watcher "$SID"
  send_tile_input "$SID" "echo Running: $CMD"$'\n'
fi

echo '{"continue": true}'
