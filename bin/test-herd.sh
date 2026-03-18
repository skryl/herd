#!/bin/bash
# End-to-end test for Herd's tmux integration
# Tests: tmux lifecycle, -CC connection, pane detection, input/output, reconnection

set -e
PASS=0
FAIL=0
SERVER="herd-test"
SOCK="/tmp/herd-test.sock"

pass() { echo "  ✓ $1"; PASS=$((PASS+1)); }
fail() { echo "  ✗ $1: $2"; FAIL=$((FAIL+1)); }

cleanup() {
    tmux -L "$SERVER" kill-server 2>/dev/null || true
    rm -f "$SOCK"
}
trap cleanup EXIT

echo "=== Herd Integration Tests ==="
echo ""

# --- Test 1: tmux server lifecycle ---
echo "1. tmux server lifecycle"
cleanup
tmux -L "$SERVER" new-session -d -s herd -x 80 -y 24 -e "HERD_SOCK=$SOCK" /bin/zsh
if tmux -L "$SERVER" has-session -t herd 2>/dev/null; then
    pass "create session"
else
    fail "create session" "session not found"
fi

tmux -L "$SERVER" set -g status off
tmux -L "$SERVER" set -g exit-empty off
pass "set options"

# --- Test 2: pane creation ---
echo "2. pane creation"
tmux -L "$SERVER" new-window -t herd /bin/zsh
tmux -L "$SERVER" new-window -t herd /bin/zsh
sleep 0.5
COUNT=$(tmux -L "$SERVER" list-panes -s -t herd -F '#{pane_id}' | wc -l | tr -d ' ')
if [ "$COUNT" -eq 3 ]; then
    pass "3 panes created"
else
    fail "3 panes created" "got $COUNT"
fi

PANES=$(tmux -L "$SERVER" list-panes -s -t herd -F '#{pane_id}')
PANE1=$(echo "$PANES" | head -1)
PANE2=$(echo "$PANES" | sed -n 2p)
PANE3=$(echo "$PANES" | sed -n 3p)

# --- Test 3: direct send-keys input ---
echo "3. direct send-keys input"
tmux -L "$SERVER" send-keys -t "$PANE1" 'echo DIRECT_TEST_123' Enter
sleep 0.5
OUTPUT=$(tmux -L "$SERVER" capture-pane -t "$PANE1" -p | grep DIRECT_TEST_123 || true)
if [ -n "$OUTPUT" ]; then
    pass "send-keys input works"
else
    fail "send-keys input works" "output not found"
fi

# --- Test 4: send-keys -H (hex mode) ---
echo "4. send-keys -H (hex mode)"
# Send "echo HEX_OK\n" as hex
HEX=$(echo -n 'echo HEX_OK' | xxd -p | sed 's/../& /g')
tmux -L "$SERVER" send-keys -t "$PANE2" -H $HEX 0a
sleep 0.5
OUTPUT=$(tmux -L "$SERVER" capture-pane -t "$PANE2" -p | grep HEX_OK || true)
if [ -n "$OUTPUT" ]; then
    pass "send-keys -H hex input works"
else
    fail "send-keys -H hex input works" "output not found"
fi

# --- Test 5: -CC connection via portable-pty simulation ---
echo "5. -CC connection (via script wrapper)"
# Start -CC in background, capture output
CC_OUTPUT="/tmp/herd-test-cc-output.txt"
rm -f "$CC_OUTPUT"
script -q /dev/null tmux -L "$SERVER" -CC attach-session -t herd > "$CC_OUTPUT" 2>/dev/null &
CC_PID=$!
sleep 1

if ps -p $CC_PID > /dev/null 2>&1; then
    pass "-CC process started"
else
    fail "-CC process started" "process died"
fi

# Check for session-changed event
if grep -q "%session-changed" "$CC_OUTPUT" 2>/dev/null; then
    pass "-CC received %session-changed"
else
    fail "-CC received %session-changed" "not found in output"
fi

# --- Test 6: -CC receives %output ---
echo "6. -CC output streaming"
tmux -L "$SERVER" send-keys -t "$PANE3" 'echo CC_OUTPUT_TEST' Enter
sleep 1
if grep -q "%output" "$CC_OUTPUT" 2>/dev/null; then
    pass "-CC receives %output events"
else
    fail "-CC receives %output events" "no %output in stream"
fi

# Check for CC_OUTPUT_TEST in the output
if grep -q "CC_OUTPUT_TEST" "$CC_OUTPUT" 2>/dev/null; then
    pass "-CC captured command output"
else
    fail "-CC captured command output" "CC_OUTPUT_TEST not found"
fi

# --- Test 7: -CC detects new pane ---
echo "7. -CC pane detection"
tmux -L "$SERVER" new-window -t herd /bin/zsh
sleep 1
if grep -q "%window-add\|%layout-change" "$CC_OUTPUT" 2>/dev/null; then
    pass "-CC detected new window/pane"
else
    fail "-CC detected new window/pane" "no window events"
fi

# --- Test 8: split-window (simulating Claude Code) ---
echo "8. split-window detection"
tmux -L "$SERVER" split-window -t herd -d /bin/zsh
sleep 1
LAYOUT_COUNT=$(grep -c "%layout-change" "$CC_OUTPUT" 2>/dev/null || echo 0)
if [ "$LAYOUT_COUNT" -gt 0 ]; then
    pass "split-window triggers %layout-change ($LAYOUT_COUNT events)"
else
    fail "split-window triggers %layout-change" "no layout events"
fi

# --- Test 9: -CC stability under rapid splits ---
echo "9. -CC stability under rapid splits"
for i in 1 2 3; do
    tmux -L "$SERVER" split-window -t herd -d "echo AGENT_$i; sleep 30" 2>/dev/null || true
done
sleep 2
if ps -p $CC_PID > /dev/null 2>&1; then
    pass "-CC survived 3 rapid splits"
else
    fail "-CC survived 3 rapid splits" "process died"
fi

# Kill CC
kill $CC_PID 2>/dev/null || true
wait $CC_PID 2>/dev/null || true
rm -f "$CC_OUTPUT"

# --- Test 10: pane kill + session survival ---
echo "10. session survival on last pane kill"
# Kill all panes except one
PANES=$(tmux -L "$SERVER" list-panes -s -t herd -F '#{pane_id}')
PANE_COUNT=$(echo "$PANES" | wc -l | tr -d ' ')
echo "$PANES" | tail -n +2 | while read p; do
    tmux -L "$SERVER" kill-pane -t "$p" 2>/dev/null || true
done
sleep 0.5
# Kill the last one
LAST=$(tmux -L "$SERVER" list-panes -s -t herd -F '#{pane_id}' 2>/dev/null | head -1)
if [ -n "$LAST" ]; then
    # Create a new window before killing the last pane
    tmux -L "$SERVER" new-window -t herd /bin/zsh
    tmux -L "$SERVER" kill-pane -t "$LAST" 2>/dev/null
    sleep 0.5
    if tmux -L "$SERVER" has-session -t herd 2>/dev/null; then
        pass "session survives after last pane replaced"
    else
        fail "session survives after last pane replaced" "session died"
    fi
else
    fail "session survives" "no panes found"
fi

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
exit $FAIL
