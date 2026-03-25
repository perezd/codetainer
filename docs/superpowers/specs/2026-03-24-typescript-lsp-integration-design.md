# TypeScript LSP Plugin Integration

**Date:** 2026-03-24
**Status:** Approved

## Goal

Integrate the official Anthropic TypeScript LSP plugin (`typescript-lsp@claude-plugins-official`) into the claudetainer Docker image, giving Claude Code go-to-definition, find-references, and real-time type checking for TypeScript and JavaScript projects.

## Approach

Mirror the existing superpowers plugin pattern: pre-clone at build time, seed the plugin cache at boot, run `claude plugin install` at runtime, and enable in settings.

## Changes

### 1. Dockerfile — Node.js Installation

Install Node.js 22.x LTS from NodeSource. Placed after the Bun binary copy (line 58, still under `USER root`), before `USER claude` for Claude Code install. Required as the runtime for `typescript-language-server`.

```dockerfile
# Node.js LTS (required by TypeScript LSP plugin)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*
```

`deb.nodesource.com` is a build-time-only dependency — no `domains.conf` change needed since the image build runs outside the container's network lockdown.

### 2. Dockerfile — Plugin Pre-clone

Clone the `claude-plugins-official` monorepo (shallow), extract the `typescript-lsp` subdirectory, and discard the rest. The `test -d` guard fails the build if the expected path does not exist (prevents a broken image from silently building).

```dockerfile
# Pre-clone TypeScript LSP plugin at build time
RUN git clone --depth 1 https://github.com/anthropics/claude-plugins-official.git /tmp/claude-plugins-official \
    && test -d /tmp/claude-plugins-official/plugins/typescript-lsp \
    && cp -r /tmp/claude-plugins-official/plugins/typescript-lsp /opt/claude-plugins/typescript-lsp \
    && rm -rf /tmp/claude-plugins-official
```

### 3. entrypoint.sh — Plugin Cache Seeding

After the existing superpowers seeding block, add:

```bash
# Seed TypeScript LSP plugin cache
if [ -d /opt/claude-plugins/typescript-lsp ]; then
  mkdir -p /home/claude/.claude/plugins/cache/claude-plugins-official
  cp -r /opt/claude-plugins/typescript-lsp /home/claude/.claude/plugins/cache/claude-plugins-official/
  chown -R claude:claude /home/claude/.claude/plugins
fi
```

### 4. entrypoint.sh — Runtime Plugin Install

Extend the existing `sudo -u claude` plugin install section to install both plugins. Both commands must run within the same environment wrapper used by the existing superpowers install:

```bash
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

**Network note:** The plugin install step may fetch packages from `registry.npmjs.org` to install `typescript-language-server` and `typescript`. This domain is already in `domains.conf` (line 13), so no network changes are needed.

### 5. claude-settings.json — Enable Plugin

Add to `enabledPlugins`:

```json
"enabledPlugins": {
  "superpowers@claude-plugins-official": true,
  "typescript-lsp@claude-plugins-official": true
}
```

### 6. approval/rules.conf — Allow Node.js and npm

The TypeScript LSP runs `node` directly to start the language server process. Add allow rules for `node` (direct invocation only — piped-to-node is already hard-blocked) and `npm`/`npx` (needed if the plugin installs dependencies via npm). Add these to the auto-approve section:

```
allow:^node\b
allow:^npm\s+(ls|list|view|info|explain|query)\b
approve:^npm\s+(install|ci|exec|run)\b
approve:^npx\b
```

Rationale:
- `node` auto-allowed: needed for the LSP server process. The existing block rule `block:.*\|\s*/?(usr/)?(s?bin/)?(python3?|node|bun|perl|ruby)\b` still prevents piping to node.
- `npm` read-only subcommands auto-allowed: safe introspection commands.
- `npm install/ci/exec/run` approval-required: these execute code or install packages, matching the pattern used for `bun add/install` and `bunx`.
- `npx` approval-required: can download and execute arbitrary packages, same risk profile as `bunx` (which is already approval-required).
- `corepack` has no rule and hits `default:block` intentionally — not needed for LSP operation.

### 7. entrypoint.sh — Readiness Checks

Add a check for the TypeScript LSP plugin files (new standalone block):

```bash
if [[ ! -d /home/claude/.claude/plugins/cache/claude-plugins-official/typescript-lsp ]]; then
  echo "[ENTRYPOINT] WARN: typescript-lsp plugin files not found" >&2
  READY=false
fi
```

Extend the existing settings.json verification block (full block shown for context):

```bash
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

If settings.json is missing entirely, the first branch fires and the individual plugin checks are skipped (acceptable — a missing settings file is already a failure).

## Files Changed

| File | Change |
|---|---|
| `Dockerfile` | Add Node.js 22.x install; clone monorepo and extract `typescript-lsp` with build guard |
| `entrypoint.sh` | Seed plugin cache; add plugin install (with sudo wrapper); add readiness checks |
| `claude-settings.json` | Add `typescript-lsp@claude-plugins-official` to `enabledPlugins` |
| `approval/rules.conf` | Add `allow` rules for `node`, `npm`, and `npx` |

## Files NOT Changed

- `network/domains.conf` — existing allowlist covers all needed domains (`registry.npmjs.org` already present for npm fetches)
- `start-claude` — no changes to SSH login flow
- `network/refresh-iptables.sh` — no network changes

## Dependencies

- Node.js 22.x LTS (installed in image)
- `typescript-language-server` and `typescript` npm packages (installed by the plugin, fetched from `registry.npmjs.org` which is already in the domain allowlist)
- Plugin source: `https://github.com/anthropics/claude-plugins-official/tree/main/plugins/typescript-lsp`

## Security Considerations

- **Node.js adds `node`, `npm`, `npx`, `corepack` to the image.** Direct `node` invocation is auto-allowed (needed for LSP). `npm` read-only subcommands are auto-allowed; `npm install/ci/exec/run` and `npx` require approval (matching the `bun`/`bunx` pattern). `corepack` hits `default:block` intentionally. Piping to `node` remains hard-blocked by the existing rule.
- **Plugin install may fetch from npm registry at runtime.** `registry.npmjs.org` is already in the domain allowlist.
- **`deb.nodesource.com` is build-time only** and not accessible at runtime (not in `domains.conf`).

## Supported File Types

`.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`

## Image Size Impact

~60-80MB increase from Node.js installation. Plugin files are negligible.
