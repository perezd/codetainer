# Stargate Integration Design

Restore the Command Control security layer by integrating
[Stargate](https://github.com/limbic-systems/stargate) — a standalone Go binary
that classifies bash commands via AST parsing, configurable rules, scope-bound
trust, and optional LLM review — into the codetainer boot sequence and Claude
Code hook pipeline.

## Context

The built-in command approval system (TypeScript, three-tier classification with
Haiku LLM) was removed in commit 566b4d9 in favor of an external dependency.
Stargate is that dependency. It provides the same defense-in-depth layer with a
cleaner architecture: a stateless HTTP server, a Claude Code hook adapter, and
operator-defined scopes that live outside the guarded repository.

## Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Binary source | GitHub release download (pinned version, SHA256 verified) | Matches CoreDNS pattern; integrity verification for security-critical binary |
| LLM review | Enabled via `CLAUDE_CODE_OAUTH_TOKEN` | No new secrets; covers autonomous `CLAUDE_PROMPT` mode |
| `github_owners` scope | Auto-derived from `REPO_URL` | Covers common case; fail-closed (empty) when unset |
| `allowed_domains` scope | Mirror `network/domains.conf` | Network layer is the enforcement boundary; avoid double-gating |
| Telemetry | Piggyback on existing Grafana OTLP config via env vars | Unified observability; credentials never written to config file |
| Rule adjustments | Add targeted RED rule for token file path | Prevents `sudo cat .ghtoken` from being GREEN after wrapper stripping |
| Server privilege | De-privileged to `claude` user | Principle of least privilege; untrusted input parsing should not run as root |
| Config ownership | Root-owned, read-only (`root:root 444`) | Immutable trust anchor; eliminates config tampering attack vector |
| Settings ownership | Root-owned, read-only (`root:root 444`) | Immutable hook configuration; prevents hook removal bypass |

## Architecture

### Binary Installation (Dockerfile)

Download `stargate-linux-amd64` from a pinned GitHub release with SHA256
checksum verification. Place at `/usr/local/bin/stargate` (mode 755). Inserted
after CoreDNS installation (~line 60).

```dockerfile
# Stargate — bash command classifier
RUN STARGATE_VERSION=v0.1.0 && \
    STARGATE_SHA256="<sha256-hash-here>" && \
    curl -fsSL \
      "https://github.com/limbic-systems/stargate/releases/download/${STARGATE_VERSION}/stargate-linux-amd64" \
      -o /usr/local/bin/stargate && \
    echo "${STARGATE_SHA256}  /usr/local/bin/stargate" | sha256sum -c - && \
    chmod 755 /usr/local/bin/stargate
```

The binary is statically linked (`CGO_ENABLED=0`), so no runtime dependencies.
The SHA256 hash is obtained from the release's `SHA256SUMS` file and pinned in
the Dockerfile. Version upgrades require updating both the version tag and the
hash — intentional friction for a security-critical binary.

### Config Generation Script

**New file:** `scripts/generate-stargate-config.sh`

Runs at boot as root, before the read-only remount. Produces
`/opt/stargate/stargate.toml` (root-owned, immutable after rootfs remount).

Steps:

1. Set `STARGATE_CONFIG=/opt/stargate/stargate.toml` and export it.
2. Create the directory: `mkdir -p /opt/stargate && chmod 755 /opt/stargate`.
3. Symlink guard: `[[ -L "$STARGATE_CONFIG" ]] && rm -f "$STARGATE_CONFIG"`.
4. Run `stargate init --config "$STARGATE_CONFIG"` to write the embedded default
   config (588 lines, 83 rules).
5. Extract the GitHub owner from `REPO_URL`:
   ```bash
   GITHUB_OWNER=$(echo "$REPO_URL" \
     | sed -n 's|.*github\.com[:/]\([^/]*\)/.*|\1|p')
   ```
   If `REPO_URL` is unset or not a GitHub URL, `github_owners` is left empty.
   All `gh` commands go YELLOW (fail-closed).
6. Read `/opt/network/domains.conf`, strip comments and blanks, format as a TOML
   array for `scopes.allowed_domains`. A comment in the script documents that
   `allowed_domains` is derived exclusively from `domains.conf` and must not be
   expanded independently — the network layer is the enforcement boundary, and
   Stargate's scope must be a subset.
7. Patch the `[scopes]` section in the generated config with the derived
   `github_owners` and `allowed_domains` values.
8. Add a targeted RED rule for the token file path:
   ```toml
   [[rules.red]]
   command = "cat"
   args = ["/opt/gh-config/.ghtoken", "/opt/gh-config/*"]
   reason = "Direct read of credential file."
   ```
   This prevents the `sudo` wrapper-stripping behavior from making
   `sudo cat /opt/gh-config/.ghtoken` classify as GREEN. The inner `cat` command
   with the token file argument hits this RED rule.
9. If Grafana telemetry env vars are set (`GRAFANA_INSTANCE_ID`,
   `GRAFANA_API_TOKEN`, `GRAFANA_OTLP_ENDPOINT`), enable telemetry with
   `enabled = true` and set the endpoint. **Credentials are NOT written to the
   config file.** Instead, the entrypoint passes `STARGATE_OTEL_USERNAME` and
   `STARGATE_OTEL_PASSWORD` as environment variables to the `stargate serve`
   process. Stargate supports env var overrides for telemetry auth (env vars take
   precedence over config values per Stargate's `[telemetry]` docs). If Grafana
   is not configured, set `enabled = false`.
10. Set final permissions: `chmod 444 /opt/stargate/stargate.toml` (root:root,
    world-readable, not writable by anyone).

**Config location:** `/opt/stargate/stargate.toml` — on the read-only rootfs.
After the Phase 5 remount, this file is truly immutable: even root cannot modify
it without remounting. This eliminates the config tampering attack vector
entirely (no longer an accepted risk). The path is outside any repo directory,
satisfying Stargate's trust anchor requirement.

**Corpus and traces:** The precedent corpus SQLite database goes to
`/home/claude/.local/share/stargate/precedents.db` (Stargate default, on
`/home/claude` tmpfs). Trace files go to the OS temp directory (`/tmp` tmpfs).
Both are ephemeral per container. The `claude` user needs write access to these
for runtime operation — this is appropriate since corpus/trace data is
operational, not a trust anchor.

**`STARGATE_CONFIG` env var:** The entrypoint exports
`STARGATE_CONFIG=/opt/stargate/stargate.toml` so both `stargate serve` and
`stargate hook` resolve the correct config path. This is set in the entrypoint
environment and inherited by all child processes.

### Boot Sequence Integration (entrypoint.sh)

New Phase 4: Command Control, inserted between Phase 3 (git/gh/npm auth,
~line 157) and Phase 5 (read-only remount, ~line 219).

**Why this position:**

- After filesystem hardening (Phase 1) — tmpfs mounts exist for corpus/traces.
- After network setup (Phase 2) — domain allowlist file is in place at
  `/opt/network/domains.conf`.
- After git/gh auth (Phase 3) — no direct dependency, but maintains logical
  grouping.
- Before read-only remount (Phase 5) — `/opt/stargate/` directory and config
  file must be created on rootfs.
- Before repo clone (Phase 6) — server is running before any Claude Code
  interaction.

**Entrypoint additions:**

```bash
# --- Phase 4: Command Control (Stargate) ---
echo "[entrypoint] configuring stargate..."
export STARGATE_CONFIG=/opt/stargate/stargate.toml
/usr/local/bin/generate-stargate-config.sh

# Build env var array for stargate serve (telemetry credentials via env, not config)
STARGATE_ENV_ARGS=()
if [[ -n "${GRAFANA_INSTANCE_ID:-}" && -n "${GRAFANA_API_TOKEN:-}" ]]; then
    STARGATE_ENV_ARGS+=(STARGATE_OTEL_USERNAME="$GRAFANA_INSTANCE_ID")
    STARGATE_ENV_ARGS+=(STARGATE_OTEL_PASSWORD="$GRAFANA_API_TOKEN")
fi

# Start server as claude user in auto-restart loop
while true; do
    start_time=$(date +%s)
    sudo -u claude env "${STARGATE_ENV_ARGS[@]}" \
      STARGATE_CONFIG="$STARGATE_CONFIG" \
      CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN" \
      stargate serve 2>&1 | \
      while IFS= read -r line; do echo "[stargate] $line"; done
    elapsed=$(( $(date +%s) - start_time ))
    if [[ $elapsed -lt 5 ]]; then
        echo "[entrypoint] stargate exited quickly (${elapsed}s), sleeping 5s..."
        sleep 5
    else
        echo "[entrypoint] stargate exited, restarting in 1s..."
        sleep 1
    fi
done &
echo "[entrypoint] stargate started (loop PID $!)"

# Health check — poll until server is ready
STARGATE_READY=false
for i in $(seq 1 30); do
    if curl -sf http://127.0.0.1:9099/health > /dev/null 2>&1; then
        echo "[entrypoint] stargate ready"
        STARGATE_READY=true
        break
    fi
    sleep 0.2
done
if [[ "$STARGATE_READY" != "true" ]]; then
    echo "[entrypoint] WARN: stargate did not become ready within 6s" >&2
fi
```

**De-privileged server:** The Stargate server runs as the `claude` user via
`sudo -u claude`. It parses untrusted input (bash command strings) and should
not run as root. The server only needs to: read its config file (root:root 444,
world-readable), write to the corpus database (on claude-owned tmpfs), and bind
to a loopback port (no privilege required). `CLAUDE_CODE_OAUTH_TOKEN` is passed
explicitly through the `env` command for LLM review — it is available in the
server's `/proc/<pid>/environ`, readable only by the `claude` user (same UID)
and root. This is not a new exposure: the token is already in the Claude Code
process's environment.

**Auto-restart loop with fast-exit detection:** If the server exits within 5
seconds of starting (indicating a config error, port conflict, or crash loop),
the loop sleeps 5 seconds before retrying. Normal exits (server ran for >5s)
restart after 1 second. This prevents tight crash loops from consuming CPU.

**Health check with warning:** Polls for up to 6 seconds. Logs an explicit
warning if the server fails to start, giving operators visibility into boot
health.

**Readiness integration:** The Phase 7 readiness check block is extended to
include a Stargate health check:

```bash
# In the existing readiness verification block:
if ! curl -sf http://127.0.0.1:9099/health > /dev/null 2>&1; then
    echo "[entrypoint] WARN: stargate not healthy" >&2
    READY=false
fi
```

This parallels the existing CoreDNS `pidof` check and iptables rule count
check, ensuring Stargate status is visible in the readiness output.

### Claude Code Hook Configuration (claude-settings.json)

Static additions — no boot-time generation needed.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "stargate hook --agent claude-code --event pre-tool-use",
            "timeout": 30000
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "stargate hook --agent claude-code --event post-tool-use",
            "timeout": 10000
          }
        ]
      }
    ]
  }
}
```

**PreToolUse timeout (30s):** LLM review via `claude -p` subprocess takes
10-12s. 30s gives headroom for classification + LLM + network latency.

**PostToolUse timeout (10s):** Fire-and-forget feedback recording. The adapter
always returns exit 0.

**Matcher `"Bash"`:** Avoids invoking the hook binary for non-Bash tools
(Read, Edit, Write, etc.). The adapter already handles non-Bash by returning
allow, but the matcher skips the process spawn entirely.

**Fail-closed on server unreachable:** When the hook CLI cannot reach the
Stargate server (connection refused, timeout), it exits with code 2
(`claudecode.go:191-192`). Claude Code interprets a non-zero hook exit as a
hard failure that blocks the tool use. This is the specific code path that
enforces fail-closed behavior.

### Settings File Immutability

The `claude-settings.json` file (containing hook configuration) and its parent
directory are made root-owned and non-writable by the `claude` user:

```bash
# In entrypoint.sh, after copying settings.json (existing Phase 4/Claude setup):
chmod 444 /home/claude/.claude/settings.json
chown root:root /home/claude/.claude
chmod 755 /home/claude/.claude
# Note: settings.json is already root-owned since entrypoint runs as root and
# the copy happens before any chown to claude. The parent directory must also
# be root-owned to prevent unlink + recreate attacks — Unix file permissions
# are irrelevant if the attacker has write access to the parent directory.
```

**Directory ownership is critical:** Even with `settings.json` set to
`root:root 444`, a `claude`-writable parent directory would allow the file to be
unlinked and recreated without hooks. Setting `/home/claude/.claude/` to
`root:root 755` prevents this: the `claude` user can traverse and read but
cannot create, delete, or rename files in the directory.

This prevents the `claude` user from removing hook entries to bypass command
control. Claude Code reads settings.json but does not require write access to it
during normal operation.

**Verification:** Claude Code may write other files to `.claude/` at runtime
(caches, state files like `.claude.json`). During implementation, verify which
files Claude Code needs write access to in this directory. If writes are needed:
(a) create a writable subdirectory (e.g., `/home/claude/.claude/state/`,
`claude:claude 755`) for mutable state, or (b) symlink specific writable files
to a claude-owned location on tmpfs. The hook configuration file must remain in
a root-owned, non-writable directory.

### Existing File Updates

**`CLAUDE.md`:**

- Update the Command Control row in the security framework table:

  | Layer | Defense | Key Files |
  | --- | --- | --- |
  | Command Control | Stargate: AST-based classification, scope-bound trust, LLM review for YELLOW commands | `scripts/generate-stargate-config.sh`, `scripts/entrypoint.sh`, `claude-settings.json` (hooks) |

- Update the Boot Sequence section to include the new Phase 4 (Command Control)
  and renumber subsequent phases accordingly. The new sequence:
  1. Validate secrets
  2. Mount tmpfs (filesystem hardening)
  3. Extract Grafana OTLP hostname
  4. Start CoreDNS (DNS filtering)
  5. Apply iptables (network isolation)
  6. Configure git/gh/npm auth
  7. **Configure and start Stargate (command control)**
  8. Write OTEL env file
  9. Copy Claude settings (with immutable permissions)
  10. Remount rootfs read-only
  11. Clone repo
  12. Readiness checks (now including Stargate health)
  13. Start Claude Code

**`docs/accepted-risks.md`:**

- **Update (not resolve)** the three existing entries that had command approval
  references stripped (2026-04-06 update):
  1. "Unattended autonomous execution with repo credentials" — add Stargate as a
     compensating control. Note that YELLOW commands in autonomous mode block
     (fail-closed) because the "ask user" fallback has no human to approve.
  2. "Sudoers-mediated token file read" — add Stargate RED rule for direct token
     file reads as a compensating control. Note that the `gh-wrapper.sh`
     credential helper path is not affected (runs outside Bash tool).
  3. "Single PAT for GitHub API and npm registry auth" — add Stargate's
     `github_owners` scope as a compensating control for restricting `gh`
     operations to trusted repos.
- **No new config mutability risk entry needed** — the config is now root-owned
  on the read-only rootfs, eliminating the mutable trust anchor entirely.

## Change Manifest

| File | Change |
| --- | --- |
| `Dockerfile` | Add stargate binary download with version pin + SHA256 (~5 lines, after CoreDNS) |
| `scripts/generate-stargate-config.sh` | **New file.** Config generation from env vars and domain allowlist, writes to `/opt/stargate/` |
| `scripts/entrypoint.sh` | Add Phase 4: config generation, de-privileged server start with fast-exit detection, health check with warning, readiness integration (~30 lines). Lock settings.json and `.claude/` directory permissions. |
| `claude-settings.json` | Add PreToolUse and PostToolUse hooks for Bash tool |
| `CLAUDE.md` | Update Command Control row in security framework table; renumber boot sequence phases |
| `docs/accepted-risks.md` | Update three existing entries with Stargate as compensating control |

**Not changed:** `network/domains.conf`, `start-claude.sh`, `attach-claude.sh`,
`refresh-iptables.sh`, existing hooks (SessionStart, Stop), existing scripts.

## Security Design Checklist

**Trust anchor mutability:** The `stargate.toml` config file is root-owned
(`root:root 444`) at `/opt/stargate/stargate.toml`. Before the Phase 5 read-only
remount, this is writable only by root. After the remount, the entire rootfs is
read-only — the config becomes truly immutable for the remainder of the
container's lifetime. No runtime process (including root) can modify it without
re-mounting the filesystem. The `claude-settings.json` (containing hook config)
is similarly protected: root-owned (`root:root 444`) on tmpfs, with both file
permissions and parent directory ownership (`/home/claude/.claude/` set to
`root:root 755`) preventing modification, unlinking, or recreation by the
`claude` user.

The Stargate server is started after config generation but before the read-only
remount. The config is read once at server startup. If the server crashes and
the auto-restart loop relaunches it, the restarted server reads the same
immutable config from the read-only rootfs — no tampered config can be loaded.

Corpus and trace data live on claude-owned tmpfs. These are operational data, not
trust anchors — corpus corruption degrades precedent quality but cannot change
classification rules.

**File and output visibility:** The config generation script writes
`stargate.toml` to `/opt/stargate/` (root-owned, world-readable). The file
contains no secrets — scopes are domain/owner names, rules are patterns.
Telemetry credentials (`STARGATE_OTEL_USERNAME`, `STARGATE_OTEL_PASSWORD`) are
passed via environment variables to the `stargate serve` process, never written
to the config file. `CLAUDE_CODE_OAUTH_TOKEN` is similarly passed via env var.
These are visible in `/proc/<pid>/environ` for the `claude` user (same UID as
the server process) and root — this matches the existing exposure model where
the token is already in the Claude Code process's environment.

The Stargate server logs to stderr with `log_commands = false` (default). Log
output does not contain command strings. The precedent corpus stores scrubbed
command strings (secrets redacted via the scrubbing pipeline before storage).

**Allowlist vs blocklist:** The rule engine uses an allowlist model. Rules are
evaluated in priority order: RED (block) > GREEN (allow) > YELLOW (review).
Commands matching no rule fall through to `default_decision = "yellow"` (require
review). This is fail-closed — only explicitly GREEN commands pass without
review. Scopes (`github_owners`, `allowed_domains`) are also allowlists. The
`allowed_domains` scope is derived exclusively from `network/domains.conf` and
must not be expanded independently — the network layer is the enforcement
boundary.

**Fail mode:** Fail-closed at every level:
- Unreachable server: hook adapter exits with code 2 (`claudecode.go:191-192`),
  Claude Code blocks the tool use.
- Server crash: auto-restart loop with fast-exit detection. Commands blocked
  during the 1-5s restart gap.
- Config generation failure: server cannot start, commands blocked.
- LLM review unavailable (no `CLAUDE_CODE_OAUTH_TOKEN` or `claude` binary):
  YELLOW commands with `llm_review = true` fall through to
  `permissionDecision: "ask"`. In autonomous mode (`CLAUDE_PROMPT`), no human is
  present to approve — commands are blocked.
- No rule match: `default_decision = "yellow"` triggers review or user prompt.

**Temporal safety:** Config generation runs in Phase 4, before the read-only
remount (Phase 5). The config is written to `/opt/stargate/` (rootfs) as root.
The server starts immediately after in the same phase, running as `claude` via
`sudo -u claude`. There is a privilege transition (root → claude) between config
write and server start, but no TOCTOU window: the config is root-owned and the
`claude` user cannot modify it. The `sudo -u claude` invocation happens within
the same entrypoint phase, and no other process runs as `claude` at this point
(Claude Code hasn't started yet). After Phase 5 remount, the config is on
read-only rootfs — fully immutable.

The `claude-settings.json` is copied and permission-locked (root:root 444) in
the entrypoint before Claude Code starts. No `claude`-owned process can modify
hook configuration.

**Network exposure:** The Stargate server binds to `127.0.0.1:9099` (localhost
only). The `serve.go` code rejects non-loopback bind addresses at startup
(`isLoopbackAddr` check, `serve.go:23-29`). The hook adapter validates the
server URL is loopback before connecting (`cfg.ValidateURL()`). No new network
listeners are exposed outside the container. The iptables rule
`-A OUTPUT -o lo -j ACCEPT` permits loopback traffic, so the hook's HTTP
connection to `127.0.0.1:9099` is unaffected by the OUTPUT DROP policy.

No new outbound connections are introduced. LLM review uses the existing
`claude` binary subprocess, which connects to `api.anthropic.com` (already in
the domain allowlist, `domains.conf` line 2, with corresponding CoreDNS forward
block and iptables ACCEPT rules). Stargate telemetry (when enabled) exports to
the Grafana OTLP endpoint, which is already handled by the entrypoint's
extra-domains mechanism.

**Layer compensation:** This change strengthens the security posture by
restoring a missing layer. No existing layer is weakened. The config is
immutable (root-owned on read-only rootfs), the hook configuration is
immutable (root-owned settings.json), and the server runs de-privileged. The
only new residual risk is the `CLAUDE_CODE_OAUTH_TOKEN` in the server's process
environment, which matches the existing exposure model (same token, same UID,
already in Claude Code's environment).
