#!/usr/bin/env bash

TMUX_SOCKET="/tmp/tmux-1000/default"
CLAUDE_HOME="/home/claude"
START_LOG="/tmp/start-claude.log"

# Ensure UTF-8 locale for TUI rendering (box-drawing chars, logo, etc.)
export LANG="${LANG:-en_US.UTF-8}"
export LC_ALL="${LC_ALL:-en_US.UTF-8}"

# OTEL env whitelist (populated after readiness wait below)
OTEL_ENV_ARGS=()
OTEL_ALLOWED_KEYS="CLAUDE_CODE_ENABLE_TELEMETRY OTEL_METRICS_EXPORTER OTEL_LOGS_EXPORTER OTEL_EXPORTER_OTLP_PROTOCOL OTEL_EXPORTER_OTLP_ENDPOINT OTEL_EXPORTER_OTLP_HEADERS OTEL_LOG_USER_PROMPTS OTEL_LOG_TOOL_DETAILS"

# Helper to run commands as claude user with standard environment
run_as_claude() {
  sudo -u claude \
    HOME="$CLAUDE_HOME" \
    PATH="$CLAUDE_HOME/.local/bin:$CLAUDE_HOME/.bun/bin:$PATH" \
    GH_CONFIG_DIR="/opt/gh-config" \
    CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN" \
    LANG="$LANG" \
    LC_ALL="$LC_ALL" \
    "${OTEL_ENV_ARGS[@]}" \
    "$@"
}

# If any tmux session already exists, reattach to it (session may have been renamed)
EXISTING_SESSION=$(tmux -S "$TMUX_SOCKET" list-sessions -F '#{session_name}' 2>/dev/null | head -1)
if [[ -n "$EXISTING_SESSION" ]]; then
  tmux -S "$TMUX_SOCKET" select-pane -t "$EXISTING_SESSION.0" 2>/dev/null || true
  exec tmux -S "$TMUX_SOCKET" attach -t "$EXISTING_SESSION"
fi

# Log first-connect output for debugging (visible on terminal and persisted to file)
exec 3>&1 4>&2
exec > >(tee -a "$START_LOG") 2>&1

# Check that the OAuth token is available
if [[ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
  echo ""
  echo "ERROR: CLAUDE_CODE_OAUTH_TOKEN is not set."
  echo ""
  echo "To authenticate:"
  echo "  1. Run 'claude setup-token' on your local machine"
  echo "  2. fly secrets set CLAUDE_CODE_OAUTH_TOKEN=<token> -a <app>"
  echo "  3. Restart the machine"
  echo ""
  exit 1
fi

# Write tmux config (optimized for Claude Code TUI over SSH)
cat > /tmp/.tmux.conf <<'TMUX'
set -g status off
set -g remain-on-exit off
set -g default-terminal "tmux-256color"
set -ag terminal-overrides ",xterm-256color:RGB"
set -g allow-passthrough on
set -g extended-keys on
set -as terminal-features 'xterm*:extkeys'
set -sg escape-time 0
set -g set-clipboard on
set -g history-limit 250000
set -g focus-events on
set -g mouse on
set -ga terminal-overrides ",*:Smulx=\E[4::%p1%dm"
set -ga terminal-overrides ",*:Setulc=\E[58::2::%p1%{65536}%/%d::%p1%{256}%/%{255}%&%d::%p1%{255}%&%d%;m"
TMUX

# Wait for entrypoint to finish setup (repo clone, plugins, network)
echo "Waiting for claudetainer to be ready..."
for i in $(seq 1 60); do
  [[ -f /tmp/claudetainer-ready ]] && break
  sleep 1
done

if [[ ! -f /tmp/claudetainer-ready ]]; then
  echo "WARNING: Timed out waiting for readiness (60s). Starting anyway."
fi

# Build OTEL env array after readiness (entrypoint writes otel-env before ready marker)
if [[ -f /tmp/otel/otel-env ]] && [[ ! -L /tmp/otel/otel-env ]]; then
  while IFS='=' read -r key value; do
    [[ -z "$key" ]] && continue
    if [[ " $OTEL_ALLOWED_KEYS " == *" $key "* ]]; then
      OTEL_ENV_ARGS+=("$key=$value")
    fi
  done < /tmp/otel/otel-env
fi

# Determine working directory (after readiness — repo may have just been cloned)
WORK_DIR="/workspace"
if [[ -d /workspace/repo ]]; then
  WORK_DIR="/workspace/repo"
fi


# Install plugins (marketplace must be added first — plugin install does not clone it)
echo "Installing plugins..."
if run_as_claude claude plugin marketplace add anthropics/claude-plugins-official 2>&1; then
  run_as_claude claude plugin install superpowers@claude-plugins-official 2>&1 \
    || echo "WARNING: Plugin install failed (superpowers)" >&2
  run_as_claude claude plugin install typescript-lsp@claude-plugins-official 2>&1 \
    || echo "WARNING: Plugin install failed (typescript-lsp)" >&2
else
  echo "WARNING: Failed to add marketplace — skipping plugin install" >&2
fi

# Restore original stdout/stderr before tmux (tee would interfere with TUI)
exec 1>&3 2>&4 3>&- 4>&-

# Start Claude Code in tmux as the claude user
sudo -u claude \
  HOME="$CLAUDE_HOME" \
  PATH="$CLAUDE_HOME/.local/bin:$CLAUDE_HOME/.bun/bin:$PATH" \
  GH_CONFIG_DIR="/opt/gh-config" \
  CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN" \
  COLORTERM="truecolor" \
  LANG="$LANG" \
  LC_ALL="$LC_ALL" \
  "${OTEL_ENV_ARGS[@]}" \
  tmux -f /tmp/.tmux.conf new-session -d -s claude \
    -c "$WORK_DIR" \
    "claude --dangerously-skip-permissions"

# Add a terminal pane below Claude Code (20% height)
sudo -u claude \
  HOME="$CLAUDE_HOME" \
  PATH="$CLAUDE_HOME/.local/bin:$CLAUDE_HOME/.bun/bin:$PATH" \
  GH_CONFIG_DIR="/opt/gh-config" \
  COLORTERM="truecolor" \
  LANG="$LANG" \
  LC_ALL="$LC_ALL" \
  "${OTEL_ENV_ARGS[@]}" \
  tmux -S "$TMUX_SOCKET" split-window -t claude -v -l 20% -c "$WORK_DIR" "bash --login -i"

# Select the Claude Code pane (top) so it's focused on attach
tmux -S "$TMUX_SOCKET" select-pane -t claude.0

# Attach (focus stays on Claude Code pane)
exec tmux -S "$TMUX_SOCKET" attach -t claude
