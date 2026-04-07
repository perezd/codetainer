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
- **Compensating controls:** Network isolation limits exfiltration targets. Users always SSH in to observe and interact. The prompt's SHA-256 hash is logged at boot for audit correlation.
- **Severity:** Medium
- **Date identified:** 2026-03-30 (identified during panel review of #23)
- **Last updated:** 2026-04-06 (removed command approval references — layer pending replacement)

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
- **Compensating controls:** The sudoers entry is narrowly scoped to one specific file path (no wildcards). The read-only rootfs (remounted read-only after setup) prevents modification of the sudoers entry, wrapper script, and token file. Network isolation independently limits exfiltration targets.
- **Severity:** Medium
- **Date identified:** 2026-04-02 (identified during panel review of #32)
- **Last updated:** 2026-04-06 (removed command approval references — layer pending replacement)

### Single PAT for GitHub API and npm registry auth

- **Affected layer:** Container Hardening
- **Description:** Both `GH_TOKEN` (GitHub API / git credential helper) and `CODETAINER_NPM_TOKEN` (GitHub Packages npm registry) are derived from the same `GH_PAT` at runtime. Compromise of either access path exposes the full PAT, which may have scopes beyond what each consumer needs individually.
- **Why it can't be resolved:** GitHub fine-grained PATs do not yet support the scope separation needed to create two tokens with disjoint permissions for `gh` CLI operations vs. npm registry access. The operational complexity of managing two classic PATs with minimal-overlap scopes exceeds the security benefit in a single-purpose container.
- **Compensating controls:** The `CODETAINER_NPM_TOKEN` abstraction allows a future split to separate tokens without changing consumer code. Network isolation limits where either token can be used. Operators should follow least-privilege guidance: prefer fine-grained PATs with minimal scopes.
- **Severity:** Low
- **Date identified:** 2026-04-02 (identified during panel review of #32)
- **Last updated:** 2026-04-06 (removed command approval references — layer pending replacement)

---

## Resolved Risks

_No resolved risks yet._
