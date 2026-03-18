#!/bin/bash
# Called by tmux hooks when a new pane is created (split-window / new-window).
# Moves the pane into its own tmux session so Herd can attach a tile to it.
#
# Args: $1 = pane_id, $2 = parent session name, $3 = socket path

# Suppress ALL output — tmux run-shell -b shows stdout in the active pane
exec >/dev/null 2>&1

PANE_ID="$1"
PARENT_SESSION="$2"
HERD_SOCK="$3"

[ -z "$PANE_ID" ] || [ -z "$PARENT_SESSION" ] || [ -z "$HERD_SOCK" ] && exit 0

# Only act when there are multiple panes (a split happened)
PANE_COUNT=$(tmux -L herd list-panes -t "$PARENT_SESSION" 2>/dev/null | wc -l | tr -d ' ')
[ "$PANE_COUNT" -le 1 ] && exit 0

# Grab the teammate's command for naming
PANE_CMD=$(tmux -L herd display-message -t "$PANE_ID" -p '#{pane_current_command}' 2>/dev/null)

NEW_SESSION=$(uuidgen | tr '[:upper:]' '[:lower:]')

# Create a new session with a dummy pane
tmux -L herd new-session -d -s "$NEW_SESSION" || exit 0
DUMMY_PANE=$(tmux -L herd list-panes -t "$NEW_SESSION" -F '#{pane_id}' | head -1)

# Swap: teammate goes to new session, dummy goes to parent
tmux -L herd swap-pane -s "$PANE_ID" -t "$DUMMY_PANE" || {
    tmux -L herd kill-session -t "$NEW_SESSION"
    exit 0
}

# Kill the dummy (now in the parent session where the teammate was)
tmux -L herd kill-pane -t "$DUMMY_PANE"

# Propagate env
tmux -L herd set-environment -t "$NEW_SESSION" HERD_SOCK "$HERD_SOCK"
tmux -L herd set-environment -t "$NEW_SESSION" HERD_SESSION_ID "$NEW_SESSION"

# Derive tile name
TILE_NAME="${PANE_CMD:-agent}"
case "$TILE_NAME" in zsh|bash|sh|fish) TILE_NAME="agent";; esac

# Notify Herd
printf '{"command":"tmux_pane_created","tmux_session":"%s","parent_session_id":"%s","title":"%s"}\n' \
    "$NEW_SESSION" "$PARENT_SESSION" "$TILE_NAME" | socat - UNIX-CONNECT:"$HERD_SOCK"

exit 0
