# Claudetainer

A hardened Docker container that runs [Claude Code](https://claude.ai/code) on [Fly.io](https://fly.io), accessible via SSH. Designed for long-running, autonomous coding sessions with three layers of security: container hardening, network isolation, and command-level approval gates.

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
│  └── read-only root filesystem                      │
│                                                     │
│  On SSH login:                                      │
│  └── start-claude → tmux session                    │
│      ├── Claude Code (top pane, 80%)                │
│      └── Terminal shell (bottom pane, 20%)          │
└─────────────────────────────────────────────────────┘
```

When you SSH in, `start-claude` runs automatically. It creates a tmux session with Claude Code in the top pane and a shell in the bottom pane. Subsequent SSH sessions reattach to the same tmux session.

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

**How to create one:**

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

## Environment Variables

These are set via `--env` flags on `fly machine run`. They are not sensitive and don't need to be secrets.

| Variable | Required | Default | Description |
|---|---|---|---|
| `GIT_USER_NAME` | No | `claudetainer` | Git commit author name |
| `GIT_USER_EMAIL` | No | `claudetainer@noreply.github.com` | Git commit author email |
| `REPO_URL` | No | _(none)_ | HTTPS URL of a GitHub repo to clone on startup. Cloned to `/workspace/repo`. Must be accessible with the `GH_PAT`. |

## Usage

### Connecting

```bash
# First connection (creates tmux session, installs plugins, launches Claude Code)
fly ssh console -a <your-app-name>

# Subsequent connections (reattaches to existing tmux session)
fly ssh console -a <your-app-name>
```

### tmux Layout

The session has two panes:

- **Top (80%)**: Claude Code
- **Bottom (20%)**: A bash shell in the working directory

Switch panes with `Ctrl-b ↓` / `Ctrl-b ↑` or click with the mouse.

### Approving Commands

Claude Code runs with `--dangerously-skip-permissions` but has a PreToolUse hook that enforces a three-tier command classification pipeline:

- **Tier 1 — Hard-block** (instant): Dangerous commands that are never allowed (sudo, eval, rm -rf /, git push --force, credential leaks, etc.)
- **Tier 2 — Hot-word scan** (instant): If the command contains a risky keyword (curl, bun add, pip install, etc.), escalate to Tier 3. Otherwise, allow.
- **Tier 3 — Haiku classification** (1-3s): A Haiku LLM classifies the command as allow, block, or approve. For approve, Claude Code's native permission prompt is shown to the user.

When Claude tries to run a command that requires approval, Claude Code shows its built-in permission dialog. You can approve or deny directly in the CLI — no external commands needed.

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

## Security Model

### Layer 1: Container Hardening

- **Non-root execution**: Claude Code runs as user `claude` (UID 1000), not root
- **Read-only root filesystem**: After setup, the root filesystem is remounted read-only (`mount -o remount,ro /`)
- **tmpfs mounts**: Writable areas are memory-backed and size-limited:
  - `/workspace` (512MB) — working directory for code
  - `/home/claude` (256MB) — Claude's home directory
  - `/tmp` (128MB) — temporary files
- **Immutable settings**: Claude Code's `settings.json` (which configures the approval hook) is root-owned and mode 644. Claude can read it but cannot modify the hook configuration. Claude _can_ delete and recreate it (accepted risk — iptables is the real enforcement layer).

### Layer 2: Network Isolation

- **Default-deny outbound**: iptables OUTPUT policy is DROP
- **Domain allowlist**: Only traffic to resolved IPs from `network/domains.conf` is permitted
- **DNS filtering**: CoreDNS returns NXDOMAIN for any domain not in the allowlist, preventing DNS-based data exfiltration
- **IPv4 only**: AAAA queries return empty (NOERROR) to force IPv4, where iptables rules apply
- **Metadata blocked**: Cloud instance metadata (169.254.0.0/16) and Fly private networking (172.16.0.0/12) are explicitly dropped
- **UDP dropped**: All outbound UDP except DNS is dropped (prevents QUIC bypass of TCP-level controls)
- **30-minute refresh**: iptables rules are refreshed every 30 minutes to pick up IP changes
- **IPv6 unrestricted**: Fly SSH requires public IPv6 routing, and Fly's kernel has broken IPv6 conntrack, so IPv6 output is left at ACCEPT. IPv4 iptables is the enforcement layer.

### Layer 3: Command Classification

- **PreToolUse hook**: Every Bash tool invocation passes through a compiled TypeScript classifier
- **Three-tier pipeline**: Hard-block (regex) → hot-word scan (substring) → Haiku LLM classification (Anthropic SDK)
- **Default-allow posture**: Commands without hot words are allowed (network layer is primary enforcement)
- **Native approval UX**: Haiku's "approve" verdict triggers Claude Code's built-in permission prompt — no custom token system
- **Credential leak prevention**: Direct references to `$GH_PAT`, `$CLAUDE_CODE_OAUTH_TOKEN`, `$ANTHROPIC_API_KEY` are hard-blocked; indirect references (variable names as strings) are escalated to Haiku

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

| Size | Memory | Use Case |
|---|---|---|
| `shared-cpu-1x` / 1GB | Minimum | Small repos, light tasks |
| `shared-cpu-1x` / 2GB | Recommended | General development |
| `shared-cpu-2x` / 4GB | Heavy | Large repos, parallel builds |

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
6. Applies iptables rules, starts 30-minute refresh loop
7. Configures git identity, gh CLI auth, npm registry auth
8. Copies Claude Code settings, skips onboarding wizard
9. Remounts root filesystem read-only
10. Clones `REPO_URL` if set
11. Sleeps forever, waiting for SSH connections

### SSH Login Flow

1. `fly ssh console` connects to the container as root
2. `.bashrc` runs `start-claude`
3. If a tmux session exists, reattaches to it
4. Otherwise: verifies auth token, installs plugins, creates tmux session with Claude Code + terminal pane, attaches

### File Layout (in container)

```
/usr/local/bin/
├── claude          # Claude Code binary
├── bun             # Bun runtime
├── bunx            # Bun package runner
├── coredns         # DNS server
├── start-claude    # SSH login handler
├── status          # Diagnostic tool
├── just            # Task runner
└── entrypoint.sh   # Boot script

/opt/
├── approval/
│   ├── check-command      # Compiled classifier binary (bun build --compile)
│   ├── check-command.sh   # Thin wrapper that execs the binary
│   └── rules.conf         # Block/hot-word rules
├── network/
│   ├── domains.conf       # Domain allowlist
│   ├── Corefile.template  # CoreDNS base config
│   └── refresh-iptables.sh
├── claude/
│   └── settings.json      # Claude Code settings template
└── gh-config/             # Shared gh CLI config (created at runtime)

/workspace/              # tmpfs, 512MB — working directory
└── repo/                # Cloned from REPO_URL (if set)

/home/claude/            # tmpfs, 256MB — claude user home
├── .claude/
│   └── settings.json    # Root-owned, immutable hook config
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

## License

MIT
