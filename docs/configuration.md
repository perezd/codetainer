# Configuration

Reference for secrets, environment variables, and Claude Code settings.

## Secrets

These are set via `fly secrets set` and are required for the container to start.

### `GH_PAT` (required)

A GitHub Personal Access Token that authenticates all git operations, the `gh` CLI, and npm access to GitHub Packages.

This token should be created on the **robot GitHub account** (not your personal account). It acts as the identity boundary for what Claude can do on GitHub — scoped to exactly the repository you want Claude to work in, no broader.

#### Fine-grained token (recommended)

Use a [fine-grained Personal Access Token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token) when the target repo belongs to a GitHub **organization** the robot account is a member of.

1. Log into the robot GitHub account and go to [github.com/settings/tokens](https://github.com/settings/tokens?type=beta). Click **Generate new token** (fine-grained)
2. Give it a descriptive name (e.g. `codetainer - my-repo`)
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

#### Classic token (fallback)

Fine-grained tokens have a [known limitation](https://github.com/community/community/discussions/36441): they can only access repos owned by the token creator's own account or by an org they belong to. They **cannot** access repos owned by another user's personal account.

If the robot account is a collaborator on a repo owned by someone else's personal account (not an org), use a [classic Personal Access Token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-personal-access-token-classic) instead.

1. Log into the robot GitHub account and go to [github.com/settings/tokens](https://github.com/settings/tokens). Click **Generate new token** (classic)
2. Give it a descriptive name (e.g. `codetainer - my-repo`)
3. Grant exactly these scopes:
   - `repo` — full repository access (clone, commit, push, PRs, issues)
   - `read:org` — read organization membership
   - `read:packages` — read GitHub Packages (npm registry)
4. Click **Generate token** and copy it immediately (you won't see it again)

#### Set the secret

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

| Variable                   | Required | Default                         | Description                                                                                                                                                                                                                                         |
| -------------------------- | -------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GIT_USER_NAME`            | No       | `codetainer`                    | Git commit author name                                                                                                                                                                                                                              |
| `GIT_USER_EMAIL`           | No       | `codetainer@noreply.github.com` | Git commit author email                                                                                                                                                                                                                             |
| `REPO_URL`                 | No       | _(none)_                        | HTTPS URL of a GitHub repo to clone on startup. Cloned to `/workspace/repo`. Must be accessible with the `GH_PAT`.                                                                                                                                  |
| `CLAUDE_PROMPT`            | No       | _(none)_                        | Initialization prompt for Claude Code. When set, Claude immediately begins working on this prompt at boot. Typically a GitHub issue URL (e.g., `https://github.com/org/repo/issues/42`). Visible via `fly machine status` — do not include secrets. |
| `OTEL_LOG_USER_PROMPTS`    | No       | `1`                             | Set to `0` to exclude user prompt content from telemetry events (only prompt length is recorded). Requires Grafana Cloud telemetry — see [Telemetry](telemetry.md).                                                                                 |
| `OTEL_LOG_TOOL_DETAILS`    | No       | `1`                             | Set to `0` to exclude tool parameters from telemetry events (only tool name is recorded). Requires Grafana Cloud telemetry — see [Telemetry](telemetry.md).                                                                                         |
| `OTEL_RESOURCE_ATTRIBUTES` | No       | _(auto: Fly identity)_          | Comma-separated `key=value` pairs added to all metrics and events. `fly.app_name` and `fly.machine_id` are auto-injected; operator values are appended. Requires Grafana Cloud telemetry — see [Telemetry](telemetry.md).                           |

## Claude Code Settings

Claude Code's runtime settings are defined in `claude-settings.json` at the repo root and copied into the container at `/home/claude/.claude/settings.json` during boot.

The file configures:

- **Model**: `claude-opus-4-6` — the default model used for all sessions.
- **Hooks**:
  - `SessionStart` — runs `/opt/claude/sync-fork.sh` to sync forks with upstream at the start of each session.
  - `PreToolUse` (matcher: `EnterWorktree`) — runs `/opt/claude/sync-fork.sh` when entering a worktree.
  - `Stop` — runs `/opt/claude/session-namer.sh` to rename the tmux session after the first assistant response.
- **Plugins**: `superpowers@claude-plugins-official` and `typescript-lsp@claude-plugins-official` are enabled and installed at boot.
- **Status line**: Renders via `bash /opt/claude/statusline-command.sh`, showing the current model, context window usage bar, and tmux session name.

To change the model or adjust any setting, edit `claude-settings.json` and rebuild the container image.

## Troubleshooting

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

### Plugin installation fails

The superpowers plugin is installed on first SSH login. If it fails, check:

- Network connectivity (the container needs to reach github.com)
- `status` command to see if CoreDNS is running and no unexpected drops
