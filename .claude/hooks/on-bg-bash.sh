#!/bin/bash
# Hook: PreToolUse (Bash) — create a read-only tile for background commands
exec >/dev/null 2>&1

HERD_SOCK="${HERD_SOCK:-/tmp/herd.sock}"
[ ! -S "$HERD_SOCK" ] && { echo '{"continue": true}'; exit 0; }

INPUT=$(cat)

# Check if run_in_background is true
IS_BG=$(echo "$INPUT" | python3 -c "
import sys, json
d = json.load(sys.stdin)
ti = d.get('tool_input', {})
print('yes' if ti.get('run_in_background') else 'no')
" 2>/dev/null)

[ "$IS_BG" != "yes" ] && { echo '{"continue": true}'; exit 0; }

eval "$(echo "$INPUT" | python3 -c "
import sys, json, shlex
d = json.load(sys.stdin)
ti = d.get('tool_input', {})
cmd = ti.get('command', '')
desc = ti.get('description', cmd[:40])
print(f'CMD={shlex.quote(cmd)}')
print(f'DESC={shlex.quote(desc[:50])}')
" 2>/dev/null)" || { echo '{"continue": true}'; exit 0; }

# Create a tile
OFFSET_X=$(( (RANDOM % 400) + 50 ))
OFFSET_Y=$(( (RANDOM % 300) + 50 ))
RESPONSE=$(printf '{"command":"spawn_shell","x":%d,"y":%d,"width":640,"height":400}\n' "$OFFSET_X" "$OFFSET_Y" | socat - UNIX-CONNECT:"$HERD_SOCK" 2>/dev/null)
SID=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('session_id',''))" 2>/dev/null)

if [ -n "$SID" ]; then
  printf '{"command":"set_title","session_id":"%s","title":"BG: %s"}\n' "$SID" "$DESC" | socat - UNIX-CONNECT:"$HERD_SOCK" >/dev/null 2>&1
  printf '{"command":"set_read_only","session_id":"%s","read_only":true}\n' "$SID" | socat - UNIX-CONNECT:"$HERD_SOCK" >/dev/null 2>&1
  # Show the command being run (read-only display)
  printf '{"command":"send_input","session_id":"%s","input":"echo Running: %s\\n"}\n' "$SID" "$CMD" | socat - UNIX-CONNECT:"$HERD_SOCK" >/dev/null 2>&1
fi

echo '{"continue": true}'
