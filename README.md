# Codetainer

A hardened Docker container that runs [Claude Code](https://claude.ai/code) on [Fly.io](https://fly.io), accessible via SSH. Designed for long-running, autonomous coding sessions with container hardening and strict network isolation.

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

## Quick Start

### 1. Install Fly CLI and authenticate

```bash
curl -L https://fly.io/install.sh | sh
fly auth login
```

### 2. Set up WireGuard

```bash
fly wireguard create
```

Import the generated config into your WireGuard client. The tunnel must be active whenever you use `fly ssh console`.

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

See [Configuration](docs/configuration.md) for how to create these tokens.

### 5. Run the machine

**Option A: Prebuilt image (fastest)**

```bash
fly machine run ghcr.io/limbic-systems/codetainer:latest \
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

See [Getting Started](docs/getting-started.md) for build-from-source, initialization prompts, and machine sizing.

### 6. Connect

```bash
fly ssh console -a <your-app-name>
```

Claude Code launches automatically in a tmux session. The bottom pane is a shell for running commands directly.

For the full setup guide including prerequisites, WireGuard details, and troubleshooting, see [Getting Started](docs/getting-started.md).

## Documentation

| Document                                   | Covers                                                               |
| ------------------------------------------ | -------------------------------------------------------------------- |
| [Getting Started](docs/getting-started.md) | Prerequisites, Fly setup, WireGuard, machine sizing, troubleshooting |
| [Configuration](docs/configuration.md)     | Secrets, environment variables, Claude Code settings                 |
| [Security](docs/security.md)               | Three-layer security model, domain allowlist                         |
| [Telemetry](docs/telemetry.md)             | Grafana Cloud OTLP setup, privacy controls                           |
| [Architecture](docs/architecture.md)       | Boot sequence, SSH flow, scripts, container layout                   |

## License

MIT
