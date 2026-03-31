# Claudetainer

## Security Framework

This project enforces a three-layer security model. You must evaluate every change against all three layers.

| Layer                   | Defense                                                                                                                                 | Protects Against                                                                      | Key Files                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **Container Hardening** | Non-root user (UID 1000), read-only rootfs, size-limited tmpfs (512MB /workspace, 256MB /home/claude, 128MB /tmp)                       | Privilege escalation, persistent compromise, disk-based DoS                           | `Dockerfile`, `scripts/entrypoint.sh`                                              |
| **Network Isolation**   | Default-deny iptables (OUTPUT DROP), domain allowlist, CoreDNS NXDOMAIN for unlisted domains, metadata IP blocks, UDP drop (except DNS) | Data exfiltration, C2 communication, unauthorized API access, metadata endpoint abuse | `network/domains.conf`, `network/Corefile.template`, `network/refresh-iptables.sh` |
| **Command Approval**    | Tier 1 regex hard-block, Tier 2 hot-word escalation, Tier 3 Haiku LLM classification                                                    | Dangerous command execution, credential leaks, lateral movement, tmux injection       | `approval/rules.conf`, `approval/check-command.ts`, `approval/classifier.ts`       |

**Defense-in-depth:** No single layer is sufficient alone. If you weaken one layer, you must add compensating controls in another. Each layer is independently enforceable — network isolation works even if command approval is bypassed, and vice versa.

**Credentials:** `GH_PAT`, `CLAUDE_CODE_OAUTH_TOKEN`, and `FLY_ACCESS_TOKEN` are the high-value secrets. Direct variable references (e.g., `$GH_PAT`) are Tier 1 hard-blocked. Indirect references (variable names in strings) are Tier 2 escalated to Haiku. Never add code paths that leak these to stdout, logs, or network.

---

## Modification Protocol

### Layer-Impact Assessment

Before every modification, you must explicitly state:

1. Which security layers are affected (or "none").
2. Why — a brief justification, not just a label.
3. Whether a full panel review is triggered.

### Panel Review

A full synthetic panel review is required for: changes to any security-layer file (see key files above), new scripts that run as root, Dockerfile modifications, new binaries or packages, domain allowlist changes, approval rule changes, credential handling changes, and new designs or specifications.

**Core panel (always present):**

1. Linux container security specialist
2. Cloud infrastructure security engineer
3. Offensive security / red team analyst
4. Compliance and risk management advisor

**Flex specialists (add based on change scope):**

- DNS / network protocol expert — CoreDNS, iptables, domain allowlist changes
- Supply chain security specialist — new dependencies, package sources, build pipeline changes
- Fly.io platform specialist — deployment config, machine sizing, Fly API usage
- Identity / access management expert — credential flows, auth mechanisms, token handling

Select relevant flex specialists based on the nature of the change.

**Process:**

NOTE: Each expert **MUST** run as a separate subagent with a cleared context. Provide each expert with any associated design/spec documents or plans for extensive review. This could also include any associated background, such as a GitHub issue or an existing PR. Provide commits/diffs if they should be reviewed by the panel as necessary.

1. Each expert evaluates the change from their perspective.
2. Findings are ranked by severity: critical / high / medium / low.
3. Each delivers a verdict: **approve**, **approve-with-conditions**, or **request-changes**.
4. If any expert raises concerns, address them and re-run the panel.
5. Iterate until all experts sign off without concerns.
6. Unresolvable risks go to the accepted risks registry (see `docs/accepted-risks.md`).

The panel is not a rubber stamp. Genuinely reason from each expert's perspective and challenge your own assumptions across rounds. Each round should provide the subagent with the most updated version of the artifact and a brief summary of changes since the previous round.

---

## Git Workflow

### Session Initialization

Before beginning any task, complete these initialization steps in order:

1. **Sync with upstream** — First, switch to `main` (`git switch main`). If switching fails (e.g., `main` is checked out in another worktree), do not run `git pull` from the current branch — use `git fetch origin main` instead and proceed. Once on `main`, run `gh repo view --json isFork,parent` to check if the repo is a fork. If it is a fork, sync main with upstream: `gh repo sync <fork-owner>/<fork-repo> --source <parent-owner>/<parent-repo> --branch main`, then `git pull origin main`. If the repo is not a fork, run `git pull origin main` to ensure the local checkout is current with its remote. If any step fails, warn the user and proceed — do not block the task.

All work — whether writing code, answering questions, or reviewing files — should be based on the latest upstream state. This is a best-effort step that runs from the main branch before any worktree is created.

### Worktree-First Development

All changes happen in git worktrees, never directly on main. Each worktree gets a descriptive branch name reflecting the change.

### PR-Based Integration

Every change goes through a pull request — no direct commits to main. PR descriptions must include:

- Summary of the change
- Layer-impact assessment
- Panel review output with final sign-off (if applicable)
- Test plan

### Fork-Aware PRs

Before creating a PR, detect whether the repo is a fork with an upstream parent:

1. Run `gh repo view --json isFork,parent` to check.
2. If the repo **is a fork** (i.e., `isFork` is true and `parent` exists), target the upstream parent repo. Use `gh pr create --repo <parent-owner>/<parent-repo>` so the PR is sent upstream.
3. If the repo **is not a fork**, create the PR against the local remote origin as usual.

This ensures contributions flow to the correct repository without manual intervention.

### Syncing a Fork After Merge

After a PR is merged upstream, sync the fork's main branch to pick up the merged changes:

1. Sync via the GitHub API: `gh repo sync <fork-owner>/<fork-repo> --source <parent-owner>/<parent-repo> --branch main`
2. Pull locally: `git pull origin main`

This must be done after each upstream merge to keep the fork and local checkout current.

### PR Lifecycle

After creating a PR, poll periodically for comments and review feedback. Address reviewer comments, push updates, and re-request review as needed. Continue polling until the PR is approved and merged, or closed. Never abandon a PR — see it through to resolution.

When receiving PR review feedback, always use `/receiving-code-review` before implementing suggestions.

### Conventional Commits

All commit messages follow the conventional commits standard:

- Format: `type(scope): description`
- Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `ci`
- Scope references the affected layer or component when relevant:
  - `feat(approval): add hot word for bunx`
  - `fix(network): add missing domain to allowlist`
  - `refactor(entrypoint): reorder boot sequence`
  - `docs: update accepted risks registry`
- Describe the "why" not just the "what."

### Formatting

Run `bunx prettier --write "**/*.{ts,md}"` on all TypeScript and Markdown files before committing. Run `bunx prettier --check "**/*.{ts,md}"` to verify.

---

## Accepted Risks

Unresolvable risks identified by the panel are tracked in `docs/accepted-risks.md`. See that file for the registry format and current entries. Never silently delete a risk — mark it as resolved with a date and reference to the resolving PR.

---

## Project Reference

### Commands

```
cd approval && bun test              # Run approval classifier unit tests
bunx prettier --check "**/*.{ts,md}" # Check formatting
bunx prettier --write "**/*.{ts,md}" # Fix formatting
```

Container builds are manual. Never build or push Docker images.

### Directory Map

- `approval/` — Command approval pipeline (TypeScript, compiled with `bun build --compile`). Tests in `approval/__tests__/`.
- `network/` — Network isolation (domain allowlist, CoreDNS config, iptables refresh).
- `scripts/` — Runtime scripts (entrypoint/PID 1, SSH handler, session namer, status line).
- `Dockerfile` — Multi-stage container build (Debian bookworm-slim).
- `claude-settings.json` — Claude Code runtime config (model, hooks, plugins, status line).
- `approval/rules.conf` — Block rules (Tier 1 regex) and hot words (Tier 2 substring).

### Boot Sequence

`scripts/entrypoint.sh` runs as root with a strict dependency order:

1. Validate secrets
2. Mount tmpfs (filesystem hardening)
3. Extract Grafana OTLP hostname (if credentials set)
4. Start CoreDNS (DNS filtering, with Grafana host if set)
5. Apply iptables (network isolation, with Grafana host if set)
6. Configure git/gh/npm auth (credential setup)
7. Write OTEL env file (if Grafana credentials set)
8. Copy Claude settings
9. Remount rootfs read-only
10. Clone repo
11. Readiness checks
12. Start Claude Code — invoke `start-claude.sh` in background (flock-synchronized)

Plugins are installed by `start-claude.sh` at boot (after marketplace initialization).
OTEL env vars are written to `/tmp/otel/otel-env` (root-only directory, mode 700) by the entrypoint and forwarded through `sudo` by `start-claude.sh` using a key whitelist.

`CLAUDE_PROMPT` (optional env var) — when set via `fly machine run --env`, the prompt is written to a temp file and passed to Claude Code at boot. The prompt hash (not content) is logged for audit. See `docs/accepted-risks.md` for associated risks.

Start-claude runs as a background process after readiness, acquiring an exclusive `flock` on `/tmp/start-claude.lock` during initialization. SSH connections use `attach-claude.sh`, which waits on a shared lock until init completes, then attaches to the tmux session.

This order matters. Filesystem hardening before network setup. Network setup before repo clone. Preserve this chain.

### Testing

- Approval rule changes must include test cases in `approval/__tests__/`.
- Network changes must be validated against the domain allowlist.
- Script changes must work under the read-only rootfs constraint.

---

## Required Skills

These superpowers skills are mandatory process gates — not optional.

| Trigger                                                                  | Skill                             |
| ------------------------------------------------------------------------ | --------------------------------- |
| Starting any new feature, design, or creative work — no matter how small | `/brainstorming`                  |
| Receiving PR review comments or code review feedback                     | `/receiving-code-review`          |
| Encountering any bug, test failure, or unexpected behavior               | `/systematic-debugging`           |
| Implementation plan is ready to execute                                  | `/executing-plans`                |
| About to claim work is complete, fixed, or passing                       | `/verification-before-completion` |
| Implementation is complete and ready to integrate                        | `/finishing-a-development-branch` |
| Completing a task or major feature                                       | `/requesting-code-review`         |

**Workflow order:** `/brainstorming` → `/writing-plans` → `/executing-plans` → `/verification-before-completion` → `/requesting-code-review` or `/finishing-a-development-branch`.

`/systematic-debugging` and `/receiving-code-review` are reactive — invoke when their triggers occur at any point.

### Skill Overrides

**`/executing-plans`:** Always use `superpowers:subagent-driven-development` instead of the base executing-plans skill. Skip the selection prompt — subagent-driven development is the default execution strategy. Only deviate if the user has explicitly instructed otherwise in advance.

**`/finishing-a-development-branch`:** Always default to "Push and create a Pull Request" (Option 2) without presenting the interactive prompt. This aligns with the project's PR-based integration model — all changes go through pull requests. Only deviate from this default if the user has explicitly instructed otherwise in advance.

---

## Issue-Driven Workflow

When Claude is explicitly given a GitHub issue URL or reference (e.g., `#24`, `owner/repo#24`, or a full URL), the following workflow overrides apply. Do not infer an originating issue from branch names, commit messages, or other indirect context — activation requires an explicit reference.

### Bug Triage

When an issue is a bug, regression, or report of unexpected behavior — whether indicated by GitHub labels (e.g., `bug`, `regression`) or by the issue description — invoke `/systematic-debugging` before proceeding with `/brainstorming` and `/writing-plans`. Identify the root cause first, then design the fix. When it is unclear whether an issue is a bug or a feature request, default to treating it as a bug — it is lower cost to debug unnecessarily than to skip root-cause analysis on a real defect.

### Artifact Routing

All design specs and implementation plans produced by the brainstorming and writing-plans skills are posted as **comments on the originating GitHub issue** instead of being written to local files. No spec or plan files are created in `docs/`. The same skills run in the same order with the same rigor — only the output destination changes.

### Comment Sequence

The issue accumulates comments in this order:

1. **Design comment** — The full panel review process (see Modification Protocol) **must complete with all experts signing off before this comment is posted**. Run multiple rounds if needed until the panel approves without concerns. The design comment must represent a vetted consensus, not a draft. Once posted, it is a stable artifact and should not need frequent updates.
2. **Implementation plan comment** — Uses Markdown checkboxes (`- [ ]` / `- [x]`). As tasks are completed during execution, Claude edits this comment via `gh api` to mark items done, providing real-time progress visibility on the issue.
3. **Supplemental comments** (only if needed) — If significant design issues are discovered during execution, post a new comment explaining what deviated and why. The original design comment is preserved as a historical record; deviations are made explicit rather than silently rewritten.
4. **After-Action Report (AAR)** — Posted after all associated PRs are merged to main. This is the final action taken on the issue. Required sections:
   - What went well?
   - What went wrong?
   - What was learned?
   - What should happen differently next time?

### PR Linkage

PR bodies must include `Closes #N` (or equivalent GitHub closing keyword) so the issue is automatically closed when the PR merges to main.

### CLI Best Practices

When using `gh` commands that accept a body (e.g., `gh issue comment`, `gh pr create`), prefer `--body-file` with a temporary file over inline `--body` strings. Inline bodies with embedded code blocks or special characters can trigger the command approval classifier unnecessarily.

When writing content to a file and then using it in a subsequent command (e.g., writing a temp file then passing it to `gh issue comment --body-file`), use **separate Bash tool invocations** rather than combining them into a single compound command. Compound commands (using `&&`, `;`, heredoc chains) are more likely to trigger the command approval classifier. Two simple commands pass through faster than one compound command.
