# Claudetainer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Docker-based interactive Claude Code environment deployed to Fly.io with three security layers: container hardening (read-only FS, non-root, seccomp), network boundary (iptables + CoreDNS), and command approval hook.

**Architecture:** Read-only root filesystem makes enforcement tamper-proof. iptables + CoreDNS enforce network boundaries at both IP and DNS levels. A PreToolUse hook gates commands via configurable regex patterns with a one-shot approval flow. Claude Code authenticates via interactive OAuth. GitHub PAT stored in root-owned files. No sidecar, no Go code — just bash scripts and standard Linux primitives.

**Tech Stack:** Docker (debian:bookworm-slim), Bash (entrypoint, hook, approval tools), CoreDNS, iptables/ip6tables, socat, jq, tmux, GitHub Actions, Fly.io

**Spec:** `docs/superpowers/specs/2026-03-20-claudetainer-design.md`

---

## File Structure

```
claudetainer/
├── Dockerfile
├── fly.toml
├── .github/workflows/build.yml
├── entrypoint.sh
├── approval/
│   ├── check-command.sh
│   ├── handle-approval.sh
│   ├── rules.conf
│   ├── approve
│   └── approval-daemon
├── network/
│   ├── domains.conf
│   ├── Corefile.template
│   └── refresh-iptables.sh
├── status
└── claude-settings.json
```

---

### Task 1: Network Configuration Files

**Files:**
- Create: `network/domains.conf`
- Create: `network/Corefile.template`
- Create: `network/refresh-iptables.sh`

- [ ] **Step 1: Create `network/domains.conf`**

```
# Infrastructure (Claude Code OAuth + API)
api.anthropic.com
statsig.anthropic.com
console.anthropic.com

# GitHub
github.com
api.github.com
api.githubcopilot.com
objects.githubusercontent.com

# Package registries
registry.npmjs.org
pypi.org
files.pythonhosted.org
deb.debian.org

# Bun
bun.sh
bun.com

# GitHub Packages npm registry
npm.pkg.github.com
```

- [ ] **Step 2: Create `network/Corefile.template`**

This is the base CoreDNS config. The entrypoint appends per-domain forward blocks from `domains.conf`.

```
# Default: return NXDOMAIN for all queries
# Per-domain forward blocks are appended by the entrypoint
. {
    log
    errors
    template IN A . {
        rcode NXDOMAIN
    }
    template IN AAAA . {
        rcode NXDOMAIN
    }
}
```

- [ ] **Step 3: Create `network/refresh-iptables.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

DOMAINS_FILE="/opt/network/domains.conf"
RULES_FILE=$(mktemp)

cat > "$RULES_FILE" <<'HEADER'
*filter
:INPUT ACCEPT [0:0]
:FORWARD ACCEPT [0:0]
:OUTPUT DROP [0:0]
-A OUTPUT -o lo -j ACCEPT
-A OUTPUT -d 169.254.0.0/16 -j DROP
-A OUTPUT -d 172.16.0.0/12 -j DROP
-A OUTPUT -p udp -d 127.0.0.53 --dport 53 -j ACCEPT
-A OUTPUT -p tcp -d 127.0.0.53 --dport 53 -j ACCEPT
-A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
HEADER

while IFS= read -r domain || [[ -n "$domain" ]]; do
  [[ "$domain" =~ ^[[:space:]]*# ]] && continue
  [[ -z "$domain" ]] && continue
  domain=$(echo "$domain" | tr -d '[:space:]')

  ips=$(dig +short "$domain" 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' || true)
  for ip in $ips; do
    echo "-A OUTPUT -d $ip -j ACCEPT" >> "$RULES_FILE"
  done
done < "$DOMAINS_FILE"

echo "-A OUTPUT -p udp -j DROP" >> "$RULES_FILE"
echo '-A OUTPUT -j LOG --log-prefix "CLAUDETAINER_DROP: " --log-level 4 -m limit --limit 5/min' >> "$RULES_FILE"
echo "COMMIT" >> "$RULES_FILE"

iptables-restore < "$RULES_FILE"

ip6tables -P OUTPUT DROP 2>/dev/null || true
ip6tables -F OUTPUT 2>/dev/null || true
ip6tables -A OUTPUT -o lo -j ACCEPT 2>/dev/null || true
ip6tables -A OUTPUT -d fdaa::/16 -j DROP 2>/dev/null || true

rm -f "$RULES_FILE"
echo "[NETWORK] iptables refreshed at $(date)" >&2
```

- [ ] **Step 4: Make executable and commit**

```bash
chmod +x network/refresh-iptables.sh
git add network/
git commit -m "feat: add network config — domains, CoreDNS template, iptables refresh"
```

---

### Task 2: Approval System

**Files:**
- Create: `approval/rules.conf`
- Create: `approval/check-command.sh`
- Create: `approval/approval-daemon`
- Create: `approval/handle-approval.sh`
- Create: `approval/approve`

- [ ] **Step 1: Create `approval/rules.conf`**

Copy the rules verbatim from spec lines 176-233.

- [ ] **Step 2: Create `approval/check-command.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

RULES_FILE="/opt/approval/rules.conf"
APPROVED_DIR="/run/claude-approved"

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""')

if [[ "$TOOL_NAME" != "Bash" ]]; then
  exit 0
fi

COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""')
[[ -z "$COMMAND" ]] && exit 0

echo "[HOOK] Evaluating: $COMMAND" >&2

evaluate_command() {
  local cmd="$1"
  cmd=$(echo "$cmd" | sed 's/^[[:space:]]*//')
  [[ -z "$cmd" ]] && return 0

  local hash
  hash=$(echo -n "$cmd" | sha256sum | cut -d' ' -f1)
  if [[ -f "$APPROVED_DIR/$hash" ]]; then
    rm -f "$APPROVED_DIR/$hash" 2>/dev/null || true
    echo "[HOOK] APPROVED (token): $cmd" >&2
    return 0
  fi

  local default_action="block"

  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ -z "$line" ]] && continue

    local type="${line%%:*}"
    local pattern="${line#*:}"

    case "$type" in
      allow)
        if echo "$cmd" | grep -qE "$pattern"; then
          echo "[HOOK] ALLOW ($pattern): $cmd" >&2
          return 0
        fi
        ;;
      block)
        if echo "$cmd" | grep -qE "$pattern"; then
          echo "[HOOK] BLOCK ($pattern): $cmd" >&2
          echo "⛔ Blocked: $cmd" >&2
          return 2
        fi
        ;;
      approve)
        if echo "$cmd" | grep -qE "$pattern"; then
          echo "[HOOK] APPROVAL REQUIRED ($pattern): $cmd" >&2
          echo "⛔ Approval required — run: ! approve '$cmd'" >&2
          return 2
        fi
        ;;
      default)
        default_action="$pattern"
        ;;
    esac
  done < "$RULES_FILE"

  if [[ "$default_action" == "allow" ]]; then
    echo "[HOOK] DEFAULT ALLOW: $cmd" >&2
    return 0
  else
    echo "[HOOK] DEFAULT BLOCK: $cmd" >&2
    echo "⛔ Blocked (no matching rule): $cmd" >&2
    return 2
  fi
}

split_and_evaluate() {
  local full_cmd="$1"

  # Check for $() and backtick subshells — extract and evaluate inner commands
  local inner
  inner=$(echo "$full_cmd" | grep -oP '\$\(\K[^)]+' || true)
  if [[ -n "$inner" ]]; then
    while IFS= read -r subcmd; do
      evaluate_command "$subcmd" || return $?
    done <<< "$inner"
  fi
  inner=$(echo "$full_cmd" | grep -oP '`\K[^`]+' || true)
  if [[ -n "$inner" ]]; then
    while IFS= read -r subcmd; do
      evaluate_command "$subcmd" || return $?
    done <<< "$inner"
  fi

  # Split on ; && || and evaluate each sub-command
  local subcmds
  subcmds=$(echo "$full_cmd" | sed 's/\s*&&\s*/\x00/g; s/\s*||\s*/\x00/g; s/\s*;\s*/\x00/g')

  while IFS= read -r -d $'\0' subcmd || [[ -n "$subcmd" ]]; do
    # Strip any remaining $() or backtick wrappers from the subcmd itself
    subcmd=$(echo "$subcmd" | sed 's/\$([^)]*)//g; s/`[^`]*`//g; s/^[[:space:]]*//')
    [[ -z "$subcmd" ]] && continue
    evaluate_command "$subcmd" || return $?
  done <<< "$subcmds"

  return 0
}

split_and_evaluate "$COMMAND"
exit $?
```

- [ ] **Step 3: Create `approval/approval-daemon`**

```bash
#!/usr/bin/env bash
set -euo pipefail

SOCKET="/run/claude-approval.sock"
APPROVED_DIR="/run/claude-approved"

cleanup() { rm -f "$SOCKET"; }
trap cleanup EXIT

mkdir -p "$APPROVED_DIR"
chmod 733 "$APPROVED_DIR"
rm -f "$SOCKET"

echo "[APPROVAL-DAEMON] Listening on $SOCKET" >&2

while true; do
  socat -u UNIX-LISTEN:"$SOCKET",fork,mode=0600 \
    EXEC:"/opt/approval/handle-approval.sh" 2>/dev/null || true
done
```

- [ ] **Step 4: Create `approval/handle-approval.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

APPROVED_DIR="/run/claude-approved"

read -r CMD
if [[ -z "$CMD" ]]; then
  echo "ERROR: empty command" >&2
  exit 1
fi

HASH=$(echo -n "$CMD" | sha256sum | cut -d' ' -f1)
echo "$CMD" > "$APPROVED_DIR/$HASH"
chmod 666 "$APPROVED_DIR/$HASH"
echo "[APPROVAL-DAEMON] Token written for: $CMD (hash: ${HASH:0:12}...)" >&2
echo "OK"
```

- [ ] **Step 5: Create `approval/approve`**

```bash
#!/usr/bin/env bash
set -euo pipefail

SOCKET="/run/claude-approval.sock"

if [[ "$(id -u)" != "0" ]]; then
  echo "⛔ approve must be run as root (use ! approve from Claude Code)" >&2
  exit 1
fi

if [[ $# -eq 0 ]]; then
  echo "Usage: approve '<command>'" >&2
  echo "Example: approve 'bun add react'" >&2
  exit 1
fi

CMD="$*"
RESPONSE=$(echo "$CMD" | socat - UNIX-CONNECT:"$SOCKET" 2>/dev/null)

if [[ "$RESPONSE" == "OK" ]]; then
  echo "✅ Approved: $CMD"
else
  echo "❌ Failed to approve: $CMD" >&2
  exit 1
fi
```

- [ ] **Step 6: Make all executable and commit**

```bash
chmod +x approval/check-command.sh approval/approval-daemon approval/handle-approval.sh approval/approve
git add approval/
git commit -m "feat: add approval system — hook, daemon, CLI, rules"
```

---

### Task 3: Claude Code Settings

**Files:**
- Create: `claude-settings.json`

- [ ] **Step 1: Create `claude-settings.json`**

```json
{
  "includeCoAuthoredBy": false,
  "mcpServers": {
    "bun-docs": {
      "type": "http",
      "url": "https://bun.com/docs/mcp"
    }
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "/opt/approval/check-command.sh",
            "timeout": 300
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add claude-settings.json
git commit -m "feat: add Claude settings template with hook and MCP config"
```

---

### Task 4: Status Tool

**Files:**
- Create: `status`

- [ ] **Step 1: Create `status`**

```bash
#!/usr/bin/env bash
set -euo pipefail

echo "=== Claudetainer Status ==="
echo ""

echo "--- Active Approval Tokens ---"
if [[ -d /run/claude-approved ]]; then
  count=$(find /run/claude-approved -maxdepth 1 -type f 2>/dev/null | wc -l)
  echo "  Tokens: $count"
  for f in /run/claude-approved/*; do
    [[ -f "$f" ]] && echo "  - $(cat "$f" 2>/dev/null || echo '(unreadable)')"
  done
else
  echo "  (no token directory)"
fi
echo ""

echo "--- Recent iptables Drops ---"
dmesg 2>/dev/null | grep "CLAUDETAINER_DROP" | tail -5 || echo "  (none)"
echo ""

echo "--- Approval Daemon ---"
if [[ -S /run/claude-approval.sock ]]; then
  echo "  Socket: active"
else
  echo "  Socket: MISSING"
fi
echo ""

echo "--- CoreDNS ---"
if pgrep -x coredns >/dev/null 2>&1; then
  echo "  Process: running"
else
  echo "  Process: NOT RUNNING"
fi
```

- [ ] **Step 2: Make executable and commit**

```bash
chmod +x status
git add status
git commit -m "feat: add status CLI tool"
```

---

### Task 5: Entrypoint Script

**Files:**
- Create: `entrypoint.sh`

- [ ] **Step 1: Create `entrypoint.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

echo "[ENTRYPOINT] Starting claudetainer..."

# === 1. Filesystem hardening ===
# Mount tmpfs at writable paths before anything else
mount -t tmpfs -o size=512m tmpfs /workspace
mount -t tmpfs -o size=128m tmpfs /tmp
mount -t tmpfs -o size=256m tmpfs /home/claude/.cache
mount -t tmpfs -o size=64m tmpfs /home/claude/.claude
chmod 1777 /tmp

# Set ownership (except .claude which stays root-owned)
chown claude:claude /workspace /home/claude/.cache

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

# === 3. Git configuration ===

echo "https://${GH_PAT}@github.com" > /root/.git-credentials
chmod 600 /root/.git-credentials
git config --system credential.helper 'store --file=/root/.git-credentials'
git config --system user.name "${GIT_USER_NAME:-claudetainer}"
git config --system user.email "${GIT_USER_EMAIL:-claudetainer@noreply.github.com}"

# Configure gh CLI auth
mkdir -p /opt/gh-config
echo "$GH_PAT" | gh auth login --with-token --hostname github.com 2>/dev/null || true
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

# === 4. Approval daemon ===

(while true; do
  /opt/approval/approval-daemon 2>&1
  echo "[ENTRYPOINT] Approval daemon exited, restarting in 1s..." >&2
  sleep 1
done) &

# === 5. Claude Code setup ===

# Copy settings template (root-owned, mode 644 — Claude can read but not modify)
cp /opt/claude/settings.json /home/claude/.claude/settings.json
chown root:root /home/claude/.claude/settings.json
chmod 644 /home/claude/.claude/settings.json

# Install superpowers plugin
su -s /bin/bash claude -c 'claude plugin install superpowers@claude-plugins-official 2>/dev/null' || \
  echo "[ENTRYPOINT] WARNING: Failed to install superpowers plugin" >&2

# === 6. Lock filesystem ===
# After all setup, remount root as read-only
mount -o remount,ro /
echo "[ENTRYPOINT] Root filesystem locked (read-only)"

# === 7. Clone repo (optional) ===
WORK_DIR="/workspace"
if [[ -n "${REPO_URL:-}" ]]; then
  echo "[ENTRYPOINT] Cloning $REPO_URL..."
  su -s /bin/bash claude -c "git clone '$REPO_URL' /workspace/repo" || \
    echo "[ENTRYPOINT] WARNING: Failed to clone $REPO_URL" >&2
  if [[ -d /workspace/repo ]]; then
    WORK_DIR="/workspace/repo"
  fi
fi

# === 8. Session startup ===

# tmux config (already on tmpfs at /tmp)
cat > /tmp/.tmux.conf <<'TMUX'
set -g remain-on-exit on
set -g history-limit 50000
TMUX

# Start Claude Code in tmux as the claude user
su -s /bin/bash claude -c "
  export GH_CONFIG_DIR=/opt/gh-config
  export HOME=/home/claude
  cd '$WORK_DIR'
  tmux -f /tmp/.tmux.conf new-session -d -s claude 'claude --dangerously-skip-permissions'
"

echo "[ENTRYPOINT] Claude Code session started. Waiting for SSH connections..."

# Keep the container alive — the entrypoint is PID 1
# SSH users auto-attach to tmux via .bashrc
exec sleep infinity
```

- [ ] **Step 2: Make executable and commit**

```bash
chmod +x entrypoint.sh
git add entrypoint.sh
git commit -m "feat: add entrypoint — network lockdown, git config, approval daemon, tmux"
```

---

### Task 6: Dockerfile

**Files:**
- Create: `Dockerfile`

- [ ] **Step 1: Create the Dockerfile**

```dockerfile
FROM debian:bookworm-slim

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates curl dnsutils fd-find git iptables ip6tables \
    jq less python3 ripgrep socat tmux tree wget xxd \
    && rm -rf /var/lib/apt/lists/*

# Bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

# Claude Code
RUN curl -fsSL https://claude.ai/install.sh | bash

# gh CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# CoreDNS
RUN ARCH=$(dpkg --print-architecture) && \
    curl -fsSL "https://github.com/coredns/coredns/releases/download/v1.12.1/coredns_1.12.1_linux_${ARCH}.tgz" \
    | tar -xz -C /usr/local/bin/ \
    && chmod +x /usr/local/bin/coredns

# Create claude user
RUN useradd -m -s /bin/bash -u 1000 claude

# Auto-attach to tmux on SSH login
RUN echo 'if [ -n "$SSH_CONNECTION" ] && tmux has-session -t claude 2>/dev/null; then exec tmux attach -t claude; fi' \
    >> /root/.bashrc

# Approval system
COPY approval/ /opt/approval/
RUN chmod +x /opt/approval/*.sh /opt/approval/approve /opt/approval/approval-daemon
RUN cp /opt/approval/approve /usr/local/bin/approve

# Network config
COPY network/ /opt/network/
RUN chmod +x /opt/network/refresh-iptables.sh

# Claude settings template
COPY claude-settings.json /opt/claude/settings.json

# Status tool
COPY status /usr/local/bin/status
RUN chmod +x /usr/local/bin/status

# Entrypoint
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Writable mount targets
RUN mkdir -p /workspace /home/claude/.cache /home/claude/.claude

WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
```

- [ ] **Step 2: Commit**

```bash
git add Dockerfile
git commit -m "feat: add Dockerfile with all security layers"
```

---

### Task 7: Fly.io Config & GitHub Actions

**Files:**
- Create: `fly.toml`
- Create: `.github/workflows/build.yml`

- [ ] **Step 1: Create `fly.toml`**

```toml
app = "claudetainer"
primary_region = "sjc"

[build]
  dockerfile = "Dockerfile"

[vm]
  size = "shared-cpu-1x"
  memory = 1024

# No [services] block — no ports exposed to the internet.
# Access only via: fly ssh console
```

- [ ] **Step 2: Create `.github/workflows/build.yml`**

```yaml
name: Build and Push

on:
  push:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write

    steps:
      - uses: actions/checkout@v4

      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: ghcr.io/${{ github.repository }}:latest
```

- [ ] **Step 3: Commit**

```bash
git add fly.toml .github/workflows/build.yml
git commit -m "feat: add fly.toml and GitHub Actions build workflow"
```

---

### Task 8: First Deploy & Verification

All testing happens on Fly.io directly — the container uses iptables, CoreDNS, tmpfs mounts, and read-only root FS remount which require a full VM environment.

- [ ] **Step 1: Create the Fly app**

```bash
fly apps create claudetainer
```

- [ ] **Step 2: Set secrets**

```bash
fly secrets set GH_PAT=<your-fine-grained-pat>
```

- [ ] **Step 3: Deploy**

```bash
fly deploy \
  --env GIT_USER_NAME=claudetainer-bot \
  --env GIT_USER_EMAIL=claudetainer@noreply.github.com
```

Optionally, to auto-clone a repo on start:

```bash
fly deploy \
  --env GIT_USER_NAME=claudetainer-bot \
  --env GIT_USER_EMAIL=claudetainer@noreply.github.com \
  --env REPO_URL=https://github.com/your-org/your-repo
```

- [ ] **Step 4: Connect and verify**

```bash
fly ssh console
# Should auto-attach to tmux with Claude Code running
```

Verify:
- Complete OAuth login when prompted by Claude Code
- `! status` — CoreDNS running, approval daemon socket active
- Ask Claude to `bun add react` — should require approval
- `! approve 'bun add react'` — should approve and succeed
- Verify root FS is read-only: `touch /test` should fail with "Read-only file system"
- Verify iptables: `iptables -L -n` shows OUTPUT DROP default with allowlist
- Verify Claude can't modify hook: `cat /opt/approval/rules.conf` works but write fails

- [ ] **Step 5: Commit any fixes from testing**

```bash
git add -A && git commit -m "fix: integration test fixes from first deploy"
```
