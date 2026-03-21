# Claudetainer: Interactive Claude Code Development Environment

A Docker container deployed to Fly.io that provides a persistent, interactive Claude Code environment accessible via SSH. The container runs Claude Code with a layered security model: an immutable base image, a non-root user, network-level domain enforcement via iptables, and a command-level approval hook. A secret-holding sidecar ensures API keys are never exposed to Claude's environment.

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│ Fly Machine (shared-cpu-1x, 512MB)                           │
│                                                              │
│  entrypoint.sh (runs as root)                                │
│    ├── configure iptables (OUTPUT DROP default)              │
│    ├── configure git identity                                │
│    ├── install superpowers plugin                             │
│    ├── substitute secrets into settings                      │
│    └── drop to claude user → start tmux                      │
│                                                              │
│  ┌─────────────────────────────────┐  ┌───────────────────┐  │
│  │ Claude's Environment            │  │ Auth Sidecar      │  │
│  │ (user: claude, non-root)        │  │ (runs as root)    │  │
│  │                                 │  │                   │  │
│  │  Read-only root filesystem      │  │ Reverse proxy     │  │
│  │  Writable: /workspace           │  │ that injects:     │  │
│  │           /tmp                  │  │  - ANTHROPIC key  │  │
│  │           /home/claude/.cache   │  │  - GitHub PAT     │  │
│  │                                 │  │                   │  │
│  │  tmux session "claude"          │  │ Listens on        │  │
│  │  ├── claude --skip-perms        │  │ 127.0.0.1:4111    │  │
│  │  │   ├── PreToolUse hook        │  │                   │  │
│  │  │   │   └── check-command.sh   │  │ Claude sees:      │  │
│  │  │   │       └── rules.conf     │  │ ANTHROPIC_API_URL │  │
│  │  │   └── MCP servers            │  │ = localhost:4111  │  │
│  │  │       ├── GitHub             │  │                   │  │
│  │  │       └── Bun docs           │  └───────────────────┘  │
│  │  │                              │                         │
│  │  Capabilities: NONE             │  iptables (immutable):  │
│  │  no-new-privileges: true        │  ├── OUTPUT DROP (dflt) │
│  │  seccomp: restricted            │  ├── ACCEPT → sidecar   │
│  │                                 │  ├── ACCEPT → github    │
│  └─────────────────────────────────┘  ├── ACCEPT → DNS       │
│                                       └── ACCEPT → ESTAB     │
│                                                              │
└──────────────────────────────────────────────────────────────┘
        ▲
        │ fly ssh console → tmux attach
        │
    Developer
```

## Security Model: Four Layers

### Layer 1: Container Hardening (tamper-proof enforcement)

The base image is **read-only**. Claude runs as an unprivileged user with all capabilities dropped. This makes every other security layer tamper-proof — Claude cannot modify hook scripts, rules, settings, or network configuration.

**Read-only root filesystem** with scoped writable mounts:

| Mount | Type | Purpose |
|-------|------|---------|
| `/workspace` | tmpfs (1GB) | Project code — clone repos, write code here |
| `/tmp` | tmpfs (512MB) | Temporary files |
| `/home/claude/.cache` | tmpfs (1GB) | Build caches (Bun, pip, etc.) |
| `/home/claude/.claude` | tmpfs (64MB) | Claude Code config (settings.json, populated at boot) |

Everything else (system binaries, hook scripts, rules.conf, settings.json, the `approve` binary) is immutable at runtime.

**User and capabilities:**

- Claude runs as user `claude` (UID 1000), not root
- `--cap-drop=ALL` — no Linux capabilities
- `--security-opt=no-new-privileges` — cannot escalate via setuid/setgid
- Seccomp profile blocks: `bpf()`, `mount()`, `ptrace()`, `personality()`

**What this eliminates:** Self-modification attacks, privilege escalation, eBPF loading, process tracing/injection, filesystem remounting. The PreToolUse hook and rules.conf are guaranteed immutable because they live on the read-only root filesystem.

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

# Allow DNS to trusted resolver only
iptables -A OUTPUT -p udp -d <trusted-dns> --dport 53 -j ACCEPT
iptables -A OUTPUT -p tcp -d <trusted-dns> --dport 53 -j ACCEPT

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

# Block all UDP except DNS (prevents QUIC bypass, UDP tunneling)
iptables -A OUTPUT -p udp -j DROP

# Log dropped packets for audit trail (rate-limited)
iptables -A OUTPUT -j LOG --log-prefix "CLAUDETAINER_DROP: " --log-level 4 -m limit --limit 5/min
```

**Domain allowlist configuration:** The allowlist lives in `/opt/network/domains.conf` (one domain per line) on the read-only filesystem. The entrypoint resolves each domain to all returned IPs (via `dig +short`) and creates iptables rules for each. Where services publish IP ranges (e.g., GitHub's meta API), CIDR blocks are used instead of individual IPs. To add a new domain, update `domains.conf` in the repo and redeploy.

**IP resolution staleness:** CDNs rotate IPs. For long-running containers, resolved IPs may become stale. Mitigations: (a) resolve all IPs returned by DNS, not just the first; (b) use CIDR blocks where available; (c) containers are expected to be short-lived (hours to days, not weeks); (d) a periodic background job (cron, every 30 minutes) re-resolves domains and updates iptables rules using `iptables-restore` for atomic rule replacement (no window of inconsistent state). If DNS resolution fails for a domain, the refresh keeps old IPs for that domain rather than dropping them. This job runs as root and is not accessible to the `claude` user.

**DNS control:** All DNS queries go to a single trusted resolver. Queries for non-allowlisted domains still resolve (needed for the hook to show meaningful error messages), but the iptables rules prevent actual connections to non-allowlisted IPs.

**What this eliminates:** Unauthorized outbound connections, DNS exfiltration via direct UDP, QUIC/HTTP3 bypass, connections to unknown domains regardless of how they're initiated (curl, wget, Python requests, Node fetch, raw sockets — all caught at the IP level).

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
allow:^(grep|rg|fd|find|ag)\b
allow:^bun (run|test|build|check)\b
allow:^(python3?)\b
allow:^(echo|pwd|cd|which)\b
allow:^(wc|sort|uniq|diff|sed|awk|xargs|tee|basename|dirname)\b
allow:^(date|file|stat|realpath|readlink|id|whoami|uname|hostname)\b
allow:^(tar|gzip|gunzip|zip|unzip)\b
allow:^(tr|cut|paste|comm|join)\b
allow:^gh\s+(pr|issue|repo view|repo clone|run view|run list)\b
allow:^(rm|rmdir)\b
allow:^(mv|cp|ln)\b
allow:^(chmod|chown)\b
allow:^tmux\s+(list-sessions|list-windows|display-message)\b
allow:^env\s+\S+=

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
# Prevent reading environment variables (credential leaks)
block:^(printenv|/proc/)
block:^env$

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

### Layer 4: Secret-Holding Sidecar (credential isolation)

Claude never sees API keys directly. A lightweight reverse proxy sidecar holds secrets and injects them into outbound API requests.

**Sidecar architecture:**

The sidecar is a lightweight reverse proxy (~100-200 lines, written in Go using `httputil.ReverseProxy` or similar well-audited library). It runs as root (separate from Claude's process) and exposes two endpoints:

- `127.0.0.1:4111` → proxies to `api.anthropic.com` (injects `ANTHROPIC_API_KEY`)
  - Only allows `POST /v1/messages` and `POST /v1/complete` — rejects all other paths
- `127.0.0.1:4112` → proxies to `api.githubcopilot.com` (injects `Authorization: Bearer <GH_PAT>`)
  - Only allows the MCP endpoint pattern — rejects all other paths

**Request origin validation:** The sidecar uses a per-session bearer token generated at startup and written only to Claude Code's config (settings.json on the tmpfs mount). The sidecar rejects any request that doesn't include this token in a custom header (`X-Claudetainer-Token`). This prevents Python, Bun, or other runtimes from directly calling the sidecar to gain credential injection — only Claude Code (which reads the token from settings.json) can authenticate. The token is a random 256-bit value regenerated on every container start.

The sidecar must handle SSE streaming (Anthropic API responses are server-sent events) and TLS to upstream. All requests are logged to stdout (viewable via `fly logs`). Rate-limiting is applied to detect abuse patterns.

If the sidecar crashes, Claude Code gets `connection refused` — **fail-closed**. The sidecar should be supervised (e.g., via a process manager in the entrypoint, or tmux respawn).

Claude's environment sees:
- `ANTHROPIC_API_BASE_URL=http://127.0.0.1:4111` — points to the sidecar, not the real API
- No `ANTHROPIC_API_KEY` in the environment
- No `GH_PAT` in the environment
- No `GH_TOKEN` in the environment
- Git credential helper configured by root (stored in `/root/.git-credentials`, unreadable by `claude`)
- `gh` CLI reads auth from `/root/.config/gh/hosts.yml` (root-owned, unreadable by `claude`)
- GitHub MCP server URL points to `http://127.0.0.1:4112/mcp/` — sidecar injects the PAT

**Git credential isolation:**

The entrypoint (running as root) configures git's credential helper to use the PAT stored in a root-owned file:

```
git config --system credential.helper 'store --file=/root/.git-credentials'
```

The `claude` user can run `git clone/push/pull` and git transparently authenticates, but Claude cannot read the credential file or extract the PAT.

**MCP server authentication:**

The GitHub MCP server is also routed through the sidecar. The sidecar exposes a second endpoint (`127.0.0.1:4112`) that proxies to `api.githubcopilot.com` and injects the `Authorization: Bearer <GH_PAT>` header. Claude's settings.json points the GitHub MCP server URL to `http://127.0.0.1:4112/mcp/` — Claude never sees the PAT value.

The `GH_PAT` is scoped to the robot GitHub account with minimum necessary permissions (repo read/write for specific repos, no admin access). Even so, by routing through the sidecar, the PAT cannot be exfiltrated from Claude's environment.

**What this eliminates:** API key exfiltration. Even if Claude is fully compromised, the Anthropic API key cannot be extracted — it exists only in the sidecar's process memory and the Fly secret store.

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

### Supply Chain Hardening

All install scripts fetched at build time (`curl | bash` for Claude Code, Bun) are pinned to specific versions with SHA256 checksums verified post-download. The Dockerfile uses a multi-stage build: install scripts run in a builder stage, and only verified artifacts are copied to the final image. GHCR vulnerability scanning (Trivy or Dependabot) is enabled on the repository.

### Claude Code Configuration

`claude-settings.json` is baked into the image at `/opt/claude/settings.json` as a template. At boot, the entrypoint copies it to `/home/claude/.claude/settings.json` (which lives on a small tmpfs mount for `/home/claude/.claude`), so no secrets are baked into the image and the read-only filesystem is not violated.

Contents:
- **PreToolUse hook** pointing to `/opt/approval/check-command.sh`
- **MCP servers:**
  - GitHub: `http://127.0.0.1:4112/mcp/` (proxied through sidecar, no credentials in config)
  - Bun docs: `https://bun.com/docs/mcp`

### Superpowers Plugin

Installed at first boot by the entrypoint script via `claude plugin install superpowers@claude-plugins-official`. If the install fails, the entrypoint logs a warning and continues.

## Container Lifecycle & Fly.io Deployment

### Fly Machine Configuration

- **Size:** `shared-cpu-1x`, 512MB RAM
- **Persistence:** None — workspace is ephemeral, GitHub is source of truth
- **Restart policy:** `no` (manual restarts only)

### Secrets (via `fly secrets set`)

| Secret | Purpose |
|--------|---------|
| `ANTHROPIC_API_KEY` | Held by sidecar only, never exposed to Claude |
| `GH_PAT` | Git HTTPS auth, gh CLI, GitHub MCP server — all via root-owned config, never in Claude's environment |

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
| `GIT_AUTHOR_NAME` | Robot git commit name |
| `GIT_COMMITTER_NAME` | Robot git commit name |
| `GIT_AUTHOR_EMAIL` | Robot git commit email |
| `GIT_COMMITTER_EMAIL` | Robot git commit email |

### Entrypoint Script

`/usr/local/bin/entrypoint.sh` runs as root and performs:

1. **Network lockdown:**
   - Read `/opt/network/domains.conf`, resolve each domain to all IPs via `dig +short`
   - Apply iptables rules: `OUTPUT DROP` default, explicit ACCEPT for resolved IPs
   - Block all UDP except DNS to trusted resolver
   - Start background cron job to re-resolve domains every 30 minutes
2. **Git configuration:**
   - Write `$GH_PAT` to `/root/.git-credentials` (root-owned, mode 600)
   - Configure git system-wide credential helper pointing to that file
   - Set git identity from `$GIT_AUTHOR_NAME` / `$GIT_AUTHOR_EMAIL` env vars
3. **Sidecar startup:**
   - Start the auth sidecar proxy:
     - `127.0.0.1:4111` → proxies to `api.anthropic.com` (injects `ANTHROPIC_API_KEY`)
     - `127.0.0.1:4112` → proxies to `api.githubcopilot.com` (injects `GH_PAT`)
   - Start the approval daemon on Unix socket `/run/claude-approval.sock`
4. **Claude Code setup:**
   - Copy settings template from `/opt/claude/settings.json` to `/home/claude/.claude/settings.json` (tmpfs)
   - Configure `gh` CLI auth: `echo "$GH_PAT" | gh auth login --with-token` writing to `/opt/gh-config/hosts.yml` (root-owned directory, mode 711; file mode 644 so `claude` can read config but the token is embedded). Set `GH_CONFIG_DIR=/opt/gh-config` in Claude's environment. Note: since `gh api` is hard-blocked and the PAT is scoped to specific repos with minimal permissions, the token being readable via `gh config` is an accepted risk — Claude cannot exfiltrate it to non-allowlisted domains, and the `default:block` policy prevents using arbitrary commands to read it. The primary secrets (Anthropic API key) are fully isolated in the sidecar.
   - Install superpowers plugin (log warning on failure)
5. **Session startup:**
   - Start tmux session as `claude` user with `remain-on-exit on`
   - In tmux: `cd /workspace && claude --dangerously-skip-permissions`
   - `exec tmux attach -t claude` (keeps container alive)

### Connecting

```bash
fly ssh console
tmux attach -t claude
```

### When Claude Code Exits

tmux is configured with `remain-on-exit on`. The pane stays alive showing exit status. Restart with `tmux respawn-pane -t claude` or a bound key. The container does not stop.

## CI/CD Pipeline

### GitHub Actions Workflow

`.github/workflows/deploy.yml` — triggered on push to `main`:

1. Checkout repository
2. Log in to GitHub Container Registry (GHCR)
3. Build and push Docker image to `ghcr.io/<org>/claudetainer:latest`
4. Install flyctl via `superfly/flyctl-actions/setup-flyctl`
5. Deploy to Fly.io using the GHCR image

### Required GitHub Secrets

| Secret | Purpose |
|--------|---------|
| `FLY_API_TOKEN` | flyctl authentication for deploy |

Note: GHCR authentication uses the built-in `GITHUB_TOKEN` provided by GitHub Actions.

### Fly Configuration

`fly.toml` in the repo root defines the app name, region, and machine configuration.

## Project File Structure

```
claudetainer/
├── Dockerfile
├── fly.toml
├── .github/
│   └── workflows/
│       └── deploy.yml
├── entrypoint.sh
├── sidecar/
│   └── auth-proxy            # Reverse proxy: injects API keys into requests
├── approval/
│   ├── check-command.sh       # PreToolUse hook script
│   ├── rules.conf             # Configurable allow/approve/block patterns
│   ├── approve                # CLI tool: sends approval requests to daemon
│   └── approval-daemon        # Root-owned daemon: manages approval tokens
├── network/
│   ├── domains.conf           # Domain allowlist (one per line)
│   └── refresh-iptables.sh    # Cron script: re-resolves domains, atomic iptables-restore
├── status                     # CLI tool: shows active approvals, recent blocks, sidecar health
├── seccomp-profile.json       # Seccomp policy (blocks bpf, mount, ptrace, etc.)
└── claude-settings.json       # Claude Code settings template (no secrets)
```

| File | Purpose |
|------|---------|
| `Dockerfile` | Image build: Bun, Python, CLI tools, Claude Code, non-root user, read-only FS |
| `fly.toml` | Fly app config: app name, region, machine size |
| `deploy.yml` | GitHub Action: build → push to GHCR → deploy to Fly |
| `entrypoint.sh` | Container startup: iptables, git config, sidecar, approval daemon, tmux |
| `auth-proxy` | Sidecar: proxies Anthropic API (:4111) and GitHub MCP (:4112), injects keys |
| `check-command.sh` | PreToolUse hook: reads rules.conf, enforces command tiers |
| `rules.conf` | Configurable allow/approve/block regex patterns for Bash commands |
| `approve` | CLI tool: sends approval hash to daemon via Unix socket |
| `approval-daemon` | Root-owned: listens on Unix socket, writes tokens to root-owned directory |
| `domains.conf` | Network allowlist: domains whose IPs are permitted through iptables |
| `refresh-iptables.sh` | Cron job (every 30m): re-resolves domains, atomic `iptables-restore` |
| `status` | CLI tool: shows active approvals, recent blocks, sidecar health |
| `seccomp-profile.json` | Kernel syscall restrictions (blocks bpf, mount, ptrace, etc.) |
| `claude-settings.json` | Claude Code settings template: hook config + MCP servers (no secrets) |

## Observability & Audit Trail

**Hook logging:** All hook decisions (allow, block, approve-required) are logged to stderr with timestamps, the matched rule, and the full command. These are captured by Claude Code's output and visible via `fly logs`.

**iptables logging:** Dropped packets are logged with the prefix `CLAUDETAINER_DROP:` (rate-limited to 5/min to prevent log flooding). Viewable via `fly logs` or `dmesg`.

**Sidecar logging:** All proxied requests are logged to stdout with timestamp, method, path, and response status. Viewable via `fly logs`.

**Approval logging:** The approval daemon logs all approval requests (who approved what, when) to stdout.

**Monitoring command:** Users can run `! status` (a script at `/usr/local/bin/status`) to see: active approval tokens, recent blocked commands, recent iptables drops, sidecar health.

## Operational Security Notes

- **SSH access:** Fly.io org membership controls who can `fly ssh console`. All human sessions connect as root (Fly default), but Claude runs as unprivileged user `claude` in tmux.
- **tmux hygiene:** Users should not type secrets in the Claude tmux session. Tmux scrollback could be read by Claude via `tmux capture-pane` (which is hard-blocked in rules.conf).
- **CI/CD token rotation:** The `FLY_API_TOKEN` GitHub secret should be rotated regularly. If compromised, an attacker can deploy arbitrary images. Consider OIDC federation if Fly supports it.
- **Claude-authored PRs:** All commits use the robot git identity. Require human code review for all merges — no auto-merge. Claude should not be able to modify `.github/workflows/` files (CI configs) — add this path to a block pattern if needed.

## Security Properties Summary

| Threat | Mitigation |
|--------|------------|
| Claude modifies hook/rules/settings | Read-only root filesystem — structurally impossible |
| Claude escalates to root | Non-root user + `no-new-privileges` + capability drop |
| Claude loads eBPF/kernel modules | Seccomp blocks `bpf()`, `mount()` |
| Claude connects to unknown domains | iptables `OUTPUT DROP` default, explicit allowlist |
| Claude exfiltrates via DNS | DNS restricted to trusted resolver, UDP blocked except DNS |
| Claude exfiltrates API keys | Sidecar holds keys, never in Claude's environment or config files |
| Claude exfiltrates GitHub PAT | PAT readable via gh config but scoped to specific repos; gh api/gist blocked; can't reach non-allowlisted domains |
| Claude reads secrets from /proc | No high-value secrets in Claude's environment; Anthropic key fully isolated in sidecar |
| Claude calls sidecar directly (Python/Bun) | Sidecar requires per-session bearer token only known to Claude Code (via settings.json) |
| Claude self-approves via socket | Approval daemon checks `SO_PEERCRED` — rejects UID 1000 (claude), only accepts UID 0 (root) |
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
| Sidecar/daemon/hook killed | Claude lacks capabilities to signal root-owned processes |
| Sidecar compromised | Sidecar validates request paths (only expected API endpoints); rate-limited; logged |
| iptables modified | Claude lacks `CAP_NET_ADMIN` |
| CDN IP rotation breaks allowlist | Background cron re-resolves with atomic `iptables-restore` every 30 minutes |
| Supply chain compromise at build | Version-pinned installs with SHA256 verification; multi-stage Docker build; GHCR scanning |
| Blocked command not visible to user | All hook decisions logged with matched rule; `! status` command for overview |
