# Getting Started

Complete guide to setting up and running Codetainer on Fly.io.

## Prerequisites

- [Fly.io account](https://fly.io) with the `flyctl` CLI installed
- A **dedicated GitHub robot account** for Claude (e.g. `my-org-claude-bot`). Create a standard GitHub account for this purpose — Claude will commit and open PRs as this identity. Add it as a collaborator to the repo you want Claude to work in.
- A [GitHub Personal Access Token](configuration.md#gh_pat-required) created on the robot account, scoped to the target repo
- A Claude Code OAuth token generated via `claude setup-token`

## 1. Install Fly CLI and authenticate

```bash
# Install flyctl
curl -L https://fly.io/install.sh | sh

# Log in
fly auth login
```

## 2. Set up WireGuard (required for SSH)

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

## 3. Create the Fly app

```bash
fly apps create <your-app-name>
```

## 4. Set secrets

```bash
fly secrets set \
  GH_PAT=<your-github-pat> \
  CLAUDE_CODE_OAUTH_TOKEN=<your-oauth-token> \
  -a <your-app-name>
```

See [Configuration](configuration.md) for the full secrets reference — what each token is, how to create them, and fine-grained vs. classic token guidance.

## 5. Run the machine

Pick the [Fly.io region](https://fly.io/docs/reference/regions/) closest to you for the `--region` flag (e.g. `sjc`, `iad`, `lhr`).

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

To give Claude an immediate task, add an initialization prompt:

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
  --env REPO_URL="https://github.com/your-org/your-repo" \
  --env CLAUDE_PROMPT="https://github.com/your-org/your-repo/issues/42"
```

Claude will begin working on the prompt as soon as the container is ready, before you SSH in. When you connect, you'll attach to the in-progress session.

**Option B: Build from Dockerfile (customizable)**

If you want to customize the image (e.g. change installed tools or network allowlists), clone the repo and build directly:

```bash
git clone https://github.com/limbic-systems/codetainer.git
cd codetainer

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

## 6. Connect

```bash
# Claude starts automatically at boot — SSH attaches to the running session
fly ssh console -a <your-app-name>

# If Claude is still initializing, you'll see boot progress until it's ready
```

Claude Code launches automatically in a tmux session. The bottom pane is a shell for running commands directly.

### tmux Layout

The session has two panes:

- **Top (80%)**: Claude Code
- **Bottom (20%)**: A bash shell in the working directory

Switch panes with `Ctrl-b ↓` / `Ctrl-b ↑` or click with the mouse.

## Machine Sizing

| Size                  | Memory      | Use Case                     |
| --------------------- | ----------- | ---------------------------- |
| `shared-cpu-1x` / 1GB | Minimum     | Small repos, light tasks     |
| `shared-cpu-1x` / 2GB | Recommended | General development          |
| `shared-cpu-2x` / 4GB | Heavy       | Large repos, parallel builds |

```bash
fly machine run ghcr.io/limbic-systems/codetainer:latest \
  --vm-memory 2048 \
  --vm-size shared-cpu-2x \
  ...
```

## Stopping the Machine

```bash
# List machines to find the ID
fly machine list -a <your-app-name>

# Graceful stop
fly machine stop <machine-id> -a <your-app-name>
```

The machine is configured with `--restart no` and `--autostart=false`, so it stays stopped until you explicitly run a new one.

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

### Git clone fails

- Verify `REPO_URL` is an HTTPS URL (not SSH)
- Verify the `GH_PAT` has Contents read access to the repository
- Check the entrypoint logs: `fly logs -a <your-app-name>`

### Plugin installation fails

The superpowers plugin is installed on first SSH login. If it fails, check:

- Network connectivity (the container needs to reach github.com)
- `status` command to see if CoreDNS is running and no unexpected drops

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
