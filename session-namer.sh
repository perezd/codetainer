#!/bin/bash
# Stop hook: after Claude's first response in a session, rename the tmux
# session to a short summary of what the user is working on.
# Keys off session_id so it re-fires after /clear or new sessions.

# Prevent infinite recursion: the claude -p call below also triggers
# this Stop hook, which would spawn another claude -p, ad infinitum.
[ -n "$CLAUDE_SESSION_NAMER" ] && exit 0

input=$(cat)

# Extract session ID to use as sentinel key
session_id=$(echo "$input" | jq -r '.session_id // empty' 2>/dev/null)
[ -z "$session_id" ] && exit 0

SENTINEL="/tmp/claude-session-named-${session_id}"
[ -f "$SENTINEL" ] && exit 0
touch "$SENTINEL"

# Run in background so we don't block Claude Code
(
  # Use haiku for speed/cost — we just need a short label
  context=$(echo "$input" | head -c 2000)
  name=$(CLAUDE_SESSION_NAMER=1 claude -p \
      --model claude-haiku-4-5-20251001 \
      --max-turns 1 \
      "You are a session naming tool. Based on the following Claude Code session data, generate a short kebab-case name (2-4 words) describing what the user is working on. Respond with ONLY the name. Examples: fixing-auth-bug, adding-search-api, refactoring-db-layer, updating-dockerfile. Session data: $context" \
      2>/dev/null | \
    tr -d '\n' | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]//g' | head -c 50)

  if [ -n "$name" ]; then
    tmux rename-session -t claude "$name" 2>/dev/null || true
  fi
) &

exit 0
