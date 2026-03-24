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
    template IN AAAA {
        rcode NOERROR
    }
    forward . 8.8.8.8 1.1.1.1
    log
    cache 300
}
EOF
done < /opt/network/domains.conf

# Start CoreDNS
/usr/local/bin/coredns -conf "$COREFILE" &
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

# Authenticate gh CLI with the PAT, then use gh as the git credential helper
echo "$GH_PAT" | gh auth login --with-token --hostname github.com 2>/dev/null || true
gh auth setup-git --hostname github.com 2>/dev/null || true

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
mkdir -p /run/claude-approved

# === 5. Claude Code setup ===

# Copy settings template into claude-owned .claude directory
# Claude Code needs to write state files here (preferences, sessions, etc.)
# settings.json is root-owned so hook config can't be modified, but claude
# can delete and recreate it (accepted risk — iptables is the real enforcement)
cp /opt/claude/settings.json /home/claude/.claude/settings.json
chown root:root /home/claude/.claude/settings.json
chmod 644 /home/claude/.claude/settings.json

# Skip onboarding wizard (required for headless auth via CLAUDE_CODE_OAUTH_TOKEN)
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

echo "[ENTRYPOINT] Ready. Waiting for SSH connections..."
echo "[ENTRYPOINT] Run 'fly ssh console -a <app>' to connect."

# Keep the container alive — SSH users get start-claude via .bashrc
exec sleep infinity
