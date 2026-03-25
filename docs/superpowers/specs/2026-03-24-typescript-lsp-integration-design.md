# TypeScript LSP Plugin Integration

**Date:** 2026-03-24
**Status:** Approved

## Goal

Integrate the official Anthropic TypeScript LSP plugin (`typescript-lsp@claude-plugins-official`) into the claudetainer Docker image, giving Claude Code go-to-definition, find-references, and real-time type checking for TypeScript and JavaScript projects.

## Approach

Mirror the existing superpowers plugin pattern: pre-clone at build time, seed the plugin cache at boot, run `claude plugin install` at runtime, and enable in settings.

## Changes

### 1. Dockerfile — Node.js Installation

Install Node.js 22.x LTS from NodeSource. Placed after Bun install, before Claude Code install. Required as the runtime for `typescript-language-server`.

```dockerfile
# Node.js LTS (required by TypeScript LSP plugin)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*
```

`deb.nodesource.com` is a build-time-only dependency — no `domains.conf` change needed since the image build runs outside the container's network lockdown.

### 2. Dockerfile — Plugin Pre-clone

Clone the `claude-plugins-official` monorepo (shallow), extract the `typescript-lsp` subdirectory, and discard the rest.

```dockerfile
# Pre-clone TypeScript LSP plugin at build time
RUN git clone --depth 1 https://github.com/anthropics/claude-plugins-official.git /tmp/claude-plugins-official \
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

Extend the plugin install section to install both plugins:

```bash
claude plugin install superpowers@claude-plugins-official 2>&1 \
  || echo "[ENTRYPOINT] WARNING: Plugin install failed (superpowers)" >&2

claude plugin install typescript-lsp@claude-plugins-official 2>&1 \
  || echo "[ENTRYPOINT] WARNING: Plugin install failed (typescript-lsp)" >&2
```

### 5. claude-settings.json — Enable Plugin

Add to `enabledPlugins`:

```json
"enabledPlugins": {
  "superpowers@claude-plugins-official": true,
  "typescript-lsp@claude-plugins-official": true
}
```

### 6. entrypoint.sh — Readiness Checks

Add a check for the TypeScript LSP plugin files alongside the existing superpowers check:

```bash
if [[ ! -d /home/claude/.claude/plugins/cache/claude-plugins-official/typescript-lsp ]]; then
  echo "[ENTRYPOINT] WARN: typescript-lsp plugin files not found" >&2
  READY=false
fi
```

Add a settings.json verification for typescript-lsp alongside the existing superpowers check:

```bash
elif ! grep -q typescript-lsp /home/claude/.claude/settings.json 2>/dev/null; then
  echo "[ENTRYPOINT] WARN: typescript-lsp not in settings.json" >&2
  READY=false
fi
```

## Files Changed

| File | Change |
|---|---|
| `Dockerfile` | Add Node.js 22.x install; clone monorepo and extract `typescript-lsp` |
| `entrypoint.sh` | Seed plugin cache; add plugin install; add readiness checks |
| `claude-settings.json` | Add `typescript-lsp@claude-plugins-official` to `enabledPlugins` |

## Files NOT Changed

- `network/domains.conf` — existing allowlist covers all needed domains
- `approval/rules.conf` — no new commands need approval rules
- `start-claude` — no changes to SSH login flow
- `network/refresh-iptables.sh` — no network changes

## Dependencies

- Node.js 22.x LTS (installed in image)
- `typescript-language-server` and `typescript` npm packages (zero external dependencies, installed by the plugin)
- Plugin source: `https://github.com/anthropics/claude-plugins-official/tree/main/plugins/typescript-lsp`

## Supported File Types

`.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`

## Image Size Impact

~60-80MB increase from Node.js installation. Plugin files are negligible.
