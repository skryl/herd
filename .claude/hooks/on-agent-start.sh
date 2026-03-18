#!/bin/bash
# Hook: PreToolUse (Agent) — create a read-only tile that tails the agent's transcript
exec >/dev/null 2>&1

HERD_SOCK="${HERD_SOCK:-/tmp/herd.sock}"
[ ! -S "$HERD_SOCK" ] && { echo '{"continue": true}'; exit 0; }

INPUT=$(cat)

eval "$(echo "$INPUT" | python3 -c "
import sys, json, shlex
d = json.load(sys.stdin)
ti = d.get('tool_input', {})
print(f'AGENT_TYPE={shlex.quote(ti.get(\"subagent_type\", ti.get(\"description\", \"Agent\")))}')
print(f'AGENT_PROMPT={shlex.quote(ti.get(\"prompt\", \"\")[:60])}')
print(f'TRANSCRIPT={shlex.quote(d.get(\"transcript_path\", \"\"))}')
print(f'SESSION_ID={shlex.quote(d.get(\"session_id\", \"\"))}')
" 2>/dev/null)" || { echo '{"continue": true}'; exit 0; }

HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"

# Create a tile
OFFSET_X=$(( (RANDOM % 400) + 50 ))
OFFSET_Y=$(( (RANDOM % 300) + 50 ))
RESPONSE=$(printf '{"command":"spawn_shell","x":%d,"y":%d,"width":640,"height":400}\n' "$OFFSET_X" "$OFFSET_Y" | socat - UNIX-CONNECT:"$HERD_SOCK" 2>/dev/null)
SID=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('session_id',''))" 2>/dev/null)

if [ -n "$SID" ]; then
  # Set title and mark read-only
  TITLE="${AGENT_TYPE}: ${AGENT_PROMPT}"
  printf '{"command":"set_title","session_id":"%s","title":"%s"}\n' "$SID" "$TITLE" | socat - UNIX-CONNECT:"$HERD_SOCK" >/dev/null 2>&1
  printf '{"command":"set_read_only","session_id":"%s","read_only":true}\n' "$SID" | socat - UNIX-CONNECT:"$HERD_SOCK" >/dev/null 2>&1

  # Find and tail the subagent transcript when it appears
  if [ -n "$TRANSCRIPT" ]; then
    SUBAGENT_DIR="$(dirname "$TRANSCRIPT")/subagents"
    # Watch for newest .jsonl file in the subagent directory
    CMD="echo 'Waiting for agent transcript...'; while [ ! -d '${SUBAGENT_DIR}' ]; do sleep 0.3; done; LATEST=''; while [ -z \"\$LATEST\" ]; do LATEST=\$(ls -t '${SUBAGENT_DIR}'/*.jsonl 2>/dev/null | head -1); sleep 0.3; done; echo \"Tailing \$LATEST\"; tail -f -n +1 \"\$LATEST\" | python3 '${HOOKS_DIR}/stream-transcript.py'"
    printf '{"command":"send_input","session_id":"%s","input":"%s\\n"}\n' "$SID" "$CMD" | socat - UNIX-CONNECT:"$HERD_SOCK" >/dev/null 2>&1
  fi
fi

echo '{"continue": true}'
