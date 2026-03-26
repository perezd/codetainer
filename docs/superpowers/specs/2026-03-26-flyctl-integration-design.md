# Flyctl Integration

Add `flyctl` to the container image and allow runtime access to the Fly.io API, with Haiku-based classification for flyctl commands.

## Problem

The container has no way to interact with Fly.io infrastructure. Operators need to SSH out of the container to check app status, view logs, or manage deployments. Adding flyctl enables Claude to assist with Fly operations directly.

## Design

### Installation

Install flyctl in the Dockerfile using the official installer. Only `fly` is symlinked to `/usr/local/bin/` — no `flyctl` alias. This halves the hot-word and block-pattern rules since we only need `^fly\s+` patterns, not `^fly(ctl)?\s+`.

```dockerfile
# Fly CLI
RUN curl -fsSL https://fly.io/install.sh | sh \
    && ln -s /root/.fly/bin/flyctl /usr/local/bin/fly
```

### Authentication

No default auth is provided. The user authenticates interactively as needed via `! fly auth login` from the terminal pane. The auth token is stored in `~/.fly/` (tmpfs — lost on restart). This is intentional: flyctl auth is a privileged operation that should be explicit.

**Blast radius warning:** Fly.io tokens are org-scoped by default — unlike `GH_PAT` (scoped to a single repo), a Fly token grants access to ALL apps in the org. Users should either:
- Use `fly tokens create --expiry 1h` for short-lived tokens
- Operate in a dedicated Fly org with only the relevant app
- Understand that an authenticated flyctl session gives Claude access to the entire org's infrastructure

This should be documented in the README.

### Network Allowlist

Add to `network/domains.conf`:

```
# Fly.io API
api.fly.io
```

Only `api.fly.io` is needed. The bare `fly.io` domain is used for browser-based auth redirects, which don't apply in this headless container (no browser). Interactive auth via `fly auth token` or `FLY_ACCESS_TOKEN` env var works with only the API endpoint.

### Approval Rules

**Tier 1 (hard-block):** Block credential management and lateral movement commands.

```conf
# Fly.io credential management (user handles interactively)
block-pattern:^fly\s+auth\b
block-pattern:^fly\s+tokens?\b

# Fly.io lateral movement (SSH/proxy/sftp to other machines)
block-pattern:^fly\s+ssh\b
block-pattern:^fly\s+proxy\b
block-pattern:^fly\s+sftp\b
block-pattern:^fly\s+console\b

# Fly.io credential variable leak prevention
block-pattern:\$\{?(FLY_ACCESS_TOKEN|FLY_API_TOKEN)\b
```

Rationale for hard-blocking `ssh`, `proxy`, `sftp`, `console`: These are lateral movement primitives. If the user authenticates to an org with multiple apps, `fly ssh console -a other-app` gives Claude a shell on a machine without claudetainer's security controls. These should never be automated.

**Tier 2 (hot word):** Escalate flyctl commands to Haiku for classification.

```conf
hot:fly deploy
hot:fly launch
hot:fly machine
hot:fly scale
hot:fly secrets
hot:fly volumes
hot:fly apps
hot:fly ips
hot:fly certs
hot:fly config
hot:fly image
hot:fly postgres
hot:fly mysql
hot:fly redis
hot:fly extensions
hot:fly wireguard
hot:FLY_ACCESS_TOKEN
hot:FLY_API_TOKEN
```

**Why enumerate subcommands instead of `hot:fly`?** The word `fly` is a common 3-letter substring. The rules parser trims values (`.trim()` in `rules.ts`), so `hot:fly ` (with trailing space) would become `hot:fly`, matching `butterfly`, `firefly`, etc. Enumerating specific mutating subcommands avoids this entirely.

**Read-only commands (`fly status`, `fly logs`, `fly releases`, etc.) are NOT hot-worded.** They pass through as default-allow since they only read information. This keeps read-only operations fast (no Haiku latency).

Haiku then classifies hot-worded commands:
- `fly deploy` → **approve** (state-changing deployment)
- `fly machine stop` → **approve** (modifies infrastructure)
- `fly scale count 2` → **approve** (changes resources)
- `fly secrets set FOO=bar` → **approve** (modifies secrets)

### Haiku Classification Behavior

Add a flyctl-specific line to the Haiku system prompt in `classifier.ts`:

```
- For fly/flyctl commands: read-only operations (status, logs, list) should be ALLOW; state-changing operations (deploy, scale, destroy, secrets) should be APPROVE.
```

This reduces classification ambiguity since flyctl is less common in Haiku's training data than tools like `git` or `curl`.

### Credential File Read Mitigation

After `fly auth login`, the token sits in `~/.fly/config.yml` readable by Claude. Combined with `api.fly.io` being network-reachable, Claude could `cat ~/.fly/config.yml` then use `curl` with the token to make arbitrary Fly API calls, sidestepping flyctl approval rules.

Mitigation: Add a hot word for the flyctl config directory so reads are escalated to Haiku:

```conf
hot:.fly/
```

This catches `cat ~/.fly/config.yml`, `grep token ~/.fly/config.yml`, etc. Haiku would classify these as credential access and return BLOCK or APPROVE.

### Flyctl Subcommand Risk Audit

**Read-only (default-allow, no hot word needed):**

| Command | Description |
|---------|-------------|
| `fly status` | Show app status |
| `fly logs` | View app logs |
| `fly releases` | List releases |
| `fly services` | Show services |
| `fly checks list` | View health checks |
| `fly incidents` | Show incidents |
| `fly dig` | DNS lookups |
| `fly ping` | Connectivity test |
| `fly version` | Show version |
| `fly doctor` | Debug environment |
| `fly platform` | Platform info |
| `fly apps list` | List apps |
| `fly machine list` | List machines |
| `fly machine status` | Machine status |
| `fly ips list` | List IPs |
| `fly volumes list` | List volumes |
| `fly certs list/show` | View certs |
| `fly config show/display` | View config |
| `fly scale show` | View scale settings |
| `fly image show` | View image info |
| `fly dashboard` | Open dashboard URL |
| `fly jobs` | Show jobs |
| `fly orgs list` | List orgs |

**Mutating (hot-worded → Haiku classifies as APPROVE):**

| Command | Description |
|---------|-------------|
| `fly deploy` | Deploy application |
| `fly launch` | Create new app |
| `fly machine start/stop/destroy/restart/run` | Manage machines |
| `fly scale count/memory/vm` | Change resources |
| `fly secrets set/unset` | Manage secrets |
| `fly volumes create/destroy/extend` | Manage volumes |
| `fly apps create/destroy` | Manage apps |
| `fly ips allocate/release` | Manage IPs |
| `fly certs create/remove` | Manage certs |
| `fly config save` | Write config |
| `fly image update` | Update image |
| `fly postgres create/destroy/attach/detach` | Manage databases |
| `fly mysql create/destroy` | Manage databases |
| `fly redis create/destroy` | Manage databases |
| `fly extensions` | Manage extensions |
| `fly wireguard create/remove` | Manage WireGuard |

**Hard-blocked (Tier 1):**

| Command | Description |
|---------|-------------|
| `fly auth` | Authentication management |
| `fly tokens` | API token management |
| `fly ssh` | SSH to remote machines (lateral movement) |
| `fly proxy` | Proxy connections to remote machines |
| `fly sftp` | File transfer to remote machines |
| `fly console` | Shell on remote machines |

## Security Considerations

### Lateral movement via flyctl
An authenticated flyctl session with org-level access allows SSH, proxy, and sftp to any machine in the org. These are hard-blocked to prevent Claude from accessing machines that lack claudetainer's security controls.

### Credential file exposure
After `fly auth login`, the token in `~/.fly/config.yml` is readable. The `hot:.fly/` rule escalates config directory reads to Haiku. The `curl` hot word provides a second layer — any attempt to use the extracted token via curl would be escalated.

### Network exfiltration via fly.io domains
Adding `api.fly.io` to the allowlist means any tool (not just flyctl) can reach it. However, without a Fly auth token, API calls fail. And `curl` is already a hot word. The incremental risk is comparable to the existing `github.com` and `registry.npmjs.org` allowlist entries.

### Org-scoped blast radius
Fly tokens lack fine-grained scoping like GitHub's PATs. The spec documents this in the Authentication section and recommends short-lived tokens or dedicated orgs.

## Files Changed

- `Dockerfile` — add flyctl install step with `fly` symlink (no `flyctl` alias)
- `network/domains.conf` — add `api.fly.io`
- `approval/rules.conf` — add hard-blocks for auth/tokens/ssh/proxy/sftp/console, add hot words for mutating subcommands and credential variables
- `approval/classifier.ts` — add flyctl classification hint to Haiku system prompt
- `README.md` — add flyctl to tooling section, file layout, and security docs

## Files Unchanged

- `claude-settings.json` — no hook changes needed
- `scripts/entrypoint.sh` — no runtime setup needed (user authenticates interactively)
- `approval/rules.ts` — no parser changes needed (no trailing-space hot words)
