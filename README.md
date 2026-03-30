# Claudetainer

A hardened Docker container that runs [Claude Code](https://claude.ai/code) on [Fly.io](https://fly.io), accessible via SSH. Designed for long-running, autonomous coding sessions with three layers of security: container hardening, strict network isolation, and a command classifier/approval gate system for dangerous commands.

> Quick note, this project is intended for me and my colleagues. If you find this useful, I recommend you fork it and make it your own. I'm not interested in making this general purpose. Think of this repo as "source available." If you spot a bug, of course I'd love to hear about that. Otherwise, have fun with it and make it your own.

## How It Works

```
You (local machine)
  │
  │  fly ssh console
  │
  ▼
┌─────────────────────────────────────────────────────┐
│  Fly.io Firecracker VM                              │
│                                                     │
│  entrypoint.sh (PID 1, root)                        │
│  ├── CoreDNS (domain allowlist DNS)                 │
│  ├── iptables (OUTPUT DROP + IP allowlist)          │
│  ├── tmpfs mounts (/workspace, /home/claude, /tmp)  │
│  ├── read-only root filesystem                      │
│  └── start-claude → tmux session (at boot)          │
│      ├── Claude Code (top pane, 80%)                │
│      └── Terminal shell (bottom pane, 20%)          │
│                                                     │
│  On SSH login:                                      │
│  └── attach-claude → attaches to tmux session       │
└─────────────────────────────────────────────────────┘
```

Claude Code starts automatically at boot inside a tmux session. When you SSH in, `attach-claude` connects you to the already-running session. Subsequent SSH sessions reattach to the same tmux session.

## Prerequisites

- [Fly.io account](https://fly.io) with the `flyctl` CLI installed
- A **dedicated GitHub robot account** for Claude (e.g. `my-org-claude-bot`). Create a standard GitHub account for this purpose — Claude will commit and open PRs as this identity. Add it as a collaborator to the repo you want Claude to work in.
- A [fine-grained Personal Access Token](#gh_pat-required) created on the robot account, scoped to the target repo
- A [Claude Code OAuth token](#claude_code_oauth_token-required) generated via `claude setup-token`

## Quick Start

### 1. Install Fly CLI and authenticate

```bash
# Install flyctl
curl -L https://fly.io/install.sh | sh

# Log in
fly auth login
```

### 2. Set up WireGuard (required for SSH)

Fly.io SSH uses WireGuard tunneling. You need to set this up once per machine you'll connect from.

```bash
# Create a WireGuard peer configuration
fly wireguard create

# This outputs a WireGuard config file. Import it into your WireGuard client:
#   - macOS: WireGuard app from the Mac App Store → Import Tunnel
#   - Linux: sudo cp <config>.conf /etc/wireguard/ && sudo wg-quick up <config>
#   - Windows: WireGuard app → Import Tunnel

# Verify the tunnel is working
fly wireguard status
```

> **Important**: The WireGuard tunnel must be active whenever you use `fly ssh console`. If SSH hangs or times out, check that your WireGuard tunnel is connected.

### 3. Create the Fly app

```bash
fly apps create <your-app-name>
```

### 4. Set secrets

```bash
fly secrets set \
  GH_PAT=<your-github-pat> \
  CLAUDE_CODE_OAUTH_TOKEN=<your-oauth-token> \
  -a <your-app-name>
```

See [Secrets Reference](#secrets) below for details on obtaining these values.

### 5. Run the machine

Pick the [Fly.io region](https://fly.io/docs/reference/regions/) closest to you for the `--region` flag (e.g. `sjc`, `iad`, `lhr`).

**Option A: Prebuilt image (fastest)**

```bash
fly machine run ghcr.io/perezd/claudetainer:latest \
  --app <your-app-name> \
  --region <your-region> \
  --restart no \
  --autostart=false \
  --vm-memory 1024 \
  --vm-size shared-cpu-1x \
  --env GIT_USER_NAME="my-robot" \
  --env GIT_USER_EMAIL="my-robot@users.noreply.github.com" \
  --env REPO_URL="https://github.com/your-org/your-repo"
```

To give Claude an immediate task, add an initialization prompt:

```bash
fly machine run ghcr.io/perezd/claudetainer:latest \
  --app <your-app-name> \
  --region <your-region> \
  --restart no \
  --autostart=false \
  --vm-memory 1024 \
  --vm-size shared-cpu-1x \
  --env GIT_USER_NAME="my-robot" \
  --env GIT_USER_EMAIL="my-robot@users.noreply.github.com" \
  --env REPO_URL="https://github.com/your-org/your-repo" \
  --env CLAUDE_PROMPT="https://github.com/your-org/your-repo/issues/42"
```

Claude will begin working on the prompt as soon as the container is ready, before you SSH in. When you connect, you'll attach to the in-progress session.

**Option B: Build from Dockerfile (customizable)**

If you want to customize the image (e.g. change installed tools, approval rules, or network allowlists), clone the repo and build directly:

```bash
git clone https://github.com/perezd/claudetainer.git
cd claudetainer

fly machine run . --dockerfile Dockerfile \
  --app <your-app-name> \
  --region <your-region> \
  --restart no \
  --autostart=false \
  --vm-memory 1024 \
  --vm-size shared-cpu-1x \
  --env GIT_USER_NAME="my-robot" \
  --env GIT_USER_EMAIL="my-robot@users.noreply.github.com" \
  --env REPO_URL="https://github.com/your-org/your-repo"
```

This builds the image remotely on Fly.io's builders and deploys it in one step. The first build takes a few minutes; subsequent builds are cached.

### 6. Connect

```bash
fly ssh console -a <your-app-name>
```

Claude Code launches automatically in a tmux session. The bottom pane is a shell for running commands directly.

## Secrets

These are set via `fly secrets set` and are required for the container to start.

### `GH_PAT` (required)

A [GitHub fine-grained Personal Access Token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token). This authenticates all git operations, the `gh` CLI, and npm access to GitHub Packages.

This token should be created on the **robot GitHub account** (not your personal account). It acts as the identity boundary for what Claude can do on GitHub — scoped to exactly the repository you want Claude to work in, no broader.

Fine-grained tokens are recommended when the target repo belongs to a GitHub **organization** the robot account is a member of. However, fine-grained tokens have a [known limitation](https://github.com/community/community/discussions/36441): they can only access repos owned by the token creator's own account or by an org they belong to. They **cannot** access repos owned by another user's personal account. If the robot account is a collaborator on a repo owned by someone else's personal account (not an org), you'll need a [classic Personal Access Token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-personal-access-token-classic) instead. Classic tokens must have at minimum the `read:org`, `read:packages`, and `repo` scopes.

**How to create a fine-grained token (recommended):**

1. Log into the robot GitHub account and go to [github.com/settings/tokens](https://github.com/settings/tokens?type=beta). Click **Generate new token** (fine-grained)
2. Give it a descriptive name (e.g. `claudetainer - my-repo`)
3. Under **Resource owner**, select the org or user that owns the repo
4. Under **Repository access**, select **Only select repositories** and pick the single repo you want Claude to work in
5. Under **Repository permissions**, grant exactly these:
   - **Contents**: Read and write — clone, commit, push, create branches
   - **Pull requests**: Read and write — create and update PRs
   - **Issues**: Read and write — create and update issues
   - **Actions**: Read — check CI/workflow status
   - **Metadata**: Read — required by GitHub for all fine-grained tokens
6. Leave all other permissions at **No access**. Specifically do **not** grant: Administration, Workflows (write), Packages, Pages, Secrets, Environments, or Deployments
7. Click **Generate token** and copy it immediately (you won't see it again)

```bash
fly secrets set GH_PAT=ghp_xxxxxxxxxxxx -a <your-app-name>
```

### `CLAUDE_CODE_OAUTH_TOKEN` (required)

A long-lived OAuth token for Claude Code headless authentication. This allows Claude Code to start without an interactive login flow.

Generate this on your local machine using the Claude Code CLI (you must already be logged in locally):

```bash
claude setup-token
```

This prints a token to stdout. Copy it and set it as a Fly secret:

```bash
fly secrets set CLAUDE_CODE_OAUTH_TOKEN=<token> -a <your-app-name>
```

### Grafana Cloud Telemetry (optional)

These three secrets enable optional OpenTelemetry export to Grafana Cloud. All three must be set to activate the feature — if any is missing, telemetry is off and there is zero outbound traffic to Grafana.

#### `GRAFANA_INSTANCE_ID`

Your Grafana Cloud instance ID (numeric). Find it in the Grafana Cloud portal under your stack's OTLP configuration.

#### `GRAFANA_API_TOKEN`

A Grafana Cloud Access Policy token with OTLP push (write) permissions. Create one in the Grafana Cloud portal under **Security → Access Policies**. The token needs the `metrics:write`, `logs:write`, and `traces:write` scopes.

#### `GRAFANA_OTLP_ENDPOINT`

The full OTLP gateway URL for your Grafana Cloud stack. Format: `https://otlp-gateway-prod-<region>.grafana.net/otlp`. Find the exact URL in the Grafana Cloud portal under your stack's OTLP configuration.

```bash
fly secrets set \
  GRAFANA_INSTANCE_ID=<your-instance-id> \
  GRAFANA_API_TOKEN=<your-token> \
  GRAFANA_OTLP_ENDPOINT=https://otlp-gateway-prod-us-west-2.grafana.net/otlp \
  -a <your-app-name>
```

See [Telemetry](#telemetry-optional) below for what gets exported and privacy controls.

## Environment Variables

These are set via `--env` flags on `fly machine run`. They are not sensitive and don't need to be secrets.

| Variable                   | Required | Default                           | Description                                                                                                                                                                                                                                         |
| -------------------------- | -------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GIT_USER_NAME`            | No       | `claudetainer`                    | Git commit author name. **Must match the GitHub username/login** (not a display name) for the git push ownership exemption to work.                                                                                                                 |
| `GIT_USER_EMAIL`           | No       | `claudetainer@noreply.github.com` | Git commit author email                                                                                                                                                                                                                             |
| `REPO_URL`                 | No       | _(none)_                          | HTTPS URL of a GitHub repo to clone on startup. Cloned to `/workspace/repo`. Must be accessible with the `GH_PAT`.                                                                                                                                  |
| `CLAUDE_PROMPT`            | No       | _(none)_                          | Initialization prompt for Claude Code. When set, Claude immediately begins working on this prompt at boot. Typically a GitHub issue URL (e.g., `https://github.com/org/repo/issues/42`). Visible via `fly machine status` — do not include secrets. |
| `OTEL_LOG_USER_PROMPTS`    | No       | `1`                               | Set to `0` to exclude user prompt content from telemetry events (only prompt length is recorded). Requires Grafana Cloud telemetry to be enabled.                                                                                                   |
| `OTEL_LOG_TOOL_DETAILS`    | No       | `1`                               | Set to `0` to exclude tool parameters from telemetry events (only tool name is recorded). Requires Grafana Cloud telemetry to be enabled.                                                                                                           |
| `OTEL_RESOURCE_ATTRIBUTES` | No       | _(auto: Fly identity)_            | Comma-separated `key=value` pairs added to all metrics and events. `fly.app_name` and `fly.machine_id` are auto-injected; operator values are appended. Requires Grafana Cloud telemetry to be enabled.                                             |

## Usage

### Connecting

```bash
# Claude starts automatically at boot — SSH attaches to the running session
fly ssh console -a <your-app-name>

# If Claude is still initializing, you'll see boot progress until it's ready
```

### tmux Layout

The session has two panes:

- **Top (80%)**: Claude Code
- **Bottom (20%)**: A bash shell in the working directory

Switch panes with `Ctrl-b ↓` / `Ctrl-b ↑` or click with the mouse.

### Approving Commands

Claude Code runs with `--dangerously-skip-permissions` but has a PreToolUse hook that enforces a three-tier command classification pipeline:

- **Tier 1 — Hard-block** (instant): Dangerous commands that are never allowed (sudo, eval, rm -rf /, git push --force, credential leaks, etc.). **Exception:** `git push` to a remote owned by `GIT_USER_NAME` (your fork) is allowed, including force push and push to main — but `--delete` remains blocked. `GIT_USER_NAME` must match the GitHub owner in the remote URL. Compound commands containing `git push` are not exempted and fall through to normal block rules.
- **Tier 2 — Hot-word scan** (instant): If the command contains a risky keyword (curl, bun add, pip install, etc.), escalate to Tier 3. Otherwise, allow.
- **Tier 3 — Haiku classification** (1-3s): A Haiku LLM classifies the command as allow, block, or approve. For approve, Claude Code's native permission prompt is shown to the user.

When Claude tries to run a command that requires approval, Claude Code shows its built-in permission dialog. You can approve or deny directly in the CLI — no external commands needed.

**Fly.io commands:** Simple read-only fly commands (`fly status`, `fly logs`, `fly releases`) pass through without Haiku review. Commands involving infrastructure subcommands (`fly apps`, `fly machine`, `fly scale`, etc.) are escalated to Haiku, which classifies read-only operations (e.g., `fly apps list`) as allow and mutating operations (e.g., `fly deploy`) as approve. `fly auth`, `fly tokens`, `fly ssh`, `fly proxy`, `fly sftp`, and `fly console` are hard-blocked — authenticate via `! fly auth login` in the terminal pane.

### Status and Diagnostics

```bash
# Show recent iptables drops, CoreDNS status
status
```

### Stopping the Machine

```bash
# Graceful stop
fly machine stop <machine-id> -a <your-app-name>

# List machines to find the ID
fly machine list -a <your-app-name>
```

The machine is configured with `--restart no` and `--autostart=false`, so it stays stopped until you explicitly run a new one.

## Telemetry (Optional)

Claudetainer can export Claude Code's native OpenTelemetry metrics and events to [Grafana Cloud](https://grafana.com/products/cloud/) via direct OTLP push. This gives you dashboards for token usage, costs, session activity, and full prompt-level event traces — all in Grafana.

The feature is **opt-in** and **disabled by default**. It activates only when all three Grafana Cloud secrets are set (`GRAFANA_INSTANCE_ID`, `GRAFANA_API_TOKEN`, `GRAFANA_OTLP_ENDPOINT`). When off, there is zero telemetry, zero outbound traffic, and no behavior change.

### What gets exported

**Metrics** (→ Grafana Mimir):

- Active usage time, session count
- API request token counts and cost (input, output, cache creation, cache read)
- Lines of code added/removed
- Pull requests and commits created

**Events** (→ Grafana Loki):

- `user_prompt` — emitted per user prompt (content included by default, opt-out with `OTEL_LOG_USER_PROMPTS=0`)
- `api_request` — emitted per API call (model, tokens, cost)
- `tool_result` — emitted per tool execution (tool name, parameters; opt-out details with `OTEL_LOG_TOOL_DETAILS=0`)

All events from a single user prompt share a `prompt.id` for correlation.

### Privacy controls

When telemetry is enabled, **full fidelity is the default** — prompt content and tool parameters are included. The rationale: if you've provided Grafana Cloud credentials, you want full observability.

To reduce fidelity, set these as env vars on the Fly machine:

```bash
fly machine run ... \
  --env OTEL_LOG_USER_PROMPTS=0 \
  --env OTEL_LOG_TOOL_DETAILS=0
```

With `OTEL_LOG_USER_PROMPTS=0`, only prompt length is recorded (not content). With `OTEL_LOG_TOOL_DETAILS=0`, only tool names are recorded (not parameters). Raw file contents are never included regardless of settings.

**Data residency note:** When enabled, telemetry data (including prompt content if not opted out) leaves the container and is stored in Grafana Cloud. You are responsible for ensuring this meets your data residency and privacy requirements.

### Resource attributes

All metrics and events are tagged with resource attributes for filtering and grouping in Grafana dashboards.

**Auto-injected** (always present when telemetry is enabled):

- `fly.app_name` — from the Fly VM's `FLY_APP_NAME` env var
- `fly.machine_id` — from the Fly VM's `FLY_MACHINE_ID` env var

**Custom attributes** — add your own via the `OTEL_RESOURCE_ATTRIBUTES` env var:

```bash
fly machine run ... \
  --env OTEL_RESOURCE_ATTRIBUTES="department=engineering,team.id=platform,cost_center=eng-123"
```

The auto-injected Fly attributes and your custom attributes are merged. If you set a key that conflicts with an auto-injected one, your value wins (last-write-wins).

Values must not contain spaces. Use underscores or camelCase instead (e.g., `team.name=my_team`).

### How it works

The feature uses a two-phase activation in the entrypoint:

1. **Phase 1** (before network setup): Extracts the OTLP gateway hostname from `GRAFANA_OTLP_ENDPOINT` and dynamically adds it to CoreDNS and iptables — no static domain allowlist changes needed.
2. **Phase 2** (after auth setup): Writes OTEL configuration to a root-only file that `start-claude.sh` forwards to the Claude Code process.

No new binaries, no collector sidecar, no Dockerfile changes. Claude Code's built-in OTLP exporter handles everything.

## Security Model

### Layer 1: Container Hardening

- **Non-root execution**: Claude Code runs as user `claude` (UID 1000), not root
- **Read-only root filesystem**: After setup, the root filesystem is remounted read-only (`mount -o remount,ro /`)
- **tmpfs mounts**: Writable areas are memory-backed and size-limited:
  - `/workspace` (512MB) — working directory for code
  - `/home/claude` (1GB) — Claude's home directory
  - `/tmp` (128MB) — temporary files
- **Settings file**: Claude Code's `settings.json` (which configures the approval hook) is owned by the `claude` user. Claude can delete and recreate it, which would remove the hook. This is an accepted risk — iptables is the real enforcement layer, and the hook provides defense-in-depth.

### Layer 2: Network Isolation

- **Default-deny outbound**: iptables OUTPUT policy is DROP
- **Domain allowlist**: Only traffic to resolved IPs from `network/domains.conf` is permitted
- **DNS filtering**: CoreDNS returns NXDOMAIN for any domain not in the allowlist, preventing DNS-based data exfiltration
- **IPv4 only**: AAAA queries return empty (NOERROR) to force IPv4, where iptables rules apply
- **Metadata blocked**: Cloud instance metadata (169.254.0.0/16) and Fly private networking (172.16.0.0/12) are explicitly dropped
- **UDP dropped**: All outbound UDP except DNS is dropped (prevents QUIC bypass of TCP-level controls)
- **5-minute refresh**: iptables rules are refreshed every 5 minutes to pick up IP changes
- **IPv6 unrestricted**: Fly SSH requires public IPv6 routing, and Fly's kernel has broken IPv6 conntrack, so IPv6 output is left at ACCEPT. IPv4 iptables is the enforcement layer.

### Layer 3: Command Classification

- **PreToolUse hook**: Every Bash tool invocation passes through a compiled TypeScript classifier
- **Three-tier pipeline**: Hard-block (regex) → hot-word scan (substring) → Haiku LLM classification (via `claude -p` CLI subprocess)
- **Default-allow posture**: Commands without hot words are allowed (network layer is primary enforcement)
- **Native approval UX**: Haiku's "approve" verdict triggers Claude Code's built-in permission prompt — no custom token system
- **Git push ownership exemption**: Before tier evaluation, `git push` commands are checked against the remote URL. If the GitHub owner in the remote matches `GIT_USER_NAME` (case-insensitive), the push is allowed — enabling the fork-branch-PR workflow. `--delete` pushes remain blocked even on owned remotes. Falls through to normal tier evaluation (no exemption) on any error.
- **Credential leak prevention**: Direct references to `$GH_PAT` and `$CLAUDE_CODE_OAUTH_TOKEN` are hard-blocked; indirect references (variable names as strings) are escalated to Haiku
- **Fly.io auth blast radius**: Fly tokens are org-scoped (unlike the fine-grained GH_PAT). An authenticated session grants access to ALL apps in the org. Use short-lived tokens (`fly tokens create --expiry 1h`) or a dedicated Fly org.

## Customization

### Changing the Domain Allowlist

Edit `network/domains.conf` to add or remove allowed domains. One domain per line, `#` comments supported. Rebuild and redeploy the container.

### Changing Command Approval Rules

Edit `approval/rules.conf`. Three rule types: `block:` (word-boundary regex, instant deny), `block-pattern:` (full regex, instant deny), and `hot:` (substring match, escalates to Haiku). If no rule matches, the command is allowed.

### Changing the Claude Code Model

Edit `claude-settings.json` and change the `model` field. Default is `claude-opus-4-6`.

### Adding MCP Servers

Edit `claude-settings.json` to add entries under `mcpServers`. The default configuration includes a Bun documentation server.

### Machine Sizing

| Size                  | Memory      | Use Case                     |
| --------------------- | ----------- | ---------------------------- |
| `shared-cpu-1x` / 1GB | Minimum     | Small repos, light tasks     |
| `shared-cpu-1x` / 2GB | Recommended | General development          |
| `shared-cpu-2x` / 4GB | Heavy       | Large repos, parallel builds |

```bash
fly machine run ghcr.io/perezd/claudetainer:latest \
  --vm-memory 2048 \
  --vm-size shared-cpu-2x \
  ...
```

## Architecture

### Boot Sequence

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

### SSH Login Flow

1. `fly ssh console` connects to the container as root
2. `.bashrc` runs `attach-claude`
3. If a tmux session exists, attaches to it immediately
4. If initialization is still running, shows boot progress (tail of log) and waits for completion via flock
5. Once init completes, attaches to the tmux session

### Source Repository Layout

```
claudetainer/
├── approval/                    # Command approval pipeline (TypeScript)
│   ├── __tests__/               # Unit tests (bun test)
│   │   ├── classifier.test.ts
│   │   ├── ownership.test.ts
│   │   ├── rules.test.ts
│   │   └── tiers.test.ts
│   ├── check-command.ts         # Entrypoint — PreToolUse hook handler
│   ├── classifier.ts            # Tier 3 Haiku LLM classifier
│   ├── hook-output.ts           # Hook response formatting
│   ├── rules.ts                 # Rule parser (block, block-pattern, hot)
│   ├── rules.conf               # Block/hot-word rule definitions
│   ├── package.json
│   ├── tsconfig.json
│   └── bun.lock
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

### Scripts

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

### File Layout (in container)

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
├── approval/
│   ├── check-command        # Compiled classifier binary (bun build --compile)
│   └── rules.conf           # Block/hot-word rules
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
ghcr.io/perezd/claudetainer:latest
```

The GHCR package must be set to **public** visibility so Fly.io can pull it without registry credentials. To set this, go to the GitHub repo → Packages → `claudetainer` → Package settings → Change visibility → Public.

## Troubleshooting

### SSH hangs or times out

Check that your WireGuard tunnel is active:

```bash
fly wireguard status
```

If it's disconnected, bring it back up through your WireGuard client.

If your network blocks UDP (common on corporate networks, captive portals, or some ISPs), WireGuard tunnels will fail silently. Switch to WebSocket-based tunneling:

```bash
fly wireguard websockets enable
```

This wraps WireGuard traffic in a WebSocket over TCP/443, which passes through most firewalls. To revert:

```bash
fly wireguard websockets disable
```

### "CLAUDE_CODE_OAUTH_TOKEN is not set"

The secret wasn't set or the machine needs a restart after setting secrets:

```bash
fly secrets set CLAUDE_CODE_OAUTH_TOKEN=<token> -a <your-app-name>
fly machine restart <machine-id> -a <your-app-name>
```

### "Missing required secrets: GH_PAT"

Same as above — set the secret and restart.

### Claude Code shows a sign-in prompt

The OAuth token may be expired. Generate a new one:

```bash
claude setup-token
fly secrets set CLAUDE_CODE_OAUTH_TOKEN=<new-token> -a <your-app-name>
```

### Git clone fails

- Verify `REPO_URL` is an HTTPS URL (not SSH)
- Verify the `GH_PAT` has Contents read access to the repository
- Check the entrypoint logs: `fly logs -a <your-app-name>`

### Plugin installation fails

The superpowers plugin is installed on first SSH login. If it fails, check:

- Network connectivity (the container needs to reach github.com)
- `status` command to see if CoreDNS is running and no unexpected drops

### Command blocked unexpectedly

Check which rule matched by reviewing the hook's stderr logs, or inspect the rules directly:

```bash
grep -n 'pattern' /opt/approval/rules.conf
```

If a command is blocked by Tier 1 (hard-block), it cannot be overridden. If it's escalated to Tier 3 (Haiku), the user will see a permission prompt and can approve or deny.

### UI rendering issues

The container builds tmux 3.6a from source for synchronized output support. If you still see rendering artifacts:

- Ensure your local terminal supports true color (`echo $COLORTERM` should show `truecolor`)
- Try resizing your terminal window after connecting
- Ghostty, iTerm2, and Kitty work best; macOS Terminal.app has limited support

### Fly.io authentication

flyctl is not authenticated by default. To authenticate:

```bash
# In the terminal pane or via ! in Claude Code
! fly auth login
```

The token is stored in memory (tmpfs) and lost on restart.

## License

MIT
