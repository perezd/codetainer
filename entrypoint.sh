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
mount -t tmpfs -o size=256m tmpfs /home/claude
chmod 1777 /tmp

# Set ownership and create subdirectories
chown claude:claude /workspace /home/claude
mkdir -p /home/claude/.cache /home/claude/.claude /home/claude/.local/bin /home/claude/.bun/bin
chown -R claude:claude /home/claude/.cache /home/claude/.claude /home/claude/.local /home/claude/.bun

# Shell prompt: path relative to repo root + git branch
cat > /home/claude/.bashrc <<'BASHRC'
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

# Start periodic iptables refresh (every 30 min)
(while true; do sleep 1800; /opt/network/refresh-iptables.sh; done) &

# === 3. Git + GitHub configuration ===

git config --system user.name "${GIT_USER_NAME:-claudetainer}"
git config --system user.email "${GIT_USER_EMAIL:-claudetainer@noreply.github.com}"

# Force HTTPS for all GitHub URLs (container has no SSH client)
git config --system url."https://github.com/".insteadOf "git@github.com:"

# Authenticate gh CLI with the PAT
echo "$GH_PAT" | gh auth login --with-token --hostname github.com 2>/dev/null || true

# Configure git credential helper at system level so claude user can use it
# gh auth setup-git only writes to ~/.gitconfig (root), so we set it explicitly
# GH_CONFIG_DIR is hardcoded in the command so it works regardless of environment inheritance
git config --system credential.https://github.com.helper '!GH_CONFIG_DIR=/opt/gh-config /usr/bin/gh auth git-credential'

# Copy gh config to a shared location readable by claude user
mkdir -p /opt/gh-config
if [[ -d /root/.config/gh ]]; then
  cp -r /root/.config/gh/* /opt/gh-config/ 2>/dev/null || true
fi
chmod 711 /opt/gh-config
chmod 644 /opt/gh-config/* 2>/dev/null || true

# Configure npm/bun auth for GitHub Packages
cat > /home/claude/.npmrc <<NPMRC
//npm.pkg.github.com/:_authToken=${GH_PAT}
NPMRC
chown root:root /home/claude/.npmrc
chmod 644 /home/claude/.npmrc

# === 4. Approval setup ===
# Must be on tmpfs so it's writable after root FS is remounted read-only
mount -t tmpfs -o size=1m tmpfs /run
mkdir -p /run/claude-approved
chmod 1777 /run/claude-approved

# === 5. Claude Code setup ===

# Copy settings template — claude can delete and recreate this file
# (accepted risk: iptables is the real enforcement, hooks are defense-in-depth)
cp /opt/claude/settings.json /home/claude/.claude/settings.json
chown claude:claude /home/claude/.claude/settings.json

# Write Claude Code state (onboarding skip + project trust written after clone below)
echo '{"hasCompletedOnboarding": true}' > /home/claude/.claude.json
chown claude:claude /home/claude/.claude.json

# === 6. Lock filesystem ===
# After all setup, remount root as read-only
mount -o remount,ro /
echo "[ENTRYPOINT] Root filesystem locked (read-only)"

# === 7. Clone repo (optional) ===
if [[ -n "${REPO_URL:-}" ]]; then
  echo "[ENTRYPOINT] Cloning $REPO_URL..."
  # Clone as root (has access to git credentials), then give full ownership to claude
  git clone "$REPO_URL" /workspace/repo && \
    chown -R claude:claude /workspace/repo || \
    echo "[ENTRYPOINT] WARNING: Failed to clone $REPO_URL" >&2
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

echo "[ENTRYPOINT] Ready. Waiting for SSH connections..."
echo "[ENTRYPOINT] Run 'fly ssh console -a <app>' to connect."

# Keep the container alive — bash stays as PID 1 to reap zombie children
# (CoreDNS restart loop and iptables refresh loop are background subshells)
wait
