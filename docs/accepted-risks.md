# Accepted Risks Registry

Risks identified by the synthetic security panel that cannot be eliminated without breaking core functionality or introducing worse trade-offs. Each risk was reviewed by the panel and accepted with documented justification.

## Entry Format

Each entry includes: risk title, affected layer(s), why it can't be resolved, compensating controls, severity, and date identified. Resolved risks are marked with a resolution date and PR reference — never silently deleted.

---

## Open Risks

### IPv6 egress unrestricted

- **Affected layer:** Network Isolation
- **Description:** All outbound IPv6 traffic is allowed (OUTPUT ACCEPT). IPv4 iptables is the enforcement layer.
- **Why it can't be resolved:** Fly.io SSH requires public IPv6 routing, and Fly's kernel has broken IPv6 conntrack, making IPv6 filtering unreliable.
- **Compensating controls:** All security-relevant egress rules are enforced on IPv4. The domain allowlist and CoreDNS filtering operate at the DNS layer, which is protocol-agnostic.
- **Severity:** Medium
- **Date identified:** 2026-03 (pre-existing, documented in README)

### Settings file writable by claude user

- **Affected layer:** Command Approval
- **Description:** `claude-settings.json` (which configures the approval hook) is owned by the `claude` user. Claude can delete and recreate it, removing the hook.
- **Why it can't be resolved:** Claude Code requires write access to its own settings file for normal operation.
- **Compensating controls:** Layer 2 (network isolation via iptables) and Layer 3 (approval binary at `/opt/approval/`, owned by root) are the real enforcement boundaries. Even if the hook is removed, network isolation prevents data exfiltration and the approval binary cannot be modified.
- **Severity:** Medium
- **Date identified:** 2026-03 (pre-existing, documented in README)

### Unattended autonomous execution with repo credentials

- **Affected layer:** All three (Container Hardening, Network Isolation, Command Approval)
- **Description:** When `CLAUDE_PROMPT` is set, Claude operates autonomously with full `GH_PAT` and `CLAUDE_CODE_OAUTH_TOKEN` access before a human connects via SSH. `--dangerously-skip-permissions` is active. The operator is expected to SSH in to observe — this is not a fully headless mode.
- **Why it can't be resolved:** Immediate tasking at boot is the core value of the feature. Requiring SSH before Claude starts would defeat the purpose.
- **Compensating controls:** Network isolation limits exfiltration targets. Command approval blocks dangerous commands. Mutating `gh` commands (issue/PR creation, comments, edits, repo sync, and API POST/PATCH) targeting repos matching configured git remotes are auto-allowed; high-consequence operations (`gh pr merge`, `gh pr close`, `gh issue close`) and `gh api` DELETE/PUT always require Haiku review. This contextual exemption cannot be expanded at runtime because the approval pipeline reads from a boot-time snapshot of git remote URLs (`/tmp/approval/git-remote-urls.txt`), created by the entrypoint as root in a root-owned directory (mode 555) before claude starts. Runtime modifications to `.git/config`, `~/.gitconfig`, or `GIT_CONFIG_*` environment variables have no effect on the snapshot. Users always SSH in to observe and interact. The prompt's SHA-256 hash is logged at boot for audit correlation.
- **Severity:** Medium
- **Date identified:** 2026-03-30 (identified during panel review of #23)
- **Last updated:** 2026-04-01 (updated for #51 broader contextual gh command exemption)

### Prompt injection via CLAUDE_PROMPT

- **Affected layer:** Command Approval
- **Description:** A crafted `CLAUDE_PROMPT` value could attempt to instruct Claude to bypass security controls or exfiltrate data within allowed network paths. The operator who sets `CLAUDE_PROMPT` has the same trust level as someone with `FLY_ACCESS_TOKEN` — they can already SSH in and direct the agent interactively.
- **Why it can't be resolved:** Prompt validation or signing would add complexity without meaningful security benefit — the operator is already trusted at the same level as the env var they're setting.
- **Compensating controls:** Network isolation, command approval (including hot-wording for mutating gh commands targeting non-related repos, contextual exemption for related repos with high-consequence operations always escalated to Haiku, and `gh repo sync --force` hard-blocked), and Claude Code's own safety training. Operator-as-adversary shares the same trust boundary as `FLY_ACCESS_TOKEN`.
- **Severity:** Medium
- **Date identified:** 2026-03-30 (identified during panel review of #23)
- **Last updated:** 2026-04-01 (updated for #51 broader contextual gh command exemption)

### Mutating gh commands allowed to related repos without Haiku review

- **Affected layer:** Command Approval
- **Description:** The contextual gh command exemption auto-allows mutating operations (`gh issue comment`, `gh issue create`, `gh pr create`, `gh pr comment`, `gh pr edit`, `gh pr review`, `gh repo sync`, and `gh api` POST/PATCH) targeting repos matching configured git remotes — without Haiku LLM classification. High-consequence operations (`gh pr merge`, `gh pr close`, `gh issue close`) are excluded from this exemption and always reach Haiku. This means the agent can create issues, post comments, update content, create PRs, and sync forks on related repos without a human checkpoint.
- **Why it can't be resolved:** The core workflow requires posting design comments, updating implementation plans, creating PRs, and syncing forks with upstream. Requiring Haiku review for every such operation defeats the purpose of the exemption.
- **Compensating controls:** Only repos matching the boot-time remote snapshot are eligible (immutable — snapshot is root-owned, created in a mode-555 directory before claude starts). High-consequence operations (`gh pr merge`, `gh pr close`, `gh issue close`) always escalate to Haiku regardless of repo relationship. `gh repo sync --force` is Tier 1 hard-blocked. For `gh api`, DELETE and PUT methods still require Haiku review. `gh repo sync` validates both the target fork and `--source` repo against the snapshot. The compound-operator guard strips single-quoted argument contents before scanning (bash single quotes are fully literal); unmatched quotes and token-embedded quotes fail-closed to Haiku. `GH_PAT` should follow least-privilege: prefer fine-grained PATs granting only the required permissions on specific repos; if classic PATs are used, `public_repo` suffices for public-only workflows and `repo` only when private-repo access is strictly required. Network isolation limits reachable endpoints. All exempted commands are logged with the full command string for post-incident analysis.
- **Severity:** Low
- **Date identified:** 2026-03-31 (identified during panel review of #36)
- **Last updated:** 2026-04-02 (added single-quote stripping documentation per #57)

### CLAUDE_PROMPT visible via Fly Machines API

- **Affected layer:** Container Hardening
- **Description:** `CLAUDE_PROMPT` is passed as a plain-text environment variable via `fly machine run --env`. It is visible through `fly machine status` and the Machines API to anyone with Fly app access. Typical usage is passing a GitHub issue URL, which has minimal sensitivity.
- **Why it can't be resolved:** Fly.io `--env` values are inherently visible via the API. Using `fly secrets set` would make prompts app-scoped (shared across machines), which breaks per-machine prompt differentiation.
- **Compensating controls:** Inside the container, the prompt is delivered via a temp file (mode 600, deleted after read). The file avoids embedding the prompt in shell command strings, but the launcher script passes it as a positional argument to `claude`, making it visible in `/proc/<pid>/cmdline` while Claude is running. This is accepted because only root and the `claude` user (UID 1000) exist in the container — both already have access to the prompt through normal operation. The prompt value is never logged; only its SHA-256 hash is recorded. Documentation advises limiting prompts to issue URLs or similarly low-sensitivity content.
- **Severity:** Low
- **Date identified:** 2026-03-30 (identified during panel review of #23)

---

## Resolved Risks

_No resolved risks yet._
