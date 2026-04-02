#!/usr/bin/env bash
set -euo pipefail

echo "[ENTRYPOINT] Starting claudetainer..."

# === 0. Validate required secrets ===
missing=()
[[ -z "${GH_PAT:-}" ]] && missing+=("GH_PAT")
[[ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]] && missing+=("CLAUDE_CODE_OAUTH_TOKEN")
if [[ ${#missing[@]} -gt 0 ]]; then
  echo "[ENTRYPOINT] ERROR: Missing required secrets: ${missing[*]}" >&2
  echo "[ENTRYPOINT] Set them with: fly secrets set ${missing[*]/%/=<value>} -a <app>" >&2
  exit 1
fi

# === 1. Filesystem hardening ===
# Mount tmpfs at writable paths before anything else
mount -t tmpfs -o size=512m tmpfs /workspace
mount -t tmpfs -o size=128m tmpfs /tmp
mount -t tmpfs -o size=1024m tmpfs /home/claude
chmod 1777 /tmp

# Set ownership and create subdirectories
chown claude:claude /workspace /home/claude
mkdir -p /home/claude/.cache /home/claude/.claude /home/claude/.local/bin /home/claude/.bun/bin
chown -R claude:claude /home/claude/.cache /home/claude/.claude /home/claude/.local /home/claude/.bun

# Shell prompt: path relative to repo root + git branch
cat > /home/claude/.bashrc <<'BASHRC'
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"

__ps1_path() {
  local git_root
  git_root=$(git rev-parse --show-toplevel 2>/dev/null) || { echo '\w'; return; }
  local repo_name=${git_root##*/}
  local rel=${PWD#"$git_root"}
  if [[ -z "$rel" ]]; then
    echo "$repo_name"
  else
    echo "$repo_name$rel"
  fi
}
__ps1_branch() {
  git branch --show-current 2>/dev/null
}
PS1='\[\e[1;36m\]$(__ps1_path)\[\e[0m\] \[\e[1;33m\]($(__ps1_branch))\[\e[0m\]\n\$ '
BASHRC
chown claude:claude /home/claude/.bashrc

# Ensure .bashrc is sourced by login shells (tmux panes use login shells)
echo '[ -f ~/.bashrc ] && . ~/.bashrc' > /home/claude/.profile
chown claude:claude /home/claude/.profile

# Recreate expected binary paths (originals wiped by tmpfs mount)
ln -sf /usr/local/bin/claude /home/claude/.local/bin/claude
ln -sf /usr/local/bin/bun /home/claude/.bun/bin/bun
ln -sf /usr/local/bin/bunx /home/claude/.bun/bin/bunx

# === 2. Network lockdown ===

# OTEL Phase 1: Extract Grafana Cloud hostname for network allowlisting
# (Phase 2 later writes OTEL env vars to /tmp/otel/otel-env after network setup is complete)
if [[ -n "${GRAFANA_INSTANCE_ID:-}" ]] && [[ -n "${GRAFANA_API_TOKEN:-}" ]] && [[ -n "${GRAFANA_OTLP_ENDPOINT:-}" ]]; then
  GRAFANA_HOST=$(echo "$GRAFANA_OTLP_ENDPOINT" | sed 's|https\?://||' | cut -d/ -f1 | cut -d: -f1)
  # Validate hostname: alphanumeric, hyphens, dots only (prevent Corefile injection)
  if [[ ! "$GRAFANA_HOST" =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$ ]]; then
    echo "[ENTRYPOINT] ERROR: Invalid hostname in GRAFANA_OTLP_ENDPOINT: $GRAFANA_HOST" >&2
    unset GRAFANA_HOST
  else
    echo "[ENTRYPOINT] OTEL: will allow outbound to $GRAFANA_HOST"
    # Write to /tmp/otel/ (root:root, mode 700) — isolates from world-writable /tmp
    mkdir -p /tmp/otel && chmod 700 /tmp/otel
    echo "$GRAFANA_HOST" > /tmp/otel/extra-domains.conf
  fi
fi

# Generate CoreDNS config from domains.conf
COREFILE="/tmp/Corefile"
cp /opt/network/Corefile.template "$COREFILE"

while IFS= read -r domain || [[ -n "$domain" ]]; do
  [[ "$domain" =~ ^[[:space:]]*# ]] && continue
  [[ -z "$domain" ]] && continue
  domain=$(echo "$domain" | tr -d '[:space:]')
  cat >> "$COREFILE" <<EOF

${domain} {
    bind 127.0.0.53
    template IN AAAA {
        rcode NOERROR
    }
    forward . 8.8.8.8 1.1.1.1
    log
    cache 300
}
EOF
done < /opt/network/domains.conf

# Append Grafana Cloud OTLP gateway domain (if OTEL is enabled)
if [[ -n "${GRAFANA_HOST:-}" ]]; then
  cat >> "$COREFILE" <<EOF

${GRAFANA_HOST} {
    bind 127.0.0.53
    template IN AAAA {
        rcode NOERROR
    }
    forward . 8.8.8.8 1.1.1.1
    log
    cache 300
}
EOF
fi

# Start CoreDNS with auto-restart
(while true; do
  /usr/local/bin/coredns -conf "$COREFILE" >/tmp/coredns.log 2>&1
  echo "[ENTRYPOINT] CoreDNS exited ($?), restarting in 2s..." >&2
  sleep 2
done) &
sleep 1

# Point resolver to local CoreDNS
echo "nameserver 127.0.0.53" > /etc/resolv.conf

# Apply iptables rules
/opt/network/refresh-iptables.sh

# Start periodic iptables refresh (every 5 min)
(while true; do sleep 300; /opt/network/refresh-iptables.sh; done) &

# === 3. Git + GitHub configuration ===

git config --system user.name "${GIT_USER_NAME:-claudetainer}"
git config --system user.email "${GIT_USER_EMAIL:-claudetainer@noreply.github.com}"

# Force HTTPS for all GitHub URLs (container has no SSH client)
git config --system url."https://github.com/".insteadOf "git@github.com:"

# Configure git credential helper at system level so claude user can use it.
# Uses the wrapper at /usr/local/bin/gh which handles GH_TOKEN fallback.
git config --system credential.https://github.com.helper '!/usr/local/bin/gh auth git-credential'

# Write GH_PAT to a dedicated token file for the gh-wrapper fallback.
# Mode 600 root:root — the claude user cannot read this directly.
# The gh-wrapper reads it via a targeted sudoers entry when GH_TOKEN is not in the environment.
mkdir -p /opt/gh-config
( umask 077 && printf '%s\n' "$GH_PAT" > /opt/gh-config/.ghtoken )
chown root:root /opt/gh-config/.ghtoken
chmod 600 /opt/gh-config/.ghtoken
chmod 711 /opt/gh-config

# Sudoers: allow claude to read the token file via the gh-wrapper's fallback mechanism.
# This is the ONLY sudo privilege granted to the claude user.
# The command approval system's Tier 1 block on \bsudo\b prevents direct invocation.
echo 'claude ALL=(root) NOPASSWD: /usr/bin/cat /opt/gh-config/.ghtoken' > /etc/sudoers.d/gh-token
chmod 440 /etc/sudoers.d/gh-token
chown root:root /etc/sudoers.d/gh-token

# Validate sudoers drop-in to avoid breaking sudo inside the container.
if ! visudo -c -f /etc/sudoers.d/gh-token; then
  echo "[ENTRYPOINT] ERROR: Invalid sudoers drop-in at /etc/sudoers.d/gh-token; aborting to avoid breaking sudo." >&2
  exit 1
fi

# Configure npm/bun auth for GitHub Packages
# Uses env var substitution — npm/bun expand ${VAR} at runtime from the process environment.
# The file contains only the variable reference, not the plaintext token.
cat > /home/claude/.npmrc <<'NPMRC'
//npm.pkg.github.com/:_authToken=${CLAUDETAINER_NPM_TOKEN}
NPMRC
chown root:root /home/claude/.npmrc
chmod 644 /home/claude/.npmrc

# OTEL Phase 2: Write telemetry config for start-claude.sh (network is now configured)
# Env vars are NOT exported into PID 1 — they are only written to the file and
# forwarded to the claude user's process by start-claude.sh via sudo.
if [[ -n "${GRAFANA_HOST:-}" ]]; then
  mkdir -p /tmp/otel && chmod 700 /tmp/otel
  # Build OTEL_RESOURCE_ATTRIBUTES: auto-inject Fly identity, then append operator attrs
  OTEL_ATTRS=""
  [[ -n "${FLY_APP_NAME:-}" ]] && OTEL_ATTRS="fly.app_name=${FLY_APP_NAME}"
  if [[ -n "${FLY_MACHINE_ID:-}" ]]; then
    [[ -n "$OTEL_ATTRS" ]] && OTEL_ATTRS="${OTEL_ATTRS},"
    OTEL_ATTRS="${OTEL_ATTRS}fly.machine_id=${FLY_MACHINE_ID}"
  fi
  if [[ -n "${OTEL_RESOURCE_ATTRIBUTES:-}" ]]; then
    [[ -n "$OTEL_ATTRS" ]] && OTEL_ATTRS="${OTEL_ATTRS},"
    OTEL_ATTRS="${OTEL_ATTRS}${OTEL_RESOURCE_ATTRIBUTES}"
  fi
  (umask 077; cat > /tmp/otel/otel-env <<OTELENV
CLAUDE_CODE_ENABLE_TELEMETRY=1
OTEL_METRICS_EXPORTER=otlp
OTEL_LOGS_EXPORTER=otlp
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_ENDPOINT=$GRAFANA_OTLP_ENDPOINT
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic $(echo -n "${GRAFANA_INSTANCE_ID}:${GRAFANA_API_TOKEN}" | base64 -w 0)
OTEL_LOG_USER_PROMPTS=${OTEL_LOG_USER_PROMPTS:-1}
OTEL_LOG_TOOL_DETAILS=${OTEL_LOG_TOOL_DETAILS:-1}
OTELENV
  )
  # Append resource attributes as a separate line (only if non-empty)
  if [[ -n "$OTEL_ATTRS" ]]; then
    echo "OTEL_RESOURCE_ATTRIBUTES=${OTEL_ATTRS}" >> /tmp/otel/otel-env
  fi
  echo "[ENTRYPOINT] OTEL telemetry enabled → host=${GRAFANA_HOST}"
fi

# === 4. Claude Code setup ===

# Copy settings template — claude can delete and recreate this file
# (accepted risk: iptables is the real enforcement, hooks are defense-in-depth)
cp /opt/claude/settings.json /home/claude/.claude/settings.json
chown claude:claude /home/claude/.claude/settings.json

# Write Claude Code state (onboarding skip + project trust written after clone below)
echo '{"hasCompletedOnboarding": true}' > /home/claude/.claude.json
chown claude:claude /home/claude/.claude.json

# === 5. Lock filesystem ===
# After all setup, remount root as read-only
mount -o remount,ro /
echo "[ENTRYPOINT] Root filesystem locked (read-only)"

# === 6. Clone repo (optional) ===
if [[ -n "${REPO_URL:-}" ]]; then
  echo "[ENTRYPOINT] Cloning $REPO_URL..."
  git clone "$REPO_URL" /workspace/repo || \
    echo "[ENTRYPOINT] WARNING: Failed to clone $REPO_URL" >&2
fi

# If cloned repo is a fork, add upstream remote pointing to parent.
# This ensures the snapshot captures both origin and upstream URLs,
# enabling the contextual exemption for commands targeting either repo.
if [[ -d /workspace/repo/.git ]]; then
  (
    set +e
    # Extract origin NWO from remote URL
    origin_url=$(git -C /workspace/repo remote get-url origin 2>/dev/null)
    repo_nwo=$(echo "$origin_url" | sed -E 's#(\.git)?$##; s#.*/([^/]+/[^/]+)$#\1#')
    if [[ -n "$repo_nwo" ]]; then
      # Query GitHub API for fork parent (timeout prevents boot hang)
      parent_nwo=$(timeout 10 gh repo view "$repo_nwo" --json isFork,parent \
        --jq 'select(.isFork) | .parent.owner.login + "/" + .parent.name' \
        2>/dev/null)
      if [[ -n "$parent_nwo" ]]; then
        upstream_url="https://github.com/${parent_nwo}.git"
        # Validate URL matches strict GitHub HTTPS pattern
        if [[ "$upstream_url" =~ ^https://github\.com/[a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+\.git$ ]]; then
          git -C /workspace/repo remote add upstream "$upstream_url" 2>/dev/null
          echo "[ENTRYPOINT] Fork detected — added upstream remote: ${parent_nwo}"
        else
          echo "[ENTRYPOINT] WARNING: Invalid upstream URL format, skipping: ${upstream_url}" >&2
        fi
      fi
    fi
  ) || true
fi

# Snapshot git remote URLs for the approval pipeline's contextual exemption.
# Runs as root while the repo is still root-owned (before chown to claude),
# avoiding git's safe.directory check. The snapshot is stored in a root-owned
# directory that claude cannot modify, eliminating runtime remote injection
# via .git/config edits, ~/.gitconfig, GIT_CONFIG_* env vars, or include
# directives. URLs are sanitized to strip any embedded credentials (userinfo)
# before writing, since the snapshot file is world-readable (mode 444).
if [[ -d /workspace/repo/.git ]]; then
  (
    # Fail-open: snapshot errors must not abort the entrypoint. The approval
    # layer handles a missing snapshot gracefully (contextual exemption simply
    # won't activate, falling through to Haiku classification).
    set +e
    mkdir -p /tmp/approval
    tmp_snapshot="/tmp/approval/git-remote-urls.txt.$$"
    git -C /workspace/repo remote | while read -r name; do
      git -C /workspace/repo remote get-url "$name" 2>/dev/null
    done | sed -E 's#(https?://)[^/@]*@#\1#g' > "$tmp_snapshot"
    if [[ $? -ne 0 ]]; then
      rm -f "$tmp_snapshot" /tmp/approval/git-remote-urls.txt
      echo "[ENTRYPOINT] WARNING: Failed to snapshot git remotes; continuing without snapshot" >&2
    else
      mv -f "$tmp_snapshot" /tmp/approval/git-remote-urls.txt
      chmod 444 /tmp/approval/git-remote-urls.txt
      chmod 555 /tmp/approval
      echo "[ENTRYPOINT] Git remote snapshot created at /tmp/approval/git-remote-urls.txt"
    fi
  ) || true
fi

# Give repo ownership to claude
if [[ -d /workspace/repo ]]; then
  chown -R claude:claude /workspace/repo
fi

# Pre-accept project trust for the workspace directory
WORK_DIR="/workspace"
[[ -d /workspace/repo ]] && WORK_DIR="/workspace/repo"
cat > /home/claude/.claude.json <<EOF
{
  "hasCompletedOnboarding": true,
  "projects": {
    "$WORK_DIR": {
      "hasTrustDialogAccepted": true,
      "allowedTools": []
    }
  }
}
EOF
chown claude:claude /home/claude/.claude.json

# === 7. Readiness verification ===
READY=true

# CoreDNS must be running
if ! pidof coredns >/dev/null 2>&1; then
  echo "[ENTRYPOINT] WARN: CoreDNS is not running" >&2
  READY=false
fi

# iptables must have rules loaded (more than just the base header)
RULE_COUNT=$(iptables -L OUTPUT -n 2>/dev/null | grep -c ACCEPT || echo 0)
if [[ "$RULE_COUNT" -lt 5 ]]; then
  echo "[ENTRYPOINT] WARN: iptables has only $RULE_COUNT ACCEPT rules" >&2
  READY=false
fi

# Settings must be present
if [[ ! -f /home/claude/.claude/settings.json ]]; then
  echo "[ENTRYPOINT] WARN: settings.json not found" >&2
  READY=false
fi

# Repo must be cloned (if REPO_URL was set)
if [[ -n "${REPO_URL:-}" ]] && [[ ! -d /workspace/repo/.git ]]; then
  echo "[ENTRYPOINT] WARN: repo clone missing at /workspace/repo" >&2
  READY=false
fi

if [[ "$READY" == "true" ]]; then
  touch /tmp/claudetainer-ready
  echo "[ENTRYPOINT] Ready. All checks passed."
else
  echo "[ENTRYPOINT] WARN: Some checks failed, starting anyway."
  touch /tmp/claudetainer-ready
fi

# Start Claude Code initialization in background (synchronized via flock)
echo "[ENTRYPOINT] Starting Claude Code initialization..."
/usr/local/bin/start-claude &

echo "[ENTRYPOINT] Run 'fly ssh console -a <app>' to connect."

# Keep the container alive — bash stays as PID 1 to reap zombie children
# (CoreDNS restart loop, iptables refresh loop, and start-claude are background subshells)
wait
