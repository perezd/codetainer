#!/usr/bin/env bash
# attach-claude.sh — SSH attach gate called from .bashrc on SSH login.
# Never initializes anything. If a tmux session already exists, attaches
# immediately. If init is still running (start-claude.sh holds the exclusive
# flock), waits up to 5 minutes via shared flock, tailing the log for
# progress, then attaches once init completes.

LOCK_FILE="/tmp/start-claude.lock"
TMUX_SOCKET="/tmp/tmux-1000/default"
START_LOG="/tmp/start-claude.log"

export TERM="${TERM:-xterm-256color}"

# --- Reconnect: tmux session already exists ---
EXISTING_SESSION=$(tmux -S "$TMUX_SOCKET" list-sessions -F '#{session_name}' 2>/dev/null | head -1)
if [[ -n "$EXISTING_SESSION" ]]; then
  tmux -S "$TMUX_SOCKET" select-pane -t "${EXISTING_SESSION}.0" 2>/dev/null
  exec tmux -S "$TMUX_SOCKET" attach-session -t "$EXISTING_SESSION"
fi

# --- Init still running: wait for start-claude.sh to release exclusive lock ---
echo "Waiting for Claude to initialize..."

TAIL_PID=""

# Start tailing the log for progress visibility; retry if log not yet created (60s timeout)
for i in $(seq 1 60); do
  if [[ -f "$START_LOG" ]] && [[ ! -L "$START_LOG" ]]; then
    tail -f "$START_LOG" &
    TAIL_PID=$!
    break
  elif [[ -L "$START_LOG" ]]; then
    echo "WARNING: Refusing to tail symlinked log file at $START_LOG" >&2
    break
  fi
  sleep 1
done

# Acquire shared lock (blocks until start-claude.sh releases its exclusive lock)
flock -s -w 300 "$LOCK_FILE" true
FLOCK_EXIT=$?

# Kill the tail process
if [[ -n "$TAIL_PID" ]]; then
  kill "$TAIL_PID" 2>/dev/null
  wait "$TAIL_PID" 2>/dev/null
fi

# Check for flock failure
if [[ $FLOCK_EXIT -ne 0 ]]; then
  if [[ ! -e "$LOCK_FILE" ]]; then
    echo "ERROR: Lock file $LOCK_FILE not found — initialization may not have started." >&2
  else
    echo "ERROR: Timed out waiting for Claude to initialize (5 min)." >&2
  fi
  echo "Check $START_LOG for details." >&2
  exit 1
fi

# Verify tmux session was created during init
SESSION=$(tmux -S "$TMUX_SOCKET" list-sessions -F '#{session_name}' 2>/dev/null | head -1)
if [[ -z "$SESSION" ]]; then
  echo "ERROR: Initialization failed — tmux session not found." >&2
  echo "Check $START_LOG for details." >&2
  exit 1
fi

# Attach to the tmux session
tmux -S "$TMUX_SOCKET" select-pane -t "${SESSION}.0" 2>/dev/null
exec tmux -S "$TMUX_SOCKET" attach-session -t "$SESSION"
