# Universal Behavioral Policies

These policies apply across all repositories in the VM. They govern skill usage, git workflow, issue-driven development, and CLI conventions.

---

## Required Skills

These skills are mandatory process gates — not optional.

| Trigger                                                                  | Skill                             |
| ------------------------------------------------------------------------ | --------------------------------- |
| Starting any new feature, design, or creative work — no matter how small | `/brainstorming`                  |
| Design is approved and implementation needs a plan                       | `/writing-plans`                  |
| Implementation plan is ready to execute                                  | `/executing-plans`                |
| Receiving PR review comments or code review feedback                     | `/receiving-code-review`          |
| Encountering any bug, test failure, or unexpected behavior               | `/systematic-debugging`           |
| About to claim work is complete, fixed, or passing                       | `/verification-before-completion` |
| Completing a task or major feature                                       | `/requesting-code-review`         |
| Implementation is complete and ready to integrate                        | `/finishing-a-development-branch` |
| After creating a PR                                                      | `/copilot-review`                 |

**Workflow order:** `/brainstorming` → `/writing-plans` → `/executing-plans` → `/verification-before-completion` → `/requesting-code-review` → `/finishing-a-development-branch` → `/copilot-review`.

`/systematic-debugging` and `/receiving-code-review` are reactive — invoke when their triggers occur at any point.

### Skill Overrides

**`/executing-plans`:** Always use `superpowers:subagent-driven-development` instead of the base executing-plans skill. Skip the selection prompt — subagent-driven development is the default execution strategy. Only deviate if the user has explicitly instructed otherwise in advance.

**`/finishing-a-development-branch`:** Always default to "Push and create a Pull Request" (Option 2) without presenting the interactive prompt. This aligns with the project's PR-based integration model — all changes go through pull requests. Only deviate from this default if the user has explicitly instructed otherwise in advance.

**Continuous execution after approval:** Once the user approves a plan or says to proceed (e.g., "looks good", "go ahead", "continue"), execute through the full workflow without pausing to ask "ready to proceed?" or "shall I continue?" at skill transitions. The user's approval carries forward — do not re-ask for permission at each phase boundary.

---

## Git Workflow

### Session Initialization

Before beginning any task, complete these initialization steps in order:

1. **Sync with upstream** — First, switch to `main` (`git switch main`). If switching fails (e.g., `main` is checked out in another worktree), do not run `git pull` from the current branch — use `git fetch origin main` instead and proceed. Once on `main`, detect whether the repo is a fork: extract the origin remote's `owner/repo` from `git remote get-url origin`, then run `gh repo view <origin-owner/repo> --json isFork,parent` (the repo must be specified explicitly — without it, `gh` resolves forks to the parent repo and `isFork` is always `false`). If it is a fork, sync main with upstream: `gh repo sync <fork-owner>/<fork-repo> --source <parent-owner>/<parent-repo> --branch main`, then `git pull origin main`. Lastly, ensure the fork's origin main branch is pushed and synced with the upstream main branch at GitHub. If the repo is not a fork, run `git pull origin main` to ensure the local checkout is current with its remote. If any step fails, warn the user and proceed — do not block the task.

All work — whether writing code, answering questions, or reviewing files — should be based on the latest upstream state. This is a best-effort step that runs from the main branch before any worktree is created.

### Worktree-First Development

All changes happen in git worktrees, never directly on main. Each worktree gets a descriptive branch name reflecting the change. The default worktree directory is `.worktrees/` (project-local, hidden) — use this location when creating worktrees unless the project specifies otherwise.

**Subagent working directory discipline:** When dispatching subagents (implementation agents, panel review experts, or any Agent tool invocation that will modify files or commit):

1. **Include the worktree absolute path** in every subagent task description. Subagents start with a fresh context and default to the repo root — they will commit to main unless explicitly directed elsewhere.
2. **Require CWD verification before commits.** The subagent must confirm its working directory matches the intended worktree path before staging or committing any changes.
3. **Consider `isolation: "worktree"`** on the Agent tool as an alternative. This gives each subagent its own isolated worktree and branch, preventing accidental commits to main. Use this when subagents work on independent tasks that don't need to build on each other's changes in a shared branch. Use a shared worktree (items 1–2) when subagents must coordinate sequential work on the same branch.

### PR-Based Integration

Every change goes through a pull request — no direct commits to main. PR descriptions must include:

- Summary of the change
- Layer-impact assessment
- Panel review output with final sign-off (if applicable)
- Test plan

### Fork-Aware PRs

Before creating a PR, detect whether the repo is a fork with an upstream parent:

1. Extract the origin remote's `owner/repo` from `git remote get-url origin`, then run `gh repo view <origin-owner/repo> --json isFork,parent` to check. The repo must be specified explicitly — without it, `gh` resolves forks to the parent repo and `isFork` is always `false`.
2. If the repo **is a fork** (i.e., `isFork` is true and `parent` exists), target the upstream parent repo. Use `gh pr create --repo <parent-owner>/<parent-repo>` so the PR is sent upstream.
3. If the repo **is not a fork**, create the PR against the local remote origin as usual.

This ensures contributions flow to the correct repository without manual intervention.

### Syncing a Fork After Merge

After a PR is merged upstream, sync the fork's main branch to pick up the merged changes:

1. Sync via the GitHub API: `gh repo sync <fork-owner>/<fork-repo> --source <parent-owner>/<parent-repo> --branch main`
2. Pull locally: `git pull origin main`

This must be done after each upstream merge to keep the fork and local checkout current.

### PR Lifecycle

After creating a PR, invoke `/copilot-review` to run the automated Copilot review loop. For human reviewer feedback, use `/receiving-code-review` before implementing suggestions. Never abandon a PR — see it through to resolution.

After every push to a PR branch, review the current PR description (summary, layer-impact assessment, security design checklist, test plan) against the totality of changes in the PR. If any section no longer accurately reflects the implementation, update the PR description in the same operation — do not defer description updates to a later step.

### Conventional Commits

All commit messages follow the conventional commits standard:

- Format: `type(scope): description`
- Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `ci`
- Scope references the affected layer or component when relevant:
  - `feat(docker): add new system package`
  - `fix(network): add missing domain to allowlist`
  - `refactor(entrypoint): reorder boot sequence`
  - `docs: update accepted risks registry`
- Describe the "why" not just the "what."

### Formatting

For projects using Bun or TypeScript:

Run `bunx prettier --write "**/*.{ts,md}"` on all TypeScript and Markdown files before committing. Run `bunx prettier --check "**/*.{ts,md}"` to verify.

When dispatching subagents that modify TypeScript or Markdown files, include an explicit `bunx prettier --check "**/*.{ts,md}"` step in the task description. The check must cover all modified files — not just the primary target — and run after implementation, before the subagent reports completion.

---

## Issue-Driven Workflow Gate

When the user provides a full GitHub issue URL, or a shorthand issue reference (e.g., `#24`, `owner/repo#24`) with explicit context confirming it is the work target, invoke the `/issue-driven-workflow` skill. Do not infer an originating issue from branch names, commit messages, or other indirect context. An issue number mentioned only as background or comparison is not sufficient to activate the skill.

### Label-Based Routing

After fetching issue metadata, route to the appropriate skill based on issue labels. Labels are the authoritative signal; description analysis is the fallback.

| Label                         | Skill                   | Effect                                                          |
| ----------------------------- | ----------------------- | --------------------------------------------------------------- |
| `bug`, `regression`, `defect` | `/systematic-debugging` | Invoke before `/brainstorming` — root-cause analysis first      |
| `enhancement`, `feature`      | `/brainstorming`        | Invoke directly — skip debugging, start with design exploration |

**Evaluation order:**

1. Extract label names from the fetched issue metadata.
2. Evaluate the routing table rows in the order shown above (case-insensitive label matching). Issue label ordering is not significant. The first routing-table row with any matching label determines the skill, so bug-class labels (`bug`, `regression`, `defect`) take precedence over enhancement-class labels (`enhancement`, `feature`) on multi-label issues.
3. If no routing-table row matches any issue label, fall back to the description-based heuristic: analyze the issue title and body for bug-like language (e.g., "broken", "error", "fails", "unexpected"). If it clearly looks like a bug, route to `/systematic-debugging`. If the description is unclear or inconclusive, also route to `/systematic-debugging`. Only default to `/brainstorming` when the description is clearly not bug-like.

**When ambiguous** (no labels, description is unclear or inconclusive), default to treating the issue as a bug and route to `/systematic-debugging`. It is lower cost to debug unnecessarily than to skip root-cause analysis on a real defect.

### Additional Overrides

Evaluate these overrides **before invoking any skill**. These take precedence over skill-default behaviors.

1. **Artifact routing** — Design specs and implementation plans are posted as comments on the originating issue, not written to local files. Skill defaults for file output paths (`docs/superpowers/specs/`, `docs/superpowers/plans/`) do not apply.
2. **Panel review gate** — The design comment must complete full panel review with all experts signing off before being posted to the issue.
3. **Continuous flow** — If the user has explicitly said to continue (e.g., "looks good continue", "proceed", "keep going"), transition through brainstorming → writing-plans → execution without pausing for additional confirmation at each phase boundary. The user's instruction to continue carries forward.

---

## CLI Best Practices

### File Creation

Use the Write tool (or Edit tool for modifications) for all file creation — never use bash heredocs, `cat`, `echo`, or `printf` to write file content. This includes temp files, `gh` command bodies, API payloads, and any other content. Reserve Bash for running commands, not writing files.

### GitHub CLI

Never pass arbitrary text content inline on a `gh` command line. Inline `--body` strings, `-F field=value` arguments, and heredoc constructs containing special characters are fragile and error-prone. The goal is to keep user-authored text out of the command string by any means necessary.

**Always:** Write content to a temp file first (using the Write tool), then reference it from the `gh` command in a **separate** Bash invocation. Use whichever mechanism fits the command:

- `--body-file /tmp/body.md` — preferred for `gh issue comment`, `gh pr create`, `gh pr edit`, etc.
- `--input /tmp/payload.json` — preferred for `gh api` calls
- `--body "$(cat /tmp/body.md)"` — last-resort fallback only for commands that lack a file-input flag

These can be combined as needed. The rule is: do not put literal text in the command string; prefer `--body-file`/`--input`, and use `--body "$(cat ...)"` only when no file-based option exists.
