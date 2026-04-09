#!/usr/bin/env bash
# Init-only boot script — called once by entrypoint, not from SSH.
# Acquires exclusive flock during init; attach-claude.sh waits on shared lock.

TMUX_SOCKET="/tmp/tmux-1000/default"
CLAUDE_HOME="/home/claude"
START_LOG="/tmp/start-claude.log"
LOCK_FILE="/tmp/start-claude.lock"

# Ensure UTF-8 locale for TUI rendering (box-drawing chars, logo, etc.)
export LANG="${LANG:-en_US.UTF-8}"
export LC_ALL="${LC_ALL:-en_US.UTF-8}"

# OTEL env whitelist (populated after readiness wait below)
OTEL_ENV_ARGS=()
OTEL_ALLOWED_KEYS="CLAUDE_CODE_ENABLE_TELEMETRY OTEL_METRICS_EXPORTER OTEL_LOGS_EXPORTER OTEL_EXPORTER_OTLP_PROTOCOL OTEL_EXPORTER_OTLP_ENDPOINT OTEL_EXPORTER_OTLP_HEADERS OTEL_LOG_USER_PROMPTS OTEL_LOG_TOOL_DETAILS OTEL_RESOURCE_ATTRIBUTES CLAUDE_CODE_ENHANCED_TELEMETRY_BETA OTEL_TRACES_EXPORTER OTEL_LOG_TOOL_CONTENT"

# Helper to run commands as claude user with standard environment
run_as_claude() {
  sudo -u claude \
    HOME="$CLAUDE_HOME" \
    PATH="$CLAUDE_HOME/.local/bin:$CLAUDE_HOME/.bun/bin:$PATH" \
    GH_TOKEN="$GH_PAT" \
    CODETAINER_NPM_TOKEN="$GH_PAT" \
    CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN" \
    GOPATH="$CLAUDE_HOME/go" \
    GOPROXY="${GOPROXY:-https://proxy.golang.org,off}" \
    GONOSUMDB="${GONOSUMDB-}" \
    GOFLAGS="${GOFLAGS-}" \
    GOTELEMETRY="${GOTELEMETRY:-off}" \
    LANG="$LANG" \
    LC_ALL="$LC_ALL" \
    "${OTEL_ENV_ARGS[@]}" \
    "$@"
}

# --- Acquire exclusive lock (attach-claude.sh blocks on shared lock until released) ---
# Symlink guard: lock file must not be a symlink
if [[ -L "$LOCK_FILE" ]]; then
  rm -f "$LOCK_FILE"
fi
exec 9>"$LOCK_FILE"
flock -x 9

# --- Symlink guard: log file must not be a symlink ---
if [[ -L "$START_LOG" ]]; then
  rm -f "$START_LOG"
fi

# --- Set up logging (stdout/stderr to both console and log file during early init) ---
exec > >(tee -a "$START_LOG") 2>&1

# --- Wait for readiness ---
echo "Waiting for codetainer to be ready..."
for i in $(seq 1 60); do
  [[ -f /tmp/codetainer-ready ]] && break
  sleep 1
done

if [[ ! -f /tmp/codetainer-ready ]]; then
  echo "WARNING: Timed out waiting for readiness (60s). Starting anyway."
fi

# --- Build OTEL env array (entrypoint writes otel-env before ready marker) ---
if [[ -f /tmp/otel/otel-env ]] && [[ ! -L /tmp/otel/otel-env ]]; then
  while IFS='=' read -r key value; do
    [[ -z "$key" ]] && continue
    if [[ " $OTEL_ALLOWED_KEYS " == *" $key "* ]]; then
      OTEL_ENV_ARGS+=("$key=$value")
    fi
  done < /tmp/otel/otel-env
fi

# --- Write tmux config (optimized for Claude Code TUI over SSH) ---
# Symlink guard: tmux config must not be a symlink
if [[ -L /tmp/.tmux.conf ]]; then
  rm -f /tmp/.tmux.conf
fi
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

# --- Write CLAUDE_PROMPT to temp file if set ---
if [[ -n "${CLAUDE_PROMPT:-}" ]]; then
  [[ -L /tmp/claude-prompt ]] && rm -f /tmp/claude-prompt
  printf '%s' "$CLAUDE_PROMPT" > /tmp/claude-prompt
  chown claude:claude /tmp/claude-prompt
  chmod 600 /tmp/claude-prompt
  PROMPT_HASH=$(sha256sum < /tmp/claude-prompt | awk '{print $1}')
  echo "CLAUDE_PROMPT set (sha256: $PROMPT_HASH)"
fi

# --- Determine working directory (after readiness — repo may have just been cloned) ---
WORK_DIR="/workspace"
if [[ -d /workspace/repo ]]; then
  WORK_DIR="/workspace/repo"
fi

# --- Install plugins (marketplace must be added first) ---
echo "Installing plugins..."
if run_as_claude claude plugin marketplace add anthropics/claude-plugins-official 2>&1; then
  run_as_claude claude plugin install superpowers@claude-plugins-official 2>&1 \
    || echo "WARNING: Plugin install failed (superpowers)" >&2
  run_as_claude claude plugin install typescript-lsp@claude-plugins-official 2>&1 \
    || echo "WARNING: Plugin install failed (typescript-lsp)" >&2
  run_as_claude claude plugin install gopls-lsp@claude-plugins-official 2>&1 \
    || echo "WARNING: Plugin install failed (gopls-lsp)" >&2
else
  echo "WARNING: Failed to add marketplace — skipping plugin install" >&2
fi

# --- Redirect to log file before tmux (tee process substitution would interfere with TUI) ---
exec 1>>"$START_LOG" 2>&1

# --- Build claude command (with prompt if available) ---
# Write a launcher script to handle prompt delivery safely. The prompt may contain
# quotes, newlines, or shell metacharacters — reading it inside a properly quoted
# variable avoids all escaping issues. tmux runs this script via sh -c.
if [[ -f /tmp/claude-prompt ]]; then
  # Symlink guard: launcher script must not be a symlink
  [[ -L /tmp/claude-launcher.sh ]] && rm -f /tmp/claude-launcher.sh
  cat > /tmp/claude-launcher.sh <<'LAUNCHER'
#!/usr/bin/env bash
PROMPT=$(cat /tmp/claude-prompt)
rm -f /tmp/claude-prompt
exec claude --dangerously-skip-permissions "$PROMPT"
LAUNCHER
  chown claude:claude /tmp/claude-launcher.sh
  chmod 700 /tmp/claude-launcher.sh
  CLAUDE_CMD="bash /tmp/claude-launcher.sh"
else
  CLAUDE_CMD="claude --dangerously-skip-permissions"
fi

# --- Start Claude Code in tmux as the claude user ---
sudo -u claude \
  HOME="$CLAUDE_HOME" \
  PATH="$CLAUDE_HOME/.local/bin:$CLAUDE_HOME/.bun/bin:$PATH" \
  GH_TOKEN="$GH_PAT" \
  CODETAINER_NPM_TOKEN="$GH_PAT" \
  CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN" \
  GOPATH="$CLAUDE_HOME/go" \
  GOPROXY="${GOPROXY:-https://proxy.golang.org,off}" \
  GONOSUMDB="${GONOSUMDB-}" \
  GOFLAGS="${GOFLAGS-}" \
  GOTELEMETRY="${GOTELEMETRY:-off}" \
  COLORTERM="truecolor" \
  LANG="$LANG" \
  LC_ALL="$LC_ALL" \
  "${OTEL_ENV_ARGS[@]}" \
  tmux -f /tmp/.tmux.conf new-session -d -s claude \
    -c "$WORK_DIR" \
    "$CLAUDE_CMD"

# --- Add a terminal pane below Claude Code (20% height) ---
sudo -u claude \
  HOME="$CLAUDE_HOME" \
  PATH="$CLAUDE_HOME/.local/bin:$CLAUDE_HOME/.bun/bin:$PATH" \
  GH_TOKEN="$GH_PAT" \
  CODETAINER_NPM_TOKEN="$GH_PAT" \
  GOPATH="$CLAUDE_HOME/go" \
  GOPROXY="${GOPROXY:-https://proxy.golang.org,off}" \
  GONOSUMDB="${GONOSUMDB-}" \
  GOFLAGS="${GOFLAGS-}" \
  GOTELEMETRY="${GOTELEMETRY:-off}" \
  COLORTERM="truecolor" \
  LANG="$LANG" \
  LC_ALL="$LC_ALL" \
  "${OTEL_ENV_ARGS[@]}" \
  tmux -S "$TMUX_SOCKET" split-window -t claude -v -l 20% -c "$WORK_DIR" "bash --login -i"

# --- Select the Claude Code pane (top) so it's focused on attach ---
tmux -S "$TMUX_SOCKET" select-pane -t claude.0

# --- Release the exclusive lock ---
exec 9>&-
