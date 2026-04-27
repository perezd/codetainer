# Stargate Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the Command Control security layer by integrating Stargate into the codetainer boot sequence and Claude Code hook pipeline.

**Architecture:** Stargate is a standalone Go binary that classifies bash commands via AST parsing and configurable rules. It runs as an HTTP server on localhost:9099, with Claude Code hooks invoking the `stargate hook` CLI adapter. Config is generated at boot from environment variables and the domain allowlist, placed on the rootfs before read-only remount for immutability.

**Tech Stack:** Bash (entrypoint/config scripts), Dockerfile (binary installation), JSON (claude-settings.json hooks), TOML (stargate config), Markdown (CLAUDE.md, accepted-risks.md)

**Spec:** `docs/superpowers/specs/2026-04-26-stargate-integration-design.md`

---

### Task 1: Dockerfile changes — binary and script COPY

**Files:**
- Modify: `Dockerfile:55-59` (insert after CoreDNS block)
- Modify: `Dockerfile:107-110` (insert in scripts section)

This adds the Stargate binary download with pinned version and SHA256 checksum verification, and copies the config generation script into the image. Both Dockerfile changes are combined because Task 3 (create the script) and Task 4 (entrypoint integration) reference the installed path `/usr/local/bin/generate-stargate-config.sh`.

- [ ] **Step 1: Add Stargate binary installation block**

Insert after the CoreDNS block (line 59) and before the "Create claude user" comment (line 62):

```dockerfile
# Stargate — bash command classifier for AI coding agents
RUN STARGATE_VERSION=v0.1.1 && \
    STARGATE_SHA256="06b0d805353468ddc88eb07f494d27af53a0ec8bfb871e9e8bfde5edf09ab43e" && \
    curl -fsSL \
      "https://github.com/limbic-systems/stargate/releases/download/${STARGATE_VERSION}/stargate-linux-amd64" \
      -o /usr/local/bin/stargate && \
    echo "${STARGATE_SHA256}  /usr/local/bin/stargate" | sha256sum -c - && \
    chmod 755 /usr/local/bin/stargate
```

- [ ] **Step 2: Add COPY for generate-stargate-config.sh**

Insert in the scripts section, after the network config COPY block (line 110, after `RUN chmod +x /opt/network/refresh-iptables.sh`) and before the Claude settings block (line 112, `# Claude settings template`):

```dockerfile
# Stargate config generator
COPY scripts/generate-stargate-config.sh /usr/local/bin/generate-stargate-config.sh
RUN chmod +x /usr/local/bin/generate-stargate-config.sh
```

- [ ] **Step 3: Verify Dockerfile structure**

Run: `grep -n 'CoreDNS\|Stargate\|Create claude\|generate-stargate\|Claude settings' Dockerfile | head -15`

Expected: CoreDNS block → Stargate binary → Create claude user → ... → generate-stargate-config COPY → Claude settings.

- [ ] **Step 4: Commit**

```bash
git add Dockerfile
git commit -m "feat(docker): add stargate binary and config generation script"
```

---

### Task 2: Add Claude Code hooks to claude-settings.json

**Files:**
- Modify: `claude-settings.json`

Add PreToolUse (Bash matcher) and PostToolUse (Bash matcher) hooks for Stargate. The PreToolUse Bash hook goes before the existing EnterWorktree hook. PostToolUse is a new hook event section.

- [ ] **Step 1: Add Bash PreToolUse hook**

Add as the first entry in the existing `PreToolUse` array (before the `EnterWorktree` matcher):

```json
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
```

- [ ] **Step 2: Add PostToolUse hook section**

Add a new `PostToolUse` key after the existing `Stop` section:

```json
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
```

- [ ] **Step 3: Validate JSON**

Run: `python3 -c "import json; json.load(open('claude-settings.json'))"`

Expected: No output (valid JSON).

- [ ] **Step 4: Run prettier**

Run: `bunx prettier --write claude-settings.json && bunx prettier --check claude-settings.json`

Expected: Passes check.

- [ ] **Step 5: Commit**

```bash
git add claude-settings.json
git commit -m "feat(hooks): add stargate PreToolUse and PostToolUse hooks for Bash tool"
```

---

### Task 3: Create config generation script

**Files:**
- Create: `scripts/generate-stargate-config.sh`

This script runs as root at boot, generates `/opt/stargate/stargate.toml` from environment variables and the domain allowlist, and locks it down with `root:root 444`.

- [ ] **Step 1: Create the script**

Create `scripts/generate-stargate-config.sh` with these responsibilities:

1. Set and export `STARGATE_CONFIG=/opt/stargate/stargate.toml`
2. Create `/opt/stargate/` directory (mode 755)
3. Symlink guard: `[[ -L "$STARGATE_CONFIG" ]] && rm -f "$STARGATE_CONFIG"`
4. Run `stargate init --config "$STARGATE_CONFIG"` to write embedded defaults
5. Extract GitHub owner from `REPO_URL` via sed: `sed -n 's|.*github\.com[:/]\([^/]*\)/.*|\1|p'`
6. Read `/opt/network/domains.conf`, strip comments/blanks, build TOML array
7. Patch `[scopes]` section — replace `github_owners` and `allowed_domains` lines using sed
8. Append targeted RED rule for `/opt/gh-config/.ghtoken` (credential file protection)
9. If Grafana telemetry env vars set, patch `[telemetry]` section with `enabled = true` and endpoint (no credentials in file)
10. If Grafana not configured, ensure `enabled = false`
11. Lock permissions: `chmod 444 "$STARGATE_CONFIG"`

Script must be `#!/usr/bin/env bash` with `set -euo pipefail`.

Include a header comment: `# allowed_domains is derived exclusively from domains.conf and must not be expanded independently.`

Key implementation details for the sed patching:

- `github_owners`: Replace the line matching `^github_owners = ` with the derived value. If no owner extracted, set to `github_owners = []`.
- `allowed_domains`: Replace the line matching `^allowed_domains = ` with the TOML array built from `domains.conf`. Format each domain as a quoted string: `allowed_domains = ["api.anthropic.com", "github.com", ...]`.
- The RED rule for the token file must be appended after the last `[[rules.red]]` block. Find the line number of the last `reason =` in a `[[rules.red]]` section and insert after it.
- Telemetry: Replace the `enabled = ` line under `[telemetry]` and the `endpoint = ` line. Do NOT write `username` or `password` values — those come via env vars `STARGATE_OTEL_USERNAME` and `STARGATE_OTEL_PASSWORD` at runtime.

- [ ] **Step 2: Make executable**

Run: `chmod +x scripts/generate-stargate-config.sh`

- [ ] **Step 3: Commit**

```bash
git add scripts/generate-stargate-config.sh
git commit -m "feat(stargate): add config generation script for boot-time TOML generation"
```

---

### Task 4: Pass STARGATE_CONFIG through start-claude.sh

**Files:**
- Modify: `scripts/start-claude.sh:19-29` (run_as_claude helper)
- Modify: `scripts/start-claude.sh:142-154` (tmux session creation)
- Modify: `scripts/start-claude.sh:157-164` (terminal pane creation)

The `stargate hook` command (invoked by Claude Code hooks) needs the `STARGATE_CONFIG` env var to find the config file. The `sudo -u claude` invocations in `start-claude.sh` explicitly list env vars — they do NOT inherit the caller's environment. `STARGATE_CONFIG` is currently missing from all three invocation sites.

- [ ] **Step 1: Add STARGATE_CONFIG to run_as_claude helper**

In `scripts/start-claude.sh`, the `run_as_claude()` function (lines 19-30) builds a `sudo -u claude` invocation with explicit env vars. Add `STARGATE_CONFIG="$STARGATE_CONFIG"` after the `LC_ALL` line (line 27):

```bash
run_as_claude() {
  sudo -u claude \
    HOME="$CLAUDE_HOME" \
    PATH="$CLAUDE_HOME/.local/bin:$CLAUDE_HOME/.bun/bin:$PATH" \
    GH_TOKEN="$GH_PAT" \
    CODETAINER_NPM_TOKEN="$GH_PAT" \
    CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN" \
    LANG="$LANG" \
    LC_ALL="$LC_ALL" \
    STARGATE_CONFIG="${STARGATE_CONFIG:-}" \
    "${OTEL_ENV_ARGS[@]}" \
    "$@"
}
```

Use `${STARGATE_CONFIG:-}` to avoid `set -u` failures if the var is somehow unset.

- [ ] **Step 2: Add STARGATE_CONFIG to tmux session creation**

In the `sudo -u claude` block that creates the tmux session (lines 142-154), add `STARGATE_CONFIG="${STARGATE_CONFIG:-}"` after the `LC_ALL` line (line 150):

```bash
sudo -u claude \
  HOME="$CLAUDE_HOME" \
  PATH="$CLAUDE_HOME/.local/bin:$CLAUDE_HOME/.bun/bin:$PATH" \
  GH_TOKEN="$GH_PAT" \
  CODETAINER_NPM_TOKEN="$GH_PAT" \
  CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN" \
  COLORTERM="truecolor" \
  LANG="$LANG" \
  LC_ALL="$LC_ALL" \
  STARGATE_CONFIG="${STARGATE_CONFIG:-}" \
  "${OTEL_ENV_ARGS[@]}" \
  tmux -f /tmp/.tmux.conf new-session -d -s claude \
    -c "$WORK_DIR" \
    "$CLAUDE_CMD"
```

- [ ] **Step 3: Add STARGATE_CONFIG to terminal pane creation**

In the `sudo -u claude` block that creates the terminal pane (lines 157-164), add `STARGATE_CONFIG="${STARGATE_CONFIG:-}"` after the `LC_ALL` line:

```bash
sudo -u claude \
  HOME="$CLAUDE_HOME" \
  PATH="$CLAUDE_HOME/.local/bin:$CLAUDE_HOME/.bun/bin:$PATH" \
  GH_TOKEN="$GH_PAT" \
  CODETAINER_NPM_TOKEN="$GH_PAT" \
  COLORTERM="truecolor" \
  LANG="$LANG" \
  LC_ALL="$LC_ALL" \
  STARGATE_CONFIG="${STARGATE_CONFIG:-}" \
```

- [ ] **Step 4: Commit**

```bash
git add scripts/start-claude.sh
git commit -m "feat(start-claude): pass STARGATE_CONFIG to tmux session environment"
```

---

### Task 5: Integrate Stargate into entrypoint.sh boot sequence

**Files:**
- Modify: `scripts/entrypoint.sh`

This is the core integration: config generation, de-privileged server start with auto-restart, health check, settings immutability, and readiness gate.

- [ ] **Step 1: Add Stargate phase before Claude Code setup**

Insert a new block between line 207 (end of OTEL Phase 2, the last line of the `if [[ -n "$OTEL_ATTRS" ]]` block) and line 209 (`=== 4. Claude Code setup ===`). This is the correct position: after all network + auth + telemetry config is complete, and before the read-only remount (line 221).

New block to insert:

```bash
# === 4a. Command Control (Stargate) ===
echo "[ENTRYPOINT] Configuring Stargate..."
export STARGATE_CONFIG=/opt/stargate/stargate.toml
/usr/local/bin/generate-stargate-config.sh

STARGATE_ENV_ARGS=()
if [[ -n "${GRAFANA_INSTANCE_ID:-}" && -n "${GRAFANA_API_TOKEN:-}" ]]; then
    STARGATE_ENV_ARGS+=(STARGATE_OTEL_USERNAME="$GRAFANA_INSTANCE_ID")
    STARGATE_ENV_ARGS+=(STARGATE_OTEL_PASSWORD="$GRAFANA_API_TOKEN")
fi

(while true; do
    start_time=$(date +%s)
    sudo -u claude env "${STARGATE_ENV_ARGS[@]}" \
      STARGATE_CONFIG="$STARGATE_CONFIG" \
      CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN" \
      stargate serve 2>&1 | \
      while IFS= read -r line; do echo "[STARGATE] $line"; done
    elapsed=$(( $(date +%s) - start_time ))
    if [[ $elapsed -lt 5 ]]; then
        echo "[ENTRYPOINT] Stargate exited quickly (${elapsed}s), sleeping 5s..." >&2
        sleep 5
    else
        echo "[ENTRYPOINT] Stargate exited, restarting in 1s..." >&2
        sleep 1
    fi
done) &
echo "[ENTRYPOINT] Stargate started (loop PID $!)"

STARGATE_READY=false
for i in $(seq 1 30); do
    if curl -sf http://127.0.0.1:9099/health > /dev/null 2>&1; then
        echo "[ENTRYPOINT] Stargate ready"
        STARGATE_READY=true
        break
    fi
    sleep 0.2
done
if [[ "$STARGATE_READY" != "true" ]]; then
    echo "[ENTRYPOINT] WARN: Stargate did not become ready within 6s" >&2
fi
```

- [ ] **Step 2: Lock settings.json permissions and .claude/ directory ownership**

In the Claude Code setup section (currently `=== 4. Claude Code setup ===`, line 209), replace the settings copy block (lines 211-213):

**Replace:**
```bash
cp /opt/claude/settings.json /home/claude/.claude/settings.json
chown claude:claude /home/claude/.claude/settings.json
```

**With:**
```bash
cp /opt/claude/settings.json /home/claude/.claude/settings.json
chmod 444 /home/claude/.claude/settings.json
chown root:root /home/claude/.claude
chmod 755 /home/claude/.claude
```

The file is already root-owned (entrypoint runs as root). We lock the file to 444 and the parent directory to `root:root 755` to prevent unlink+recreate attacks.

**Important — `.claude/` directory write access:** Claude Code writes runtime state files into `/home/claude/.claude/` (e.g., plugin caches, project trust state). With the directory set to `root:root 755`, Claude Code will be unable to create new files there. To verify what Claude Code needs write access to: check what files exist after a session by running `find /home/claude/.claude/ -type f` inside a running container. Files that Claude Code creates at runtime need writable paths.

The known file is `.claude.json` — but this lives at `/home/claude/.claude.json` (home directory root, NOT inside `.claude/`), so it is unaffected.

If Claude Code needs to write files inside `.claude/` at runtime (discovered during testing), create writable subdirectories owned by `claude` for mutable state while keeping the root directory and `settings.json` root-owned:

```bash
mkdir -p /home/claude/.claude/projects
chown claude:claude /home/claude/.claude/projects
```

- [ ] **Step 3: Add Stargate to readiness checks**

In section 7 (readiness verification, around line 306), add after the iptables check (line 319) and before the settings check (line 322):

```bash
if ! curl -sf http://127.0.0.1:9099/health > /dev/null 2>&1; then
    echo "[ENTRYPOINT] WARN: Stargate not healthy" >&2
    READY=false
fi
```

- [ ] **Step 4: Commit**

```bash
git add scripts/entrypoint.sh
git commit -m "feat(entrypoint): add Stargate command control phase with de-privileged server and readiness gate"
```

---

### Task 6: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md:7-11` (security framework table, Command Control row)
- Modify: `CLAUDE.md:182-197` (boot sequence section)

- [ ] **Step 1: Update Command Control row in security framework table**

Replace the row:

```
| **Command Control (pending)** | _Pending replacement by external dependency_ | Dangerous command execution, credential leaks, lateral movement | _TBD_ |
```

With:

```
| **Command Control**           | Stargate: AST-based classification, scope-bound trust, LLM review for YELLOW commands, fail-closed on server unreachable | Dangerous command execution, credential leaks, lateral movement | `scripts/generate-stargate-config.sh`, `scripts/entrypoint.sh`, `claude-settings.json` |
```

- [ ] **Step 2: Update boot sequence**

Replace the numbered boot sequence list (lines 186-197) with:

```
1. Validate secrets
2. Mount tmpfs (filesystem hardening)
3. Extract Grafana OTLP hostname (if credentials set)
4. Start CoreDNS (DNS filtering, with Grafana host if set)
5. Apply iptables (network isolation, with Grafana host if set)
6. Configure git/gh/npm auth (credential setup)
7. Write OTEL env file (if Grafana credentials set)
8. Configure and start Stargate (command control — de-privileged, fail-closed)
9. Copy Claude settings (root-owned, immutable hooks)
10. Remount rootfs read-only
11. Clone repo
12. Readiness checks (CoreDNS, iptables, Stargate, settings, repo)
13. Start Claude Code — invoke `start-claude.sh` in background (flock-synchronized)
```

- [ ] **Step 3: Run prettier**

Run: `bunx prettier --write CLAUDE.md && bunx prettier --check CLAUDE.md`

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update security framework and boot sequence for Stargate integration"
```

---

### Task 7: Update docs/accepted-risks.md

**Files:**
- Modify: `docs/accepted-risks.md`

Update three existing entries to add Stargate as a compensating control. Do NOT mark them as resolved — the underlying risks still exist.

- [ ] **Step 1: Update "Unattended autonomous execution" entry**

In the compensating controls line (line 27), append: `. Stargate command classification gates all Bash tool invocations — YELLOW commands in autonomous mode are blocked (fail-closed) because the "ask user" fallback has no human to approve.`

Update the "Last updated" line (line 30) to: `- **Last updated:** 2026-04-27 (added Stargate command control as compensating control)`

- [ ] **Step 2: Update "Sudoers-mediated token file read" entry**

In the compensating controls line (line 46), append: ` Stargate includes a targeted RED rule that blocks direct reads of /opt/gh-config/.ghtoken via the Bash tool. The gh-wrapper.sh credential helper path runs outside Claude Code's Bash tool and is unaffected.`

Update the "Last updated" line (line 49) to: `- **Last updated:** 2026-04-27 (added Stargate RED rule as compensating control)`

- [ ] **Step 3: Update "Single PAT" entry**

In the compensating controls line (line 56), append: ` Stargate's github_owners scope restricts gh CLI operations to the repo owner derived from REPO_URL, preventing unscoped GitHub API access.`

Update the "Last updated" line (line 59) to: `- **Last updated:** 2026-04-27 (added Stargate scope restriction as compensating control)`

- [ ] **Step 4: Run prettier**

Run: `bunx prettier --write "docs/accepted-risks.md" && bunx prettier --check "docs/accepted-risks.md"`

- [ ] **Step 5: Commit**

```bash
git add docs/accepted-risks.md
git commit -m "docs: update accepted risks with Stargate compensating controls"
```

---

### Task 8: Final formatting check and verification

**Files:**
- All modified files

- [ ] **Step 1: Run prettier on all Markdown files**

Run: `bunx prettier --check "**/*.{ts,md}"`

If failures: `bunx prettier --write "**/*.{ts,md}"`

- [ ] **Step 2: Verify all files are committed**

Run: `git status`

Expected: clean working tree.

- [ ] **Step 3: Review full diff from main**

Run: `git log --oneline main..HEAD`

Expected: 7 commits covering:
1. Dockerfile (stargate binary + script COPY)
2. claude-settings.json (hooks)
3. generate-stargate-config.sh (new script)
4. start-claude.sh (STARGATE_CONFIG env var)
5. entrypoint.sh (Phase 4 + settings immutability + readiness)
6. CLAUDE.md (docs)
7. accepted-risks.md (docs)
