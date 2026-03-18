#!/bin/bash
# Hook: SubagentStart — spawn a visible Herd tile for each sub-agent
# This runs as a side effect; the agent itself runs normally inside Claude Code.

# Try to get HERD_SOCK from tmux environment if not already set
if [ -z "$HERD_SOCK" ]; then
  HERD_SOCK=$(tmux -L herd show-environment -g HERD_SOCK 2>/dev/null | sed 's/^HERD_SOCK=//')
fi
if [ -z "$HERD_SOCK" ]; then
  HERD_SOCK="/tmp/herd.sock"
fi
if [ ! -S "$HERD_SOCK" ]; then
  exit 0
fi

HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"

# Read hook input from stdin (Claude Code passes JSON via stdin)
INPUT=$(cat)

# Parse all fields in a single python3 call to stay well within the 5s timeout
eval "$(echo "$INPUT" | python3 -c "
import sys, json, shlex
d = json.load(sys.stdin)
print(f'AGENT_TYPE={shlex.quote(d.get(\"agent_type\",\"Agent\"))}')
print(f'AGENT_ID={shlex.quote(d.get(\"agent_id\",\"\"))}')
print(f'TRANSCRIPT={shlex.quote(d.get(\"transcript_path\",\"\"))}')
" 2>/dev/null)" || { echo '{"continue": true}'; exit 0; }

# Auto-position: offset each new tile to avoid stacking
OFFSET_X=$(( (RANDOM % 400) + 50 ))
OFFSET_Y=$(( (RANDOM % 300) + 50 ))

# Spawn a shell tile
RESPONSE=$(echo "{\"command\":\"spawn_shell\",\"x\":${OFFSET_X},\"y\":${OFFSET_Y},\"width\":640,\"height\":400}" | socat - UNIX-CONNECT:"$HERD_SOCK" 2>/dev/null)

if [ -n "$RESPONSE" ]; then
  SESSION_ID=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('session_id',''))" 2>/dev/null)
  if [ -n "$SESSION_ID" ]; then
    # Set the tile title
    echo "{\"command\":\"set_title\",\"session_id\":\"${SESSION_ID}\",\"title\":\"${AGENT_TYPE} [${AGENT_ID:0:8}]\"}" | socat - UNIX-CONNECT:"$HERD_SOCK" >/dev/null 2>&1

    # Stream the subagent's own transcript into the shell
    if [ -n "$TRANSCRIPT" ] && [ -n "$AGENT_ID" ]; then
      PARENT_DIR=$(dirname "$TRANSCRIPT")
      PARENT_ID=$(basename "$TRANSCRIPT" .jsonl)
      SUBAGENT_TRANSCRIPT="${PARENT_DIR}/${PARENT_ID}/subagents/agent-${AGENT_ID}.jsonl"

      # Embed the wait-for-file into the shell command itself (not in the hook)
      # so we don't burn the hook's 5s timeout
      CMD="while [ ! -f '${SUBAGENT_TRANSCRIPT}' ]; do sleep 0.2; done; tail -f -n +1 '${SUBAGENT_TRANSCRIPT}' | python3 '${HOOKS_DIR}/stream-transcript.py'"

      PAYLOAD=$(python3 -c "
import json, sys
cmd = sys.argv[1]
sid = sys.argv[2]
print(json.dumps({'command':'send_input','session_id':sid,'input':cmd+chr(10)}))
" "$CMD" "$SESSION_ID" 2>/dev/null)
      if [ -n "$PAYLOAD" ]; then
        echo "$PAYLOAD" | socat - UNIX-CONNECT:"$HERD_SOCK" >/dev/null 2>&1
      fi
    fi
  fi
fi

# Always continue — don't block the agent
echo '{"continue": true}'
