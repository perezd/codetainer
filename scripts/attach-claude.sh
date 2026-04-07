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

# Wait for entrypoint readiness (boot may still be cloning repo, setting up network, etc.)
READY_FILE="/tmp/codetainer-ready"
if [[ ! -f "$READY_FILE" ]]; then
  for i in $(seq 1 300); do
    [[ -f "$READY_FILE" ]] && break
    sleep 1
  done
fi

if [[ ! -f "$READY_FILE" ]]; then
  echo "ERROR: Entrypoint never became ready (5 min). Boot may have failed." >&2
  echo "Check container logs for details." >&2
  if [[ -n "$TAIL_PID" ]]; then
    kill "$TAIL_PID" 2>/dev/null
    wait "$TAIL_PID" 2>/dev/null
  fi
  exit 1
fi

# Wait for lock file to be created by start-claude.sh (avoids implicitly creating it via flock)
if [[ ! -f "$LOCK_FILE" ]]; then
  for i in $(seq 1 30); do
    [[ -f "$LOCK_FILE" ]] && break
    sleep 1
  done
fi

if [[ ! -f "$LOCK_FILE" ]]; then
  echo "ERROR: Lock file $LOCK_FILE not found — start-claude may have failed to launch." >&2
  echo "Check $START_LOG for details." >&2
  if [[ -n "$TAIL_PID" ]]; then
    kill "$TAIL_PID" 2>/dev/null
    wait "$TAIL_PID" 2>/dev/null
  fi
  exit 1
fi

# Acquire shared lock via read-only FD (blocks until start-claude.sh releases its exclusive lock)
exec 8<"$LOCK_FILE"
flock -s -w 300 8
FLOCK_EXIT=$?
exec 8<&-

# Kill the tail process
if [[ -n "$TAIL_PID" ]]; then
  kill "$TAIL_PID" 2>/dev/null
  wait "$TAIL_PID" 2>/dev/null
fi

# Check for flock timeout
if [[ $FLOCK_EXIT -ne 0 ]]; then
  echo "ERROR: Timed out waiting for Claude to initialize (5 min)." >&2
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
