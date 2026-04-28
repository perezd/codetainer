# Codetainer

## Security Framework

This project enforces a three-layer security model. You must evaluate every change against all three layers.

| Layer                   | Defense                                                                                                                                 | Protects Against                                                                      | Key Files                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **Container Hardening** | Non-root user (UID 1000), read-only rootfs, size-limited tmpfs (512MB /workspace, 1GB /home/claude, 512MB /tmp)                         | Privilege escalation, persistent compromise, disk-based DoS                           | `Dockerfile`, `scripts/entrypoint.sh`                                                  |
| **Network Isolation**   | Default-deny iptables (OUTPUT DROP), domain allowlist, CoreDNS NXDOMAIN for unlisted domains, metadata IP blocks, UDP drop (except DNS) | Data exfiltration, C2 communication, unauthorized API access, metadata endpoint abuse | `network/domains.conf`, `network/Corefile.template`, `network/refresh-iptables.sh`     |
| **Command Control**     | Stargate: AST-based classification, scope-bound trust, LLM review for YELLOW commands, fail-closed on server unreachable                | Dangerous command execution, credential leaks, lateral movement                       | `scripts/generate-stargate-config.sh`, `scripts/entrypoint.sh`, `claude-settings.json` |

**Defense-in-depth:** No single layer is sufficient alone. If you weaken one layer, you must add compensating controls in another. Each layer is independently enforceable.

**Credentials:** `GH_PAT`, `CLAUDE_CODE_OAUTH_TOKEN`, and `FLY_ACCESS_TOKEN` are the high-value secrets. Never add code paths that leak these to stdout, logs, or network.

---

## Modification Protocol

### Layer-Impact Assessment

Before every modification, you must explicitly state:

1. Which security layers are affected (or "none").
2. Why — a brief justification, not just a label.
3. Whether a full panel review is triggered.

### Panel Review

A full synthetic panel review is required for: changes to any security-layer file (see key files above), new scripts that run as root, Dockerfile modifications, new binaries or packages, domain allowlist changes, credential handling changes, and new designs or specifications.

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

### Security Design Checklist

Before the panel convenes, the design must explicitly address each of the following. These are not optional — gaps here have historically led to mid-PR pivots and late-stage security findings (see #36 AAR).

Responses must cite **specific artifacts** — file paths, permission modes, code locations, data sources, and actor identities. Answers consisting only of "No" or "N/A" without justification will be returned for revision. If a question is genuinely not applicable to the change, state "N/A" with a one-line justification.

Checklist responses are recorded in the design artifact (the issue design comment per `/issue-driven-workflow`, or the PR description for changes not tied to an issue).

- **Trust anchor mutability:** Is any data source this design relies on writable at runtime? By whom? Through what mechanisms (direct file edit, command, env var, config include)? (Prevents mutable trust anchors — #36 lesson)
- **File and output visibility:** Who can read files this design creates or modifies? Could their contents contain credentials, tokens, or other secrets? Trace the origin of every value written to files, logs, stdout, or network — could any upstream source (env vars, config files, user input, API responses) inject sensitive material? (Prevents credential leaks via world-readable files — #36 lesson)
- **Allowlist vs blocklist:** Does this design enumerate known-good values (allowlist) or known-bad values (blocklist)? If blocklist, what happens when a new value is introduced? (Prevents bypass via unenumerated values)
- **Fail mode:** When this component errors, does the system fail-open or fail-closed? Is that the right default for this security context? (Prevents silent security degradation on error)
- **Temporal safety:** At what point in the boot or execution sequence does this operation occur? Are there privilege transitions (chown, setuid, capability drops) before or after that could create a TOCTOU window? (Prevents race conditions around privilege boundaries)
- **Network exposure:** Does this design introduce, modify, or depend on any network communication (listeners, outbound connections, DNS resolution)? Could it be used to reach cloud metadata endpoints or bypass the domain allowlist? (Prevents network isolation bypass)
- **Layer compensation:** Does this change weaken any of the three security layers? If so, what compensating control exists in another layer? Describe the specific attack path the weakening enables and how the compensating control blocks it. (Enforces defense-in-depth — core security framework principle)

**Process:**

NOTE: Each expert **MUST** run as a separate subagent with a cleared context. Provide each expert with any associated design/spec documents or plans for extensive review. This could also include any associated background, such as a GitHub issue or an existing PR. Provide commits/diffs if they should be reviewed by the panel as necessary.

0. Before dispatching experts, verify the design author has completed the Security Design Checklist with specific, justified responses. If responses are missing or incomplete, return the design for revision before proceeding with expert evaluation.
1. Each expert evaluates the change from their perspective.
2. Findings are ranked by severity: critical / high / medium / low.
3. Each delivers a verdict: **approve**, **approve-with-conditions**, or **request-changes**.
4. If any expert raises concerns, address them and re-run the panel.
5. Iterate until all experts sign off without concerns.
6. Unresolvable risks go to the accepted risks registry (see `docs/accepted-risks.md`).

The panel is not a rubber stamp. Genuinely reason from each expert's perspective and challenge your own assumptions across rounds. Each round should provide the subagent with the most updated version of the artifact and a brief summary of changes since the previous round.

---

## Accepted Risks

Unresolvable risks identified by the panel are tracked in `docs/accepted-risks.md`. See that file for the registry format and current entries. Never silently delete a risk — mark it as resolved with a date and reference to the resolving PR.

---

## Project Reference

### Policy Source Reference

Behavioral policies are distributed across three locations. Auditors and reviewers should consult all three to understand the full rule set:

1. **User-level `~/.claude/CLAUDE.md`** — Universal behavioral policies (required skills, git workflow, CLI practices, conventional commits, formatting). Source: `user-claude-md/CLAUDE.md` in this repo, copied at boot.
2. **Repo `CLAUDE.md`** (this file) — Project-specific configuration (security model, panel composition, design checklist).
3. **Skills** — Procedural workflows (e.g., `issue-driven-workflow`, `copilot-review`). Source: `skills/` in this repo, copied at boot.

### Commands

```
bunx prettier --check "**/*.{ts,md}" # Check formatting
bunx prettier --write "**/*.{ts,md}" # Fix formatting
```

Container builds are manual. Never build or push Docker images.

### Directory Map

- `network/` — Network isolation (domain allowlist, CoreDNS config, iptables refresh).
- `scripts/` — Runtime scripts (entrypoint/PID 1, SSH handler, session namer, status line).
- `skills/` — User-scoped Claude Code skills (copied to `/home/claude/.claude/skills/` at boot).
- `user-claude-md/` — User-level CLAUDE.md (universal behavioral policies, copied to `~/.claude/CLAUDE.md` at boot).
- `Dockerfile` — Multi-stage container build (Debian bookworm-slim).
- `claude-settings.json` — Claude Code runtime config (model, hooks, plugins, status line).

### Boot Sequence

`scripts/entrypoint.sh` runs as root with a strict dependency order:

1. Validate secrets
2. Mount tmpfs (filesystem hardening)
3. Extract Grafana OTLP hostname (if credentials set)
4. Start CoreDNS (DNS filtering, with Grafana host if set)
5. Apply iptables (network isolation, with Grafana host if set)
6. Configure git/gh/npm auth (credential setup)
7. Write OTEL env file (if Grafana credentials set)
8. Generate Stargate config, copy Claude settings
9. Start Stargate server (command control — de-privileged, hooks fail-closed at invocation)
10. Remount rootfs read-only
11. Clone repo
12. Readiness checks (CoreDNS, iptables, Stargate, settings, repo)
13. Start Claude Code — invoke `start-claude.sh` in background (flock-synchronized, installs plugins/skills/user-level CLAUDE.md before launching)

Plugins are installed by `start-claude.sh` at boot (after marketplace initialization).
OTEL env vars are written to `/tmp/otel/otel-env` (root-only directory, mode 700) by the entrypoint and forwarded through `sudo` by `start-claude.sh` using a key whitelist.

`CLAUDE_PROMPT` (optional env var) — when set via `fly machine run --env`, the prompt is written to a temp file and passed to Claude Code at boot. The prompt hash (not content) is logged for audit. See `docs/accepted-risks.md` for associated risks.

Start-claude runs as a background process after readiness, acquiring an exclusive `flock` on `/tmp/start-claude.lock` during initialization. SSH connections use `attach-claude.sh`, which waits on a shared lock until init completes, then attaches to the tmux session.

This order matters. Filesystem hardening before network setup. Network setup before repo clone. Preserve this chain.

### Testing

- Network changes must be validated against the domain allowlist.
- Script changes must work under the read-only rootfs constraint.
