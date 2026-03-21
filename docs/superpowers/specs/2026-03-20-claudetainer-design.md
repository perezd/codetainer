# Claudetainer: Interactive Claude Code Development Environment

A Docker container deployed to Fly.io that provides a persistent, interactive Claude Code environment accessible via SSH. The container runs Claude Code with a three-layer security model: an immutable base image with non-root user, network-level domain enforcement via iptables + CoreDNS, and a command-level approval hook. Claude Code authenticates via interactive OAuth login (no API key). GitHub access uses a fine-grained PAT stored in root-owned config files.

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│ Fly Machine (shared-cpu-1x, 1GB)                             │
│                                                              │
│  entrypoint.sh (runs as root)                                │
│    ├── configure iptables (OUTPUT DROP default)              │
│    ├── start CoreDNS (allowlisted domains only)              │
│    ├── configure git identity + PAT                          │
│    ├── start approval daemon                                 │
│    └── drop to claude user → start tmux                      │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ Claude's Environment (user: claude, non-root)        │    │
│  │                                                      │    │
│  │  Read-only root filesystem                           │    │
│  │  Writable: /workspace, /tmp, ~/.cache, ~/.claude     │    │
│  │                                                      │    │
│  │  tmux session "claude"                               │    │
│  │  ├── claude --dangerously-skip-permissions            │    │
│  │  │   ├── PreToolUse hook (check-command.sh)          │    │
│  │  │   │   └── reads rules.conf                        │    │
│  │  │   └── MCP: Bun docs                               │    │
│  │  │                                                    │    │
│  │  Capabilities: NONE                                   │    │
│  │  no-new-privileges: true                              │    │
│  │  seccomp: restricted                                  │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  iptables (set by root, immutable to claude):                │
│  ├── OUTPUT DROP (default)                                   │
│  ├── ACCEPT → allowlisted domain IPs                         │
│  ├── ACCEPT → CoreDNS (127.0.0.53)                           │
│  ├── ACCEPT → loopback                                       │
│  ├── DROP → metadata, private net, UDP, IPv6                 │
│  └── ACCEPT → ESTABLISHED                                    │
│                                                              │
└──────────────────────────────────────────────────────────────┘
        ▲
        │ fly ssh console → tmux attach
        │
    Developer (authenticates Claude Code via OAuth on first use)
```

## Security Model: Three Layers

### Layer 1: Container Hardening (tamper-proof enforcement)

The base image is **read-only**. Claude runs as an unprivileged user with all capabilities dropped. This makes every other security layer tamper-proof — Claude cannot modify hook scripts, rules, settings, or network configuration.

**Fly.io note:** Fly Machines are Firecracker VMs, not Docker containers. Docker security flags (`--cap-drop`, `--tmpfs`, `--read-only`, `--security-opt`) don't apply. All hardening is implemented by the entrypoint script itself, which runs as root before dropping to the `claude` user.

**Read-only root filesystem** with scoped writable tmpfs mounts. The entrypoint mounts tmpfs at each writable path and then remounts the root filesystem as read-only (`mount -o remount,ro /`):

| Mount | Type | Purpose |
|-------|------|---------|
| `/workspace` | tmpfs (512MB) | Project code — clone repos, write code here |
| `/tmp` | tmpfs (128MB) | Temporary files |
| `/home/claude/.cache` | tmpfs (256MB) | Build caches (Bun, pip, etc.) |
| `/home/claude/.claude` | tmpfs (64MB) | Claude Code config (settings.json, populated at boot) |

tmpfs is backed by RAM. Total addressable tmpfs is ~960MB, but only consumes RAM for data actually written. On a 1GB machine this leaves headroom for system processes and Claude Code. For larger projects, increase machine RAM to 2GB and scale tmpfs sizes accordingly.

Everything else (system binaries, hook scripts, rules.conf, the `approve` binary) is immutable at runtime. The settings.json copy on the `/home/claude/.claude` tmpfs is root-owned (mode 644) — Claude can read it but not modify it.

**User and capabilities:**

- Claude runs as user `claude` (UID 1000), not root
- Non-root users have no capabilities by default in Linux — no explicit `cap-drop` needed
- Claude's processes are launched with `PR_SET_NO_NEW_PRIVS` (via a wrapper) to prevent privilege escalation through setuid/setgid binaries
- Since this is a full VM (not a container), Docker's seccomp profiles don't apply. The non-root user + no capabilities + read-only FS + `PR_SET_NO_NEW_PRIVS` provide equivalent protection. Claude cannot call `bpf()`, `mount()`, etc. because these require capabilities (`CAP_SYS_ADMIN`, `CAP_BPF`, `CAP_NET_ADMIN`) that the `claude` user does not have.

**What this eliminates:** Self-modification attacks, privilege escalation, eBPF loading, process tracing (requires `CAP_SYS_PTRACE`), filesystem remounting (requires `CAP_SYS_ADMIN`). The PreToolUse hook and rules.conf are guaranteed immutable because they live on the read-only root filesystem.

### Layer 2: Network Boundary (domain-level enforcement)

All outbound network traffic is blocked by default via iptables. An explicit allowlist permits traffic only to known-good domains. Rules are set by root during the entrypoint, before dropping to the `claude` user who cannot modify them (no `CAP_NET_ADMIN`).

**iptables policy:**

```
# Default: drop all outbound
iptables -P OUTPUT DROP

# Allow loopback (required for sidecar communication)
iptables -A OUTPUT -o lo -j ACCEPT

# Block cloud metadata services (Fly.io, AWS, GCP, Azure)
iptables -A OUTPUT -d 169.254.0.0/16 -j DROP

# Block Fly.io private networking (prevent lateral movement to other machines)
iptables -A OUTPUT -d fdaa::/16 -j DROP
iptables -A OUTPUT -d 172.16.0.0/12 -j DROP

# Allow DNS to local filtering resolver only (CoreDNS on localhost)
iptables -A OUTPUT -p udp -d 127.0.0.53 --dport 53 -j ACCEPT
iptables -A OUTPUT -p tcp -d 127.0.0.53 --dport 53 -j ACCEPT

# Allow established/related connections
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

# Domain allowlist (resolved to IPs at startup)
# Infrastructure (required for Claude Code to function)
iptables -A OUTPUT -d <api.anthropic.com> -j ACCEPT
iptables -A OUTPUT -d <statsig.anthropic.com> -j ACCEPT
iptables -A OUTPUT -d <console.anthropic.com> -j ACCEPT

# GitHub (cloning, PRs, MCP server)
iptables -A OUTPUT -d <github.com> -j ACCEPT
iptables -A OUTPUT -d <api.github.com> -j ACCEPT
iptables -A OUTPUT -d <api.githubcopilot.com> -j ACCEPT
iptables -A OUTPUT -d <objects.githubusercontent.com> -j ACCEPT

# Package registries (enabled by default — individual packages
# are gated at the command level by the PreToolUse hook)
iptables -A OUTPUT -d <registry.npmjs.org> -j ACCEPT
iptables -A OUTPUT -d <pypi.org> -j ACCEPT
iptables -A OUTPUT -d <files.pythonhosted.org> -j ACCEPT
iptables -A OUTPUT -d <deb.debian.org> -j ACCEPT

# Bun
iptables -A OUTPUT -d <bun.sh> -j ACCEPT
iptables -A OUTPUT -d <bun.com> -j ACCEPT

# GitHub Packages npm registry
iptables -A OUTPUT -d <npm.pkg.github.com> -j ACCEPT

# Block all UDP except DNS (prevents QUIC bypass, UDP tunneling)
iptables -A OUTPUT -p udp -j DROP

# Log dropped packets for audit trail (rate-limited)
iptables -A OUTPUT -j LOG --log-prefix "CLAUDETAINER_DROP: " --log-level 4 -m limit --limit 5/min

# IPv6: drop all outbound (prevent IPv6 bypass of IPv4 rules)
ip6tables -P OUTPUT DROP
ip6tables -A OUTPUT -o lo -j ACCEPT
```

**Domain allowlist configuration:** The allowlist lives in `/opt/network/domains.conf` (one domain per line) on the read-only filesystem. The entrypoint resolves each domain to all returned IPs (via `dig +short`) and creates iptables rules for each. Where services publish IP ranges (e.g., GitHub's meta API), CIDR blocks are used instead of individual IPs. To add a new domain, update `domains.conf` in the repo and redeploy.

**IP resolution staleness:** CDNs rotate IPs. For long-running containers, resolved IPs may become stale. Mitigations: (a) resolve all IPs returned by DNS, not just the first; (b) use CIDR blocks where available; (c) containers are expected to be short-lived (hours to days, not weeks); (d) a periodic background job (cron, every 30 minutes) re-resolves domains and updates iptables rules using `iptables-restore` for atomic rule replacement (no window of inconsistent state). If DNS resolution fails for a domain, the refresh keeps old IPs for that domain rather than dropping them. This job runs as root and is not accessible to the `claude` user.

**DNS control:** A local **CoreDNS** instance runs on `127.0.0.53` and acts as the container's sole DNS resolver. CoreDNS is configured to only forward queries for domains listed in `domains.conf` to an upstream resolver — queries for all other domains return `NXDOMAIN`. This closes the DNS exfiltration channel: Claude cannot encode data in DNS query labels to attacker-controlled domains because those queries never leave the container. The CoreDNS config and upstream resolver settings live on the read-only root filesystem.

**What this eliminates:** Unauthorized outbound connections, DNS exfiltration via query labels, QUIC/HTTP3 bypass, connections to unknown domains regardless of how they're initiated (curl, wget, Python requests, Node fetch, raw sockets — all caught at both DNS and IP levels). The two layers (DNS filtering + iptables) provide defense-in-depth: even if one layer has a gap, the other catches it.

**Fail-closed:** If the entrypoint fails to configure iptables, the default policy is DROP — no traffic flows.

### Layer 3: Command Approval Hook (intent-level gate)

Claude Code runs with `--dangerously-skip-permissions`. A PreToolUse hook provides command-level approval for package installation and other gated operations.

**Hook architecture:**

The hook script (`/opt/approval/check-command.sh`) receives JSON on stdin from Claude Code:

```json
{"tool_name": "Bash", "tool_input": {"command": "bun add react"}}
```

The hook uses `jq` to extract `tool_name` and routes accordingly:

1. **If `tool_name` is `Bash`:** extract `.tool_input.command`, then:
   - **Command chaining check:** Before evaluating patterns, the hook checks for command chaining operators (`;`, `&&`, `||`, backticks, `$(...)`, `<(...)`, `>(...)`) in the command string. If any are found, the hook splits the command into sub-commands and evaluates each independently. All sub-commands must pass for the compound command to be approved. This prevents prefix-based bypasses like `echo x; curl evil.com` where only `echo` would be checked.
   - **Pattern evaluation:** Each (sub-)command is evaluated against `rules.conf` patterns, first match wins.
2. **All other tools** (`Read`, `Write`, `Edit`, `Glob`, `Grep`, etc.): auto-approve (exit 0)

Note: Write/Edit protection is no longer needed in the hook because the root filesystem is read-only. Claude cannot modify protected files regardless of what the hook allows.

**Rules configuration** (`/opt/approval/rules.conf`):

```
# Auto-approve patterns (exit 0)
allow:^git\s+(status|log|diff|branch|checkout|switch|add|commit|stash|rebase|merge|fetch|remote|show|rev-parse|symbolic-ref|config|init|reset|restore|cherry-pick|tag|bisect|blame|shortlog|describe|ls-files|ls-tree|rev-list|for-each-ref|name-rev|reflog)\b
allow:^git\s+clone\b
allow:^(ls|cat|head|tail|cp|mv|mkdir|touch|tree|less)\b
allow:^(grep|rg|fd|ag)\b
allow:^bun (run|test|build|check)\b
allow:^(python3?)\b
allow:^(echo|pwd|cd|which)\b
allow:^(wc|sort|uniq|diff|sed|awk|tee|basename|dirname)\b
allow:^(date|file|stat|realpath|readlink|id|whoami|uname|hostname)\b
allow:^(tar|gzip|gunzip|zip|unzip)\b
allow:^(tr|cut|paste|comm|join)\b
allow:^gh\s+(pr|issue|repo view|repo clone|run view|run list)\b
allow:^(rm|rmdir)\b
allow:^(mv|cp|ln)\b
allow:^(chmod|chown)\b
allow:^tmux\s+(list-sessions|list-windows|display-message)\b

# Hard-block patterns (exit 2, cannot be approved)
# Pipe to any shell/interpreter
block:.*\|\s*/?(usr/)?(s?bin/)?(ba)?sh\b
block:.*\|\s*/?(usr/)?(s?bin/)?(python3?|node|bun|perl|ruby)\b
# Shell execution wrappers
block:^(ba)?sh\s+-c\b
block:^eval\b
block:^exec\b
block:^source\b
# Destructive system operations
block:^sudo\b
block:^rm\s+-rf\s+/
block:^chmod\s+777\b
# Self-approval prevention
block:^approve\b
# Dangerous gh subcommands (data exfiltration vectors)
block:^gh\s+gist\b
block:^gh\s+repo\s+(create|delete)\b
block:^gh\s+auth\b
block:^gh\s+api\b
# tmux cross-pane injection
block:^tmux\s+(send-keys|send-prefix|capture-pane|pipe-pane)\b
# Prevent reading environment variables and /proc (credential leaks)
block:^(printenv|env$)
block:.*/proc/
# Prevent command execution via find/xargs arguments
block:.*-exec\b
block:.*\bxargs\b

# Approval-required patterns (exit 2 with approval instructions)
approve:^(apt-get|apt)\s+install\b
approve:^bun\s+(add|install)\b
approve:^(pip3?|pipx)\s+install\b
approve:^curl\b
approve:^wget\b
approve:^git\s+push\b

# Default: block unmatched commands (allowlist model)
# Use "allow" to switch to a denylist model if this is too restrictive
default:block
```

**Three tiers:**

Both `block:` and `approve:` use exit code 2 (blocked). The difference is the stderr message.

| Tier | Exit Code | Behavior |
|------|-----------|----------|
| **Auto-approve** (`allow:`) | 0 | Command runs immediately |
| **Hard-block** (`block:`) | 2 | Rejected, cannot be overridden |
| **Approval-required** (`approve:`) | 2 | Blocked with: `⛔ Approval required — run: ! approve '<command>'` |
| **Default** (`default:`) | configurable | `allow` = auto-approve, `block` = hard-block |

**Approval flow:**

The `approve` CLI tool (`/usr/local/bin/approve`) communicates with a small root-owned **approval daemon** (`/opt/approval/approval-daemon`) that manages tokens. The daemon listens on a Unix domain socket (`/run/claude-approval.sock`). The token directory (`/run/claude-approved/`) is owned by root and writable only by root.

**Socket authentication:** The daemon uses `SO_PEERCRED` on every incoming connection to verify the connecting process is running as root (UID 0). Connections from UID 1000 (claude) are rejected. This prevents Claude from self-approving commands by speaking the daemon protocol directly via Python or Bun. The `approve` CLI is a setuid-root binary — wait, `no-new-privileges` blocks setuid. Instead: the `approve` CLI is owned by root and runs as a separate process spawned by the entrypoint (not by Claude). When the user types `! approve 'cmd'`, Claude Code's shell escape runs `/usr/local/bin/approve` which inherits the user's UID. Since the user SSHes in as root (Fly default), the approve CLI runs as root and passes the `SO_PEERCRED` check. Claude's own processes run as UID 1000 and are rejected.

1. Claude runs `bun add react`
2. Hook matches `approve:^bun\s+(add|install)\b` → exits 2 with instructions
3. User types `! approve 'bun add react'` in Claude Code prompt
4. `approve` CLI sends the command string to the approval daemon via the Unix socket
5. Daemon computes SHA256 hash and writes token to `/run/claude-approved/<hash>` (root-owned directory)
6. Claude retries `bun add react`
7. Hook computes the same hash, finds the matching token → deletes it → exits 0
8. Command executes (network request succeeds because `registry.npmjs.org` is in the iptables allowlist)

Approvals are **one-shot**: each token is consumed on use. Approving `bun add react` does not approve `bun add malicious-package`. Tokens are cleared on container restart.

**Self-approval prevention:** `block:^approve\b` prevents Claude from running the `approve` command via the Bash tool. Even if Claude bypassed this, writing directly to the token directory fails because it is root-owned (mode 0700). The Unix socket only accepts writes from the `approve` CLI, which Claude cannot execute through the hook.

**Why this works with Layer 2:** The iptables allowlist permits traffic to package registries, but the hook gates which install commands actually run. Claude can't bypass the hook to run `bun add evil-package` because the hook fires on every Bash tool invocation even in `--dangerously-skip-permissions` mode. The two layers complement: iptables blocks unknown domains, the hook blocks unapproved commands to known domains.

### Credential Management

**Claude Code authentication:** Claude Code uses interactive OAuth login. The user authenticates on first use after each container start. OAuth tokens are stored by Claude Code in `/home/claude/.claude/` (tmpfs) — they persist for the session but are lost on container restart, requiring re-authentication.

**Git credential isolation:**

The entrypoint (running as root) configures git's credential helper to use the PAT stored in a root-owned file:

```
git config --system credential.helper 'store --file=/root/.git-credentials'
```

The `claude` user can run `git clone/push/pull` and git transparently authenticates, but Claude cannot read the credential file or extract the PAT.

**gh CLI authentication:**

The entrypoint configures `gh` auth writing to `/opt/gh-config/hosts.yml` (root-owned directory, mode 711; file mode 644). `GH_CONFIG_DIR=/opt/gh-config` is set in Claude's environment. Since `gh api` is hard-blocked and the PAT is fine-grained with minimal permissions, the token being readable via `gh config` is an accepted risk — Claude cannot exfiltrate it to non-allowlisted domains.

**What's NOT in Claude's environment:** No `ANTHROPIC_API_KEY`, no `GH_PAT`, no `GH_TOKEN`. The PAT is accessible only via root-owned git credential store and gh config. The Anthropic API is accessed via OAuth tokens managed by Claude Code itself.

## Container Image

### Base Image

`debian:bookworm-slim` — minimal footprint.

### Installed Tooling

- **Bun** — project runtime, installed via official install script with version pinned and checksum verified
- **Python 3** — Claude Code frequently uses it for scripting tasks
- **Claude Code** — installed via `curl -fsSL https://claude.ai/install.sh | bash` with version pinned and binary checksum verified post-install
- **gh** — GitHub CLI, installed from GitHub's official apt repo with version pinned
- **CLI tools:** jq, ripgrep, fd-find, git, curl, wget, tmux, less, tree
- **iptables** — for network boundary enforcement
- **CoreDNS** — local DNS resolver that only resolves allowlisted domains

### Supply Chain Hardening

All install scripts fetched at build time (`curl | bash` for Claude Code, Bun) are pinned to specific versions with SHA256 checksums verified post-download. The Dockerfile uses a multi-stage build: install scripts run in a builder stage, and only verified artifacts are copied to the final image. GHCR vulnerability scanning (Trivy or Dependabot) is enabled on the repository.

### Claude Code Configuration

`claude-settings.json` is baked into the image at `/opt/claude/settings.json` as a template. At boot, the entrypoint copies it to `/home/claude/.claude/settings.json` (which lives on a small tmpfs mount for `/home/claude/.claude`), so no secrets are baked into the image and the read-only filesystem is not violated.

Contents:
- **PreToolUse hook** pointing to `/opt/approval/check-command.sh`
- **Attribution:** `includeCoAuthoredBy: false` — disables the `Co-authored-by: Claude` trailer on commits. All commits are authored exclusively by the robot account.
- **MCP servers:**
  - Bun docs: `https://bun.com/docs/mcp`

### Superpowers Plugin

Installed at first boot by the entrypoint script via `claude plugin install superpowers@claude-plugins-official`. If the install fails, the entrypoint logs a warning and continues.

## Container Lifecycle & Fly.io Deployment

### Fly Machine Configuration

- **Size:** `shared-cpu-1x`, 1GB RAM (minimum; 2GB recommended for larger projects)
- **Persistence:** None — workspace is ephemeral, GitHub is source of truth
- **Restart policy:** `no` (manual restarts only)

### Secrets (via `fly secrets set`)

| Secret | Purpose |
|--------|---------|
| `GH_PAT` | Git HTTPS auth, gh CLI — stored in root-owned config files, never in Claude's environment |

Note: No `ANTHROPIC_API_KEY` is needed. Claude Code authenticates via interactive OAuth login on first use.

**GitHub PAT scope:** Use a **fine-grained personal access token** (not classic) scoped to specific repositories only:

| Permission | Access Level | Purpose |
|-----------|-------------|---------|
| Contents | Read & Write | Clone, pull, push commits |
| Pull requests | Read & Write | Create and read PRs |
| Issues | Read & Write | Create issues, comment |
| Metadata | Read (always included) | Basic repo info |

**Permissions explicitly excluded:** Administration, Actions/Workflows, Packages, Pages, Secrets, Environments, Deployments. Fine-grained PATs **cannot create gists** (gists require classic tokens), which eliminates that exfiltration vector entirely. The token is scoped to specific repositories in the robot account's org — it cannot access other repos even if Claude crafts a `git remote add` to a different repo.

### Environment Variables (via `fly machine run --env`)

| Variable | Purpose |
|----------|---------|
| `GIT_USER_NAME` | Robot git commit name (used for both author and committer) |
| `GIT_USER_EMAIL` | Robot git commit email (used for both author and committer) |
| `REPO_URL` | (Optional) Git repository URL to clone into `/workspace` at startup |

### Entrypoint Script

`/usr/local/bin/entrypoint.sh` runs as root and performs:

1. **Filesystem hardening:**
   - Mount tmpfs at `/workspace` (512MB), `/tmp` (128MB), `/home/claude/.cache` (256MB), `/home/claude/.claude` (64MB)
   - Set ownership: `/workspace` and `/home/claude/.cache` owned by `claude`; `/home/claude/.claude` owned by root (mode 755)
   - All remaining setup steps write to these tmpfs mounts or to paths that must complete before the root FS is locked
   - After all setup is complete (steps 2-5), remount root filesystem as read-only: `mount -o remount,ro /`
2. **Network lockdown:**
   - Start CoreDNS on `127.0.0.53` with config from `/opt/network/Corefile` — only resolves domains listed in `domains.conf`, all others return NXDOMAIN
   - Read `/opt/network/domains.conf`, resolve each domain to all IPs via `dig +short`
   - Apply iptables rules: `OUTPUT DROP` default, explicit ACCEPT for resolved IPs
   - Block Fly private networking (`fdaa::/16`, `172.16.0.0/12`) and cloud metadata (`169.254.0.0/16`)
   - Block all UDP except DNS to local CoreDNS
   - Start background cron job to re-resolve domains every 30 minutes
3. **Git configuration:**
   - Write `$GH_PAT` to `/root/.git-credentials` (root-owned, mode 600)
   - Configure git system-wide credential helper pointing to that file
   - Set git identity from `$GIT_USER_NAME` / `$GIT_USER_EMAIL` env vars
   - Configure `gh` CLI auth: `echo "$GH_PAT" | gh auth login --with-token` writing to `/opt/gh-config/hosts.yml` (root-owned directory, mode 711; file mode 644). Set `GH_CONFIG_DIR=/opt/gh-config` in Claude's environment.
   - Configure npm/bun auth for GitHub Packages: write `.npmrc` with `//npm.pkg.github.com/:_authToken=${GH_PAT}` to `/home/claude/.npmrc` (root-owned, mode 644)
4. **Approval daemon startup:**
   - Start the approval daemon on Unix socket `/run/claude-approval.sock` (supervised restart loop)
5. **Claude Code setup:**
   - Copy settings template from `/opt/claude/settings.json` to `/home/claude/.claude/settings.json` (tmpfs, root-owned, mode 644 — Claude can read but not modify, preventing hook removal mid-session)
   - Install superpowers plugin (log warning on failure)
6. **Lock filesystem:** `mount -o remount,ro /` — after this point, the root filesystem is immutable
7. **Repository clone (optional):**
   - If `$REPO_URL` is set, clone it into `/workspace` as the `claude` user: `su -s /bin/bash claude -c "git clone $REPO_URL /workspace/repo"`
   - Claude Code starts inside the cloned repo directory
8. **Session startup:**
   - Start tmux session as `claude` user with `remain-on-exit on`
   - In tmux: `cd /workspace/repo` (if cloned) or `cd /workspace`, then run `claude --dangerously-skip-permissions`
   - Keep container alive with `exec sleep infinity` (SSH users auto-attach via `.bashrc`)

### Connecting

```bash
fly ssh console
```

The root user's `.bashrc` auto-attaches to the Claude tmux session on SSH login:

```bash
if [ -n "$SSH_CONNECTION" ] && tmux has-session -t claude 2>/dev/null; then
  exec tmux attach -t claude
fi
```

This is baked into the image so `fly ssh console` drops directly into the Claude Code session.

### When Claude Code Exits

tmux is configured with `remain-on-exit on`. The pane stays alive showing exit status. Restart with `tmux respawn-pane -t claude` or a bound key. The container does not stop.

## CI/CD Pipeline

### GitHub Actions Workflow

`.github/workflows/build.yml` — triggered on push to `main`:

1. Checkout repository
2. Log in to GitHub Container Registry (GHCR)
3. Build and push Docker image to `ghcr.io/<org>/claudetainer:latest`

GHCR authentication uses the built-in `GITHUB_TOKEN` provided by GitHub Actions — no additional secrets needed.

Fly.io deployment is done manually — no `fly.toml` needed:

```bash
fly machine run ghcr.io/<org>/claudetainer:latest \
  --app claudetainer \
  --region sjc \
  --vm-memory 1024 \
  --vm-size shared-cpu-1x \
  --env GIT_USER_NAME=claudetainer-bot \
  --env GIT_USER_EMAIL=claudetainer@noreply.github.com
```

To auto-clone a repo at startup, add `--env REPO_URL=https://github.com/your-org/your-repo`.

Secrets (`GH_PAT`) are set once via `fly secrets set` on the app and automatically available to all machines.

## Project File Structure

```
claudetainer/
├── Dockerfile
├── .github/
│   └── workflows/
│       └── build.yml
├── entrypoint.sh
├── approval/
│   ├── check-command.sh       # PreToolUse hook script
│   ├── rules.conf             # Configurable allow/approve/block patterns
│   ├── approve                # CLI tool: sends approval requests to daemon
│   └── approval-daemon        # Root-owned daemon: manages approval tokens
├── network/
│   ├── domains.conf           # Domain allowlist (one per line, shared by iptables + CoreDNS)
│   ├── Corefile.template      # CoreDNS config template: base with NXDOMAIN default
│   └── refresh-iptables.sh    # Cron script: re-resolves domains, atomic iptables-restore
├── status                     # CLI tool: shows active approvals, recent blocks, daemon health
└── claude-settings.json       # Claude Code settings template (hook config + MCP)
```

| File | Purpose |
|------|---------|
| `Dockerfile` | Image build: Bun, Python, CLI tools, Claude Code, non-root user, read-only FS |
| `build.yml` | GitHub Action: build → push to GHCR |
| `entrypoint.sh` | Container startup: network lockdown, git config, approval daemon, tmux |
| `check-command.sh` | PreToolUse hook: reads rules.conf, splits compounds, enforces tiers |
| `rules.conf` | Configurable allow/approve/block regex patterns for Bash commands |
| `approve` | CLI tool: sends approval hash to daemon via Unix socket |
| `approval-daemon` | Root-owned: listens on Unix socket, writes tokens to root-owned directory |
| `domains.conf` | Domain allowlist: shared by iptables + CoreDNS |
| `Corefile.template` | CoreDNS base config; entrypoint generates final Corefile from domains.conf |
| `refresh-iptables.sh` | Cron job (every 30m): re-resolves domains, atomic `iptables-restore` |
| `status` | CLI tool: shows active approvals, recent blocks, daemon health |
| `claude-settings.json` | Claude Code settings template: hook config + Bun docs MCP |

## Observability & Audit Trail

**Hook logging:** All hook decisions (allow, block, approve-required) are logged to stderr with timestamps, the matched rule, and the full command. These are captured by Claude Code's output and visible via `fly logs`.

**iptables logging:** Dropped packets are logged with the prefix `CLAUDETAINER_DROP:` (rate-limited to 5/min to prevent log flooding). Viewable via `fly logs` or `dmesg`.

**Approval logging:** The approval daemon logs all approval requests (who approved what, when) to stdout.

**Monitoring command:** Users can run `! status` (a script at `/usr/local/bin/status`) to see: active approval tokens, recent blocked commands, recent iptables drops, approval daemon health.

## Operational Security Notes

- **SSH access:** Fly.io org membership controls who can `fly ssh console`. All human sessions connect as root (Fly default), but Claude runs as unprivileged user `claude` in tmux.
- **tmux hygiene:** Users should not type secrets in the Claude tmux session. Tmux scrollback could be read by Claude via `tmux capture-pane` (which is hard-blocked in rules.conf).
- **CI/CD token rotation:** The `FLY_API_TOKEN` GitHub secret should be rotated regularly. If compromised, an attacker can deploy arbitrary images. Consider OIDC federation if Fly supports it.
- **Claude-authored PRs:** All commits use the robot git identity. Require human code review for all merges — no auto-merge. Human code review is a **critical security boundary**, not optional — Claude can write arbitrary code to `/workspace`, and review is the last line of defense before that code runs in unrestricted environments.
- **No published ports:** The `fly.toml` must not contain a `[services]` or `[[services]]` block. No ports should be exposed to the internet.
- **Fly private networking:** iptables blocks Fly's internal network ranges (`fdaa::/16`, `172.16.0.0/12`) to prevent lateral movement to other machines in the same org.

## Emergency Procedures

**Kill switch:** If suspicious behavior is detected:
1. `fly machine stop <machine-id>` — immediately stops the VM, killing all processes
2. Alternatively from inside the session: `kill -9 -1` as root kills all UID 1000 processes
3. The ephemeral workspace is lost, but `fly logs` retains hook/iptables/approval audit logs for forensic review

**Session recording:** tmux is configured to log all pane output to `/tmp/tmux-session.log`. This file is on tmpfs (lost on restart) but provides a forensic trail during the session. For persistent session recording, pipe `fly logs` to an external log aggregator.

## Security Properties Summary

| Threat | Mitigation |
|--------|------------|
| Claude modifies hook/rules/settings | Read-only root filesystem — structurally impossible |
| Claude escalates to root | Non-root user + `no-new-privileges` + capability drop |
| Claude loads eBPF/kernel modules | Seccomp blocks `bpf()`, `mount()` |
| Claude connects to unknown domains | iptables `OUTPUT DROP` default, explicit allowlist |
| Claude exfiltrates via DNS query labels | Local CoreDNS only resolves allowlisted domains; non-allowlisted queries return NXDOMAIN |
| Claude uses Python to make DNS queries | CoreDNS filters at resolver level; queries for attacker domains never leave the container |
| Claude uses `env` or `cat /proc/` to read secrets | `env` (bare) blocked; `/proc/` blocked anywhere in command; no secrets in Claude's env |
| Claude uses `env VAR=val cmd` to bypass hook | `env` with arguments falls to default:block (no allow rule for env) |
| Claude reaches other Fly machines | Fly private network ranges (fdaa::/16, 172.16.0.0/12) blocked in iptables |
| Claude exfiltrates Anthropic credentials | Claude Code uses OAuth; tokens are session-scoped on tmpfs, lost on restart |
| Claude exfiltrates GitHub PAT | PAT in root-owned files (mode 600); readable via gh config (accepted risk — scoped, gh api blocked, can't reach non-allowlisted domains) |
| Claude reads secrets from /proc | No secrets in Claude's environment; PAT only in root-owned files |
| Claude self-approves via socket | Approval daemon socket mode 0600 (root-only); Claude (UID 1000) cannot connect |
| Claude uses command chaining to bypass hook | Hook splits compound commands (`;`, `&&`, `\|\|`, `$()`) and evaluates each sub-command independently |
| Claude exfiltrates via `git push` | `git push` requires approval; PAT scoped to specific repos only |
| Claude bypasses gh blocks via `gh api` | `gh api` is hard-blocked |
| Claude runs `sudo`, `rm -rf /` | Hook hard-blocks destructive commands |
| Claude bypasses hook via eval/sh -c | `eval`, `exec`, `source`, `sh -c`, `bash -c` all hard-blocked |
| Claude uses unknown command | `default:block` — unmatched commands are blocked (allowlist model) |
| Claude installs malicious package | Hook requires per-command approval for all install commands |
| Claude self-approves commands | `approve` blocked by hook; token directory root-owned (mode 0700) |
| Claude forges approval tokens | Token directory writable only by root-owned approval daemon |
| Claude bypasses via QUIC/UDP | All UDP dropped except DNS |
| Claude injects into other tmux panes | `tmux send-keys/capture-pane/pipe-pane` hard-blocked |
| Claude exfiltrates via gh gist/repo | `gh gist`, `gh repo create`, `gh repo delete`, `gh auth` hard-blocked |
| Claude accesses cloud metadata | `169.254.0.0/16` explicitly dropped in iptables |
| Approval daemon/hook killed | Claude lacks capabilities to signal root-owned processes |
| iptables modified | Claude lacks `CAP_NET_ADMIN` |
| CDN IP rotation breaks allowlist | Background cron re-resolves with atomic `iptables-restore` every 30 minutes |
| Supply chain compromise at build | Version-pinned installs with SHA256 verification; multi-stage Docker build; GHCR scanning |
| Blocked command not visible to user | All hook decisions logged with matched rule; `! status` command for overview |
