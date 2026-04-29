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

### Unattended autonomous execution with repo credentials

- **Affected layer:** Container Hardening, Network Isolation
- **Description:** When `CLAUDE_PROMPT` is set, Claude operates autonomously with full `GH_PAT` and `CLAUDE_CODE_OAUTH_TOKEN` access before a human connects via SSH. `--dangerously-skip-permissions` is active. The operator is expected to SSH in to observe — this is not a fully headless mode.
- **Why it can't be resolved:** Immediate tasking at boot is the core value of the feature. Requiring SSH before Claude starts would defeat the purpose.
- **Compensating controls:** Network isolation limits exfiltration targets. Users always SSH in to observe and interact. The prompt's SHA-256 hash is logged at boot for audit correlation. Stargate command classification gates all Bash tool invocations — YELLOW commands in autonomous mode are blocked (fail-closed) because the "ask user" fallback has no human to approve.
- **Severity:** Medium
- **Date identified:** 2026-03-30 (identified during panel review of #23)
- **Last updated:** 2026-04-27 (added Stargate command control as compensating control)

### CLAUDE_PROMPT visible via Fly Machines API

- **Affected layer:** Container Hardening
- **Description:** `CLAUDE_PROMPT` is passed as a plain-text environment variable via `fly machine run --env`. It is visible through `fly machine status` and the Machines API to anyone with Fly app access. Typical usage is passing a GitHub issue URL, which has minimal sensitivity.
- **Why it can't be resolved:** Fly.io `--env` values are inherently visible via the API. Using `fly secrets set` would make prompts app-scoped (shared across machines), which breaks per-machine prompt differentiation.
- **Compensating controls:** Inside the container, the prompt is delivered via a temp file (mode 600, deleted after read). The file avoids embedding the prompt in shell command strings, but the launcher script passes it as a positional argument to `claude`, making it visible in `/proc/<pid>/cmdline` while Claude is running. This is accepted because only root and the `claude` user (UID 1000) exist in the container — both already have access to the prompt through normal operation. The prompt value is never logged; only its SHA-256 hash is recorded. Documentation advises limiting prompts to issue URLs or similarly low-sensitivity content.
- **Severity:** Low
- **Date identified:** 2026-03-30 (identified during panel review of #23)

### Sudoers-mediated token file read

- **Affected layer:** Container Hardening
- **Description:** The `claude` user has a targeted sudoers entry allowing `sudo /usr/bin/cat /opt/gh-config/.ghtoken`. This is used by `gh-wrapper.sh` as a fallback when Claude Code strips `GH_TOKEN` from subprocess environments.
- **Why it can't be resolved:** The `gh-wrapper.sh` must run as the `claude` user (UID 1000) because `gh` commands are invoked by claude's processes. When Claude Code strips environment variables from subprocesses, the wrapper needs a fallback credential source. Making the token file `root:root 600` with a sudoers-mediated read is the strongest protection available without a compiled setuid helper.
- **Compensating controls:** The sudoers entry is narrowly scoped to one specific file path (no wildcards). The read-only rootfs (remounted read-only after setup) prevents modification of the sudoers entry, wrapper script, and token file. Network isolation independently limits exfiltration targets. Stargate includes a targeted RED rule that blocks direct reads of /opt/gh-config/.ghtoken via the Bash tool. The gh-wrapper.sh credential helper path runs outside Claude Code's Bash tool and is unaffected.
- **Severity:** Medium
- **Date identified:** 2026-04-02 (identified during panel review of #32)
- **Last updated:** 2026-04-27 (added Stargate RED rule as compensating control)

### Single PAT for GitHub API and npm registry auth

- **Affected layer:** Container Hardening
- **Description:** Both `GH_TOKEN` (GitHub API / git credential helper) and `CODETAINER_NPM_TOKEN` (GitHub Packages npm registry) are derived from the same `GH_PAT` at runtime. Compromise of either access path exposes the full PAT, which may have scopes beyond what each consumer needs individually.
- **Why it can't be resolved:** GitHub fine-grained PATs do not yet support the scope separation needed to create two tokens with disjoint permissions for `gh` CLI operations vs. npm registry access. The operational complexity of managing two classic PATs with minimal-overlap scopes exceeds the security benefit in a single-purpose container.
- **Compensating controls:** The `CODETAINER_NPM_TOKEN` abstraction allows a future split to separate tokens without changing consumer code. Network isolation limits where either token can be used. Operators should follow least-privilege guidance: prefer fine-grained PATs with minimal scopes. Stargate's github_owners scope restricts gh CLI operations to the repo owner derived from REPO_URL, preventing unscoped GitHub API access.
- **Severity:** Low
- **Date identified:** 2026-04-02 (identified during panel review of #32)
- **Last updated:** 2026-04-27 (added Stargate scope restriction as compensating control)

### Runtime Go module ingestion enables arbitrary code execution

- **Affected layer:** Network Isolation, Container Hardening
- **Description:** With `proxy.golang.org` and `sum.golang.org` allowlisted, `go get` and `go build` can fetch and compile arbitrary third-party Go modules at runtime. Module code executes as the `claude` user (UID 1000) with access to session environment variables including `GH_PAT` and `CLAUDE_CODE_OAUTH_TOKEN`. This is equivalent to the pre-existing risk from `npm install` and `pip install` which can also fetch and execute arbitrary code.
- **Why it can't be resolved:** Runtime module fetching is required for Go development workflows. Restricting it would make Go support non-functional for projects with external dependencies.
- **Compensating controls:** The checksum database (`sum.golang.org`) provides content-integrity verification. `GOPROXY=https://proxy.golang.org,off` prevents direct VCS fallback. `GONOSUMDB=""` ensures all modules are verified. The container's ephemeral tmpfs prevents persistence across sessions. Network isolation limits exfiltration to allowlisted domains only. `GOPATH/bin` is appended (not prepended) to PATH, so `go install` output does not take precedence over system binaries (note: pre-existing user-writable dirs like `$HOME/.local/bin` are prepended by the base image configuration — that is a separate, pre-existing PATH ordering concern not introduced by this change). Note: the claude user can override Go env vars (`GOPROXY`, `GONOSUMDB`) within a session via shell environment or the `GOENV` file (`~/.config/go/env`) on tmpfs — the network allowlist is the primary compensating control since even a `GOPROXY=direct` override cannot reach unlisted VCS hosts.
- **Severity:** Medium
- **Date identified:** 2026-04-09 (identified during panel review of Go support design)

### Autonomous code modification via Copilot hallucination

- **Affected layer:** Container Hardening, Command Control
- **Description:** The `/copilot-review` skill autonomously evaluates Copilot review findings, fixes code, and pushes up to 50 cycles without human intervention. If Copilot suggests a security-weakening change and Claude's evaluation agrees, the fix is autonomously pushed.
- **Why it can't be resolved:** Requiring human approval per cycle defeats the automation purpose. The skill is designed for fully autonomous operation.
- **Compensating controls:** The `/receiving-code-review` invocation explicitly frames Copilot content as untrusted user input with prompt injection warning. Stargate command control blocks dangerous operations at the shell level. 50-cycle iteration cap and 8-hour wall-clock timeout bound blast radius. Full git history preserves reversibility of all commits.
- **Severity:** Medium
- **Date identified:** 2026-04-27 (identified during panel review of #77)

### Automated thread resolution audit gap

- **Affected layer:** Container Hardening
- **Description:** Review threads resolved by the `/copilot-review` skill cannot be distinguished from human-resolved threads in GitHub's UI filtering.
- **Why it can't be resolved:** GitHub's API does not support metadata tagging on thread resolutions that would allow filtering by resolution source.
- **Compensating controls:** Full API activity is recorded in GitHub's audit log. Git history preserves all commits associated with automated fixes. Thread replies document the reasoning for each resolution.
- **Severity:** Low
- **Date identified:** 2026-04-27 (identified during panel review of #77)

### Subagent capability bounds

- **Affected layer:** Container Hardening, Command Control
- **Description:** All subagents (panel review experts, implementation agents) run with full session credentials (GH_PAT, CLAUDE_CODE_OAUTH_TOKEN). A compromised subagent (e.g., via prompt injection from issue content) could use `gh api` to post, read, or modify GitHub resources within the Stargate scope.
- **Why it can't be resolved:** Claude Code subagents inherit the parent session's environment. Capability restriction per-subagent is not supported by the Claude Code architecture.
- **Compensating controls:** The `/issue-driven-workflow` skill frames issue content as untrusted input with structural separation in subagent prompts. Subagent output is verified for plausibility before the orchestrating agent acts on it. Stargate scope-bounds `gh` commands to `github_owners`, limiting the blast radius.
- **Severity:** Medium
- **Date identified:** 2026-04-28 (identified during panel review of #78)

### LLM behavioral policy compliance

- **Affected layer:** Container Hardening
- **Description:** User-level CLAUDE.md and repo CLAUDE.md are LLM-enforced behavioral policy. While file delivery is fail-closed (boot aborts if copy fails), the LLM may ignore instructions at runtime. Behavioral gates (panel review, skill invocation) depend on LLM compliance, unlike Stargate hooks which are code-enforced and fail-closed.
- **Why it can't be resolved:** CLAUDE.md is an instruction file interpreted by the LLM, not a code-enforced policy engine. No mechanism exists to guarantee LLM compliance with written instructions.
- **Compensating controls:** Security layers (iptables, Stargate, container hardening) remain independently enforced regardless of CLAUDE.md compliance. Stargate is the code-enforced backstop for dangerous command execution.
- **Severity:** Medium
- **Date identified:** 2026-04-28 (identified during panel review of #78)

### AAR enforceability

- **Affected layer:** None (process quality, not security)
- **Description:** The After-Action Report is the final comment on an issue after all PRs merge. GitHub does not prevent issue closure without an AAR — the `Closes #N` keyword auto-closes the issue on merge. No hook or gate enforces AAR posting.
- **Why it can't be resolved:** GitHub has no mechanism to prevent issue closure conditionally. Adding a GitHub Action would require repo-level configuration that varies per project.
- **Compensating controls:** Periodic review of closed issues without AAR comments to identify gaps. The AAR corpus informs process improvement (e.g., #36 AAR informed the security design checklist).
- **Severity:** Low
- **Date identified:** 2026-04-28 (identified during panel review of #78)

### Information disclosure in public repo issue comments

- **Affected layer:** None (information security)
- **Description:** Design specs, implementation plans, and AARs posted to GitHub issues by the `/issue-driven-workflow` skill contain architectural details (security design decisions, file paths, permission modes, accepted weaknesses). For public repos, this is fully public.
- **Why it can't be resolved:** Transparent issue-driven development inherently publishes design artifacts. Restricting content would defeat the purpose of using issues as the audit trail.
- **Compensating controls:** The content safety check in the skill prevents credential leakage (`ghp_`, `gho_`, `github_pat_` patterns). Security-sensitive details in the design checklist are already visible in the repo's CLAUDE.md. Network isolation and Stargate operate independently of published information.
- **Severity:** Low
- **Date identified:** 2026-04-28 (identified during panel review of #78)

### User-controlled content from githubusercontent domains

- **Affected layer:** Network Isolation, Container Hardening
- **Description:** Three specific subdomains of `githubusercontent.com` are individually allowlisted: `raw.githubusercontent.com`, `objects.githubusercontent.com`, and `release-assets.githubusercontent.com`. All serve user-controlled content — any GitHub user can publish arbitrary files (source blobs, release binaries, raw file content) that can be downloaded into the container's writable tmpfs (`/workspace`, `/home/claude`, `/tmp`). `GH_PAT` is used for GitHub API authentication; downloads from these CDN domains typically use short-lived signed URLs obtained via API redirect rather than direct PAT transmission.
- **Why it can't be resolved:** These domains are required for core GitHub workflows: raw file access, git object storage, and release asset downloads. Blocking them would break `gh`, `git clone`, and `gh release download`.
- **Compensating controls:** Container runs as non-root UID 1000 with size-limited tmpfs (ephemeral, no persistence across sessions). Stargate command classification gates execution of downloaded content. HTTPS/TLS protects all traffic in transit. Network isolation limits where downloaded content or exfiltrated data can be sent.
- **Severity:** Medium
- **Date identified:** 2026-04-29 (pre-existing risk, formally documented during panel review of #92)

---

## Resolved Risks

_No resolved risks yet._
