# Flyctl Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add flyctl to the container with runtime Fly.io API access, Tier 1 hard-blocks for auth/lateral-movement, and Tier 2 hot-word escalation for mutating commands.

**Architecture:** Install flyctl binary, add `api.fly.io` to network allowlist, add block-patterns and hot words to `rules.conf`, add classification hint to Haiku prompt, update README.

**Tech Stack:** flyctl CLI, existing approval pipeline (rules.conf + classifier.ts)

**Spec:** `docs/superpowers/specs/2026-03-26-flyctl-integration-design.md`

---

## File Structure

```
Dockerfile                    # MODIFY: already has install step, verify fly symlink
network/domains.conf          # MODIFY: add api.fly.io
approval/rules.conf           # MODIFY: add fly block-patterns and hot words
approval/classifier.ts        # MODIFY: add flyctl hint to Haiku system prompt
README.md                     # MODIFY: file layout, approving commands, security, troubleshooting
```

---

### Task 1: Add api.fly.io to network allowlist

**Files:**
- Modify: `network/domains.conf`

- [ ] **Step 1: Add the domain**

Append to `network/domains.conf`, after the GitHub Packages section:

```
# Fly.io API
api.fly.io
```

- [ ] **Step 2: Commit**

```bash
git add network/domains.conf
git commit -m "feat(fly): add api.fly.io to network allowlist"
```

---

### Task 2: Add flyctl approval rules

**Files:**
- Modify: `approval/rules.conf`

- [ ] **Step 1: Add Tier 1 hard-block rules**

Append after the git safety section (after line 55 `block-pattern:^git\s+push\s+.*--tags`), before the credential leak section:

```conf

# Fly.io credential management (user handles interactively via ! shell escape)
block-pattern:^fly\s+auth\b
block-pattern:^fly\s+tokens?\b

# Fly.io lateral movement (SSH/proxy/sftp/console to other machines)
block-pattern:^fly\s+ssh\b
block-pattern:^fly\s+proxy\b
block-pattern:^fly\s+sftp\b
block-pattern:^fly\s+console\b
```

- [ ] **Step 2: Add FLY token variables to credential leak block**

Change line 58 from:

```conf
block-pattern:\$\{?(CLAUDE_CODE_OAUTH_TOKEN|GH_PAT)\b
```

To:

```conf
block-pattern:\$\{?(CLAUDE_CODE_OAUTH_TOKEN|GH_PAT|FLY_ACCESS_TOKEN|FLY_API_TOKEN)\b
```

- [ ] **Step 3: Add Tier 2 hot words**

Append to the hot words section, after `hot:GH_PAT`:

```conf

# Fly.io mutating commands (read-only commands like fly status/logs are default-allow)
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

# Fly.io credential variables and config directory
hot:FLY_ACCESS_TOKEN
hot:FLY_API_TOKEN
hot:.fly/
```

- [ ] **Step 4: Run tests to verify no regressions**

Run: `cd /Users/derek/src/claudetainer/approval && bun test`
Expected: All tests PASS (existing tests should not be affected by additive rule changes).

- [ ] **Step 5: Commit**

```bash
git add approval/rules.conf
git commit -m "feat(fly): add block-patterns and hot words for flyctl commands"
```

---

### Task 3: Add flyctl classification hint to Haiku prompt

**Files:**
- Modify: `approval/classifier.ts`

- [ ] **Step 1: Add the hint**

In the `SYSTEM_PROMPT` constant, inside the `## Classification rules` section, after the APPROVE rules (after line `- Downloads or executes external code`), add:

```
- For fly/flyctl commands: read-only operations (status, logs, list) should be ALLOW; state-changing operations (deploy, scale, destroy, secrets) should be APPROVE.
```

- [ ] **Step 2: Run tests**

Run: `cd /Users/derek/src/claudetainer/approval && bun test`
Expected: All tests PASS.

- [ ] **Step 3: Commit**

```bash
git add approval/classifier.ts
git commit -m "feat(fly): add flyctl classification hint to Haiku system prompt"
```

---

### Task 4: Verify Dockerfile

**Files:**
- Verify: `Dockerfile` (already modified, just confirm correctness)

- [ ] **Step 1: Verify the fly symlink**

Confirm `Dockerfile` lines 43-45 read:

```dockerfile
# Fly CLI
RUN curl -fsSL https://fly.io/install.sh | sh \
    && ln -s /root/.fly/bin/flyctl /usr/local/bin/fly
```

No changes needed — already in place. No commit for this task.

---

### Task 5: Update README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add `fly` to file layout**

In the `/usr/local/bin/` section (around line 332), add `fly` after `coredns`:

```
├── fly              # Fly.io CLI
```

- [ ] **Step 2: Update "Approving Commands" section**

In the Tier description (around line 213), update the Tier 1 bullet to mention fly:

The current Tier 1 description says dangerous commands like `sudo, eval, rm -rf /, git push --force, etc.` — add `, fly auth/ssh/proxy` to that list.

Add a paragraph after the tier description:

```markdown
**Fly.io commands:** Read-only fly commands (`fly status`, `fly logs`, `fly releases`, etc.) are allowed without approval. Mutating commands (`fly deploy`, `fly scale`, `fly secrets`, etc.) are escalated to Haiku for classification. `fly auth`, `fly tokens`, `fly ssh`, `fly proxy`, `fly sftp`, and `fly console` are hard-blocked — authenticate via `! fly auth login` in the terminal pane.
```

- [ ] **Step 3: Add blast radius warning to security section**

In the Layer 3 security section (around line 265), add a bullet:

```markdown
- **Fly.io auth blast radius**: Fly tokens are org-scoped (unlike the fine-grained GH_PAT). An authenticated session grants access to ALL apps in the org. Use short-lived tokens (`fly tokens create --expiry 1h`) or a dedicated Fly org.
```

- [ ] **Step 4: Add fly auth to troubleshooting**

Add a new troubleshooting subsection:

```markdown
### Fly.io authentication

flyctl is not authenticated by default. To authenticate:
```bash
# In the terminal pane or via ! in Claude Code
! fly auth login
```
The token is stored in memory (tmpfs) and lost on restart.
```

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: add flyctl to README — file layout, approval rules, security, troubleshooting"
```
