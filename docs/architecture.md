# Architecture

Internal reference for Codetainer's boot process, scripts, and file layouts.

## Boot Sequence

1. `entrypoint.sh` runs as root (PID 1)
2. Validates `GH_PAT` and `CLAUDE_CODE_OAUTH_TOKEN` are set
3. Mounts tmpfs over `/workspace`, `/tmp`, `/home/claude`
4. Recreates binary symlinks wiped by tmpfs mounts
5. Generates CoreDNS config from domain allowlist, starts CoreDNS
6. Applies iptables rules, starts 5-minute refresh loop
7. Configures git identity, gh CLI auth, npm registry auth
8. Copies Claude Code settings, skips onboarding wizard
9. Remounts root filesystem read-only
10. Clones `REPO_URL` if set
11. Runs readiness checks
12. Starts Claude Code in background (start-claude.sh — installs plugins, creates tmux session)
13. Waits for SSH connections

## SSH Login Flow

1. `fly ssh console` connects to the container as root
2. `.bashrc` runs `attach-claude`
3. If a tmux session exists, attaches to it immediately
4. If initialization is still running, shows boot progress (tail of log) and waits for completion via flock
5. Once init completes, attaches to the tmux session

## Source Repository Layout

```
codetainer/
├── network/                     # Network isolation layer
│   ├── domains.conf             # Domain allowlist (one per line)
│   └── Corefile.template        # CoreDNS base config (catch-all NXDOMAIN)
├── scripts/                     # Runtime scripts (copied into container)
│   ├── entrypoint.sh            # PID 1 boot script (see Boot Sequence)
│   ├── start-claude.sh          # SSH login handler — tmux session manager
│   ├── refresh-iptables.sh      # Resolves allowlisted domains → iptables rules
│   ├── gh-wrapper.sh            # gh CLI wrapper ensuring GH_CONFIG_DIR is set
│   ├── session-namer.sh         # Stop hook — renames tmux session via Haiku
│   ├── statusline-command.sh    # Status line — model, context usage bar, session
│   └── status.sh                # Diagnostic tool (iptables drops, CoreDNS status)
├── docs/
│   └── accepted-risks.md        # Panel-reviewed accepted risk registry
├── .github/
│   └── workflows/
│       └── build.yml            # CI — builds and pushes image to GHCR
├── Dockerfile                   # Multi-stage container build (Debian bookworm-slim)
├── claude-settings.json         # Claude Code runtime settings template
├── CLAUDE.md                    # Project instructions for Claude Code
├── LICENSE                      # MIT
└── README.md
```

## Scripts

All scripts live in `scripts/` and are copied to `/usr/local/bin/` during the Docker build.

| Script                      | Description                                                                                                                                                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`entrypoint.sh`**         | PID 1 boot script. Runs as root. Validates secrets, mounts tmpfs, starts CoreDNS, applies iptables, configures git/gh/npm auth, installs plugins, remounts rootfs read-only, clones the repo, and runs readiness checks. See [Boot Sequence](#boot-sequence) for the full order.     |
| **`start-claude.sh`**       | Init-only boot script (invoked by `entrypoint.sh`). Acquires exclusive flock, waits for readiness, writes `CLAUDE_PROMPT` to temp file (if set), installs plugins, creates tmux session with Claude Code (top pane, 80%) and bash shell (bottom pane, 20%). Releases lock when done. |
| **`attach-claude.sh`**      | SSH login handler (invoked by `.bashrc`). If a tmux session exists, attaches immediately. Otherwise, waits for `start-claude.sh` to complete via shared flock (5-min timeout), tailing the boot log for progress, then attaches.                                                     |
| **`refresh-iptables.sh`**   | Resolves every domain in `network/domains.conf` to IPs via `dig`, builds an iptables ruleset with OUTPUT DROP default policy and ACCEPT rules for resolved IPs, then atomically applies it with `iptables-restore`. Called once at boot and every 5 minutes thereafter.              |
| **`gh-wrapper.sh`**         | Thin wrapper around `/usr/bin/gh` that hardcodes `GH_CONFIG_DIR=/opt/gh-config`. Needed because Claude Code's subprocess chain can strip environment variables, which would break `gh` authentication. Installed as `/usr/local/bin/gh` to shadow the real binary.                   |
| **`session-namer.sh`**      | Claude Code Stop hook. After the first assistant response in a session, sends the session context to Haiku to generate a short kebab-case name (e.g., `fixing-auth-bug`), then renames the tmux session. Uses a sentinel file to run only once per session.                          |
| **`statusline-command.sh`** | Claude Code status line hook. Renders the current model name, a context window usage bar (color-coded green/yellow/red), and the tmux session name. Output appears in Claude Code's status line.                                                                                     |
| **`status.sh`**             | Diagnostic tool available as the `status` command inside the container. Shows recent iptables drops (from dmesg) and CoreDNS process status.                                                                                                                                         |

## Container File Layout

```
/usr/local/bin/
├── claude            # Claude Code binary
├── bun               # Bun runtime
├── bunx              # Bun package runner
├── coredns           # DNS server
├── fly               # Fly.io CLI
├── gh                # gh-wrapper.sh (shadows /usr/bin/gh)
├── attach-claude     # SSH attach gate (attach-claude.sh)
├── start-claude      # Init-only boot script (start-claude.sh)
├── status            # Diagnostic tool (status.sh)
├── just              # Task runner
└── entrypoint.sh     # Boot script

/opt/
├── network/
│   ├── domains.conf         # Domain allowlist
│   ├── Corefile.template    # CoreDNS base config
│   └── refresh-iptables.sh  # iptables refresh script
├── claude/
│   ├── settings.json        # Claude Code settings template
│   ├── statusline-command.sh  # Status line hook
│   └── session-namer.sh      # Session naming hook
└── gh-config/               # Shared gh CLI config (created at runtime)

/workspace/              # tmpfs, 512MB — working directory
└── repo/                # Cloned from REPO_URL (if set)

/home/claude/            # tmpfs, 1GB — claude user home
├── .claude/
│   └── settings.json    # Hook config (claude-owned, deletable — accepted risk)
├── .claude.json         # Onboarding bypass
├── .npmrc               # GitHub Packages auth
├── .local/bin/claude    # Symlink → /usr/local/bin/claude
└── .bun/bin/            # Symlinks → /usr/local/bin/bun{,x}

```

## CI/CD

The GitHub Actions workflow (`.github/workflows/build.yml`) builds and pushes the container image to GHCR on every push to `main`:

```
ghcr.io/limbic-systems/codetainer:latest
```
