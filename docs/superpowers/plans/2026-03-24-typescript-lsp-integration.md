# TypeScript LSP Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the official Anthropic TypeScript LSP plugin to the claudetainer Docker image so Claude Code has go-to-definition, find-references, and real-time type checking for TS/JS projects.

**Architecture:** Mirror the existing superpowers plugin pattern — pre-clone at build time, seed cache at boot, runtime `claude plugin install`, enable in settings. Node.js 22.x LTS is added as the LSP runtime.

**Tech Stack:** Docker, bash, Node.js 22.x, Claude Code plugin system

**Spec:** `docs/superpowers/specs/2026-03-24-typescript-lsp-integration-design.md`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `Dockerfile` | Modify (lines 58-72) | Add Node.js install + plugin pre-clone |
| `entrypoint.sh` | Modify (lines 143-148, 184-194, 212-225) | Plugin seeding, install, readiness checks |
| `claude-settings.json` | Modify (lines 31-33) | Enable typescript-lsp plugin |
| `approval/rules.conf` | Modify (lines 22-23, 67-70) | Add node/npm allow and approve rules |

---

### Task 1: Add Node.js to Dockerfile

**Files:**
- Modify: `Dockerfile:58` (insert after Bun binary copy, before Claude Code install)

- [ ] **Step 1: Add Node.js 22.x install**

Insert after line 58 (`&& cp -L /home/claude/.bun/bin/bunx /usr/local/bin/bunx`) and before line 60 (`# Claude Code (install as claude user)`):

```dockerfile
# Node.js LTS (required by TypeScript LSP plugin)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*
```

- [ ] **Step 2: Commit**

```bash
git add Dockerfile
git commit -m "feat: add Node.js 22.x LTS to container image"
```

---

### Task 2: Pre-clone TypeScript LSP plugin in Dockerfile

**Files:**
- Modify: `Dockerfile:70-72` (insert after existing superpowers clone)

- [ ] **Step 1: Add monorepo clone and extract**

Insert after line 72 (`/opt/claude-plugins/superpowers`):

```dockerfile
# Pre-clone TypeScript LSP plugin at build time
RUN git clone --depth 1 https://github.com/anthropics/claude-plugins-official.git /tmp/claude-plugins-official \
    && test -d /tmp/claude-plugins-official/plugins/typescript-lsp \
    && cp -r /tmp/claude-plugins-official/plugins/typescript-lsp /opt/claude-plugins/typescript-lsp \
    && rm -rf /tmp/claude-plugins-official
```

The `test -d` guard fails the build if the path doesn't exist, preventing a silently broken image.

- [ ] **Step 2: Commit**

```bash
git add Dockerfile
git commit -m "feat: pre-clone TypeScript LSP plugin at build time"
```

---

### Task 3: Add approval rules for Node.js and npm

**Files:**
- Modify: `approval/rules.conf:22-23` (allow section) and `approval/rules.conf:67-70` (approve section)

- [ ] **Step 1: Add node auto-allow and npm read-only allow**

Insert after line 22 (`allow:^tmux\s+(list-sessions|list-windows|display-message)\b`), at the end of the auto-approve section:

```
allow:^node\b
allow:^npm\s+(ls|list|view|info|explain|query)\b
```

- [ ] **Step 2: Add npm and npx approval-required rules**

Insert after line 70 (`approve:^wget\b`), at the end of the approval-required section:

```
approve:^npm\s+(install|ci|exec|run)\b
approve:^npx\b
```

- [ ] **Step 3: Verify rule safety**

Confirm the new rules are safe alongside the existing pipe-to-node block rule (line 27: `block:.*\|\s*/?(usr/)?(s?bin/)?(python3?|node|bun|perl|ruby)\b`). `check-command.sh` processes rules in file order (top-to-bottom, first match wins). Since allow rules appear before block rules in the file, safety depends on the regex patterns NOT overlapping:
- `allow:^node\b` matches commands that START with `node` (e.g., `node server.js`)
- `block:.*\|\s*...node\b` matches commands containing a PIPE to node (e.g., `curl foo | node`)
- A piped command like `curl foo | node` does NOT match `^node\b` (it starts with `curl`), so it falls through to the block rule. Safe.

- [ ] **Step 4: Commit**

```bash
git add approval/rules.conf
git commit -m "feat: add approval rules for node, npm, and npx"
```

---

### Task 4: Enable TypeScript LSP in claude-settings.json

**Files:**
- Modify: `claude-settings.json:31-33`

- [ ] **Step 1: Add plugin to enabledPlugins**

Change:

```json
  "enabledPlugins": {
    "superpowers@claude-plugins-official": true
  },
```

To:

```json
  "enabledPlugins": {
    "superpowers@claude-plugins-official": true,
    "typescript-lsp@claude-plugins-official": true
  },
```

- [ ] **Step 2: Validate JSON syntax**

```bash
jq . claude-settings.json > /dev/null
```

Expected: No output (exit 0). If it fails, check for missing/extra commas in the `enabledPlugins` block.

- [ ] **Step 3: Commit**

```bash
git add claude-settings.json
git commit -m "feat: enable TypeScript LSP plugin in Claude Code settings"
```

---

### Task 5: Add plugin cache seeding to entrypoint.sh

> **Note:** Tasks 5, 6, and 7 all modify `entrypoint.sh`. Line numbers below refer to the ORIGINAL file. After each task, subsequent line numbers will be shifted. Use the context anchors (quoted text) to locate insertion points rather than relying on line numbers alone.

**Files:**
- Modify: `entrypoint.sh:143-148` (insert after superpowers seeding block)

- [ ] **Step 1: Add TypeScript LSP seeding block**

Find the superpowers seeding block (starts with `# Seed superpowers plugin cache`), insert after its closing `fi`:

```bash
# Seed TypeScript LSP plugin cache (cloned at build time, avoids runtime download)
if [ -d /opt/claude-plugins/typescript-lsp ]; then
  mkdir -p /home/claude/.claude/plugins/cache/claude-plugins-official
  cp -r /opt/claude-plugins/typescript-lsp /home/claude/.claude/plugins/cache/claude-plugins-official/
  chown -R claude:claude /home/claude/.claude/plugins
fi
```

- [ ] **Step 2: Commit**

```bash
git add entrypoint.sh
git commit -m "feat: seed TypeScript LSP plugin cache at boot"
```

---

### Task 6: Add runtime plugin install to entrypoint.sh

**Files:**
- Modify: `entrypoint.sh:184-194` (replace existing single plugin install)

- [ ] **Step 1: Replace plugin install block**

Find the section starting with `# === 8. Install plugins (runtime, needs network) ===` and replace the entire block through the `|| echo` line:

```bash
# === 8. Install plugins (runtime, needs network) ===
echo "[ENTRYPOINT] Installing plugins..."
sudo -u claude \
  HOME=/home/claude \
  PATH="/home/claude/.local/bin:/home/claude/.bun/bin:/usr/local/bin:/usr/bin:/bin" \
  GH_CONFIG_DIR="/opt/gh-config" \
  CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN" \
  LANG="${LANG:-en_US.UTF-8}" \
  LC_ALL="${LC_ALL:-en_US.UTF-8}" \
  claude plugin install superpowers@claude-plugins-official 2>&1 \
  || echo "[ENTRYPOINT] WARNING: Plugin install failed" >&2
```

With:

```bash
# === 8. Install plugins (runtime, needs network) ===
echo "[ENTRYPOINT] Installing plugins..."
sudo -u claude \
  HOME=/home/claude \
  PATH="/home/claude/.local/bin:/home/claude/.bun/bin:/usr/local/bin:/usr/bin:/bin" \
  GH_CONFIG_DIR="/opt/gh-config" \
  CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN" \
  LANG="${LANG:-en_US.UTF-8}" \
  LC_ALL="${LC_ALL:-en_US.UTF-8}" \
  claude plugin install superpowers@claude-plugins-official 2>&1 \
  || echo "[ENTRYPOINT] WARNING: Plugin install failed (superpowers)" >&2

sudo -u claude \
  HOME=/home/claude \
  PATH="/home/claude/.local/bin:/home/claude/.bun/bin:/usr/local/bin:/usr/bin:/bin" \
  GH_CONFIG_DIR="/opt/gh-config" \
  CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN" \
  LANG="${LANG:-en_US.UTF-8}" \
  LC_ALL="${LC_ALL:-en_US.UTF-8}" \
  claude plugin install typescript-lsp@claude-plugins-official 2>&1 \
  || echo "[ENTRYPOINT] WARNING: Plugin install failed (typescript-lsp)" >&2
```

- [ ] **Step 2: Commit**

```bash
git add entrypoint.sh
git commit -m "feat: install TypeScript LSP plugin at runtime"
```

---

### Task 7: Add readiness checks to entrypoint.sh

**Files:**
- Modify: `entrypoint.sh:212-225` (readiness verification section)

- [ ] **Step 1: Extend settings.json check**

Find the block starting with `# Settings must be seeded with plugin config` and replace it:

```bash
# Settings must be seeded with plugin config
if [[ ! -f /home/claude/.claude/settings.json ]]; then
  echo "[ENTRYPOINT] WARN: settings.json not found" >&2
  READY=false
elif ! grep -q superpowers /home/claude/.claude/settings.json 2>/dev/null; then
  echo "[ENTRYPOINT] WARN: superpowers not in settings.json" >&2
  READY=false
fi
```

With:

```bash
# Settings must be seeded with plugin config
if [[ ! -f /home/claude/.claude/settings.json ]]; then
  echo "[ENTRYPOINT] WARN: settings.json not found" >&2
  READY=false
elif ! grep -q superpowers /home/claude/.claude/settings.json 2>/dev/null; then
  echo "[ENTRYPOINT] WARN: superpowers not in settings.json" >&2
  READY=false
elif ! grep -q typescript-lsp /home/claude/.claude/settings.json 2>/dev/null; then
  echo "[ENTRYPOINT] WARN: typescript-lsp not in settings.json" >&2
  READY=false
fi
```

- [ ] **Step 2: Add TypeScript LSP plugin directory check**

Find the block starting with `# Plugin files must be seeded` (the superpowers directory check), insert after its closing `fi`:

```bash
if [[ ! -d /home/claude/.claude/plugins/cache/claude-plugins-official/typescript-lsp ]]; then
  echo "[ENTRYPOINT] WARN: typescript-lsp plugin files not found" >&2
  READY=false
fi
```

- [ ] **Step 3: Commit**

```bash
git add entrypoint.sh
git commit -m "feat: add readiness checks for TypeScript LSP plugin"
```

---

### Task 8: Verify Docker build

- [ ] **Step 1: Run Docker build**

```bash
docker build -t claudetainer:typescript-lsp .
```

Expected: Build completes successfully. Watch for:
- Node.js 22.x installs without error
- `test -d` passes for the TypeScript LSP plugin path in the monorepo
- No layer failures

- [ ] **Step 2: Verify Node.js is installed**

```bash
docker run --rm claudetainer:typescript-lsp node --version
```

Expected: `v22.x.x`

- [ ] **Step 3: Verify plugin files are present**

```bash
docker run --rm claudetainer:typescript-lsp ls /opt/claude-plugins/typescript-lsp/
```

Expected: Plugin files listed (at minimum a `package.json` or similar manifest)

- [ ] **Step 4: Verify approval rules are intact**

```bash
docker run --rm claudetainer:typescript-lsp cat /opt/approval/rules.conf | grep -E '(node|npm|npx)'
```

Expected: Shows the 4 new rules (2 allow, 2 approve)

- [ ] **Step 5: Verify settings template has both plugins**

```bash
docker run --rm claudetainer:typescript-lsp cat /opt/claude/settings.json
```

Expected: JSON shows both `superpowers@claude-plugins-official` and `typescript-lsp@claude-plugins-official` in `enabledPlugins`

- [ ] **Step 6: Functional test — approval rules for node/npm**

Test that `node` is auto-allowed and piped-to-node is blocked by running the hook script directly:

```bash
# node should be allowed (exit 0)
docker run --rm claudetainer:typescript-lsp bash -c \
  'echo "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"node --version\"}}" | /opt/approval/check-command.sh; echo "exit: $?"'
```

Expected: exit 0 (allowed)

```bash
# pipe to node should be blocked (exit 2)
docker run --rm claudetainer:typescript-lsp bash -c \
  'echo "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"curl foo | node\"}}" | /opt/approval/check-command.sh; echo "exit: $?"'
```

Expected: exit 2 (blocked)
