# Git Push Ownership Exemption

## Problem

The approval classifier hard-blocks all `git push` commands to `main`/`master`, as well as force pushes, `--delete`, and `--tags`. This is correct for upstream repos the user doesn't own, but overly restrictive when pushing to the user's own fork (identified by matching the GitHub remote owner against `GIT_USER_NAME`).

## Design

### Approach: Pre-tier exemption in `check-command.ts`

Add an early-exit path in the main entry point of `check-command.ts`, before `evaluateTiers()` is called, that detects git push commands targeting an owned remote and allows them immediately.

### Detection flow

1. **Quick regex gate**: Check if the command matches `^git\s+push\b`. If not, skip entirely — zero cost for non-push commands.
2. **Parse target remote from command**: Tokenize the arguments after `git push`, skip any tokens starting with `-` (flags like `-u`, `--force`, `--set-upstream`). The first non-flag token is the remote name. If no non-flag positional argument exists (bare `git push`), default to `origin`.
3. **Resolve remote push URL**: Run `git remote get-url --push <remote>` from the hook's CWD (Claude Code sets this to the workspace directory). Use `--push` to get the URL git actually uses for push operations.
4. **Extract GitHub owner**: Parse the owner from the URL, handling both formats:
   - `https://github.com/<owner>/<repo>` (HTTPS)
   - `git@github.com:<owner>/<repo>` (SSH)
5. **Compare against `GIT_USER_NAME`**: Read from `process.env.GIT_USER_NAME`. Case-insensitive comparison (GitHub usernames are case-insensitive).
6. **Decision**:
   - Match → allow immediately, skip all tier evaluation. Log: `[HOOK] ALLOW (owned remote): <command>`
   - No match / `GIT_USER_NAME` unset / remote fetch fails / non-GitHub URL → fall through to normal tier evaluation

### CWD for subprocess

The `git remote get-url` subprocess runs from the CWD of the hook process itself. Claude Code hooks execute from the project working directory, so this will resolve to the correct repo. If the CWD is not a git repo (e.g., `/workspace` with the repo in `/workspace/repo`), the git command fails and the exemption falls through to normal blocking — fail-safe behavior.

### Fail-safe behavior

Any error in the ownership check (missing env var, git command failure, unparseable URL, non-GitHub host) results in **no exemption** — the command proceeds through normal tier evaluation and will be blocked by existing rules. The system fails closed.

### Logging

The exemption path logs `[HOOK] ALLOW (owned remote): <command>` via `console.error`, consistent with all other decision paths in the classifier.

## Files changed

- **`approval/check-command.ts`**: Add `isOwnedRemotePush()` async function and early-exit logic before `evaluateTiers()` call in the main entry point. Export the helper functions for testing.
- **`approval/__tests__/tiers.test.ts`**: Add test cases for the ownership exemption logic.
- **`approval/rules.conf`**: No changes.
- **`approval/rules.ts`**: No changes.
- **`approval/classifier.ts`**: No changes.

## Test cases

The following cases must be covered:

- `git push origin main` with owned remote → allowed
- `git push origin main` with non-owned remote → falls through to block
- `git push` (bare, no remote specified) with owned `origin` → allowed
- `git push my-fork feature` with owned `my-fork` remote → allowed
- `GIT_USER_NAME` unset → falls through to block
- `git remote get-url` fails (not in a git repo) → falls through to block
- Non-GitHub remote URL (e.g., GitLab) → falls through to block
- Case-insensitive username match (`Alice` vs `alice`) → allowed
- `git push --force origin main` with owned remote → allowed (all push block rules exempted)
- `git push -u origin feature` with owned remote → allowed (flags before remote are skipped)

## Scope exclusions

- Only GitHub URL formats are supported. Other Git hosts are not matched and will fall through to normal blocking.
- The `git tag` creation rule (`^git\s+tag\b`) is unrelated and not affected by this exemption — it is not a push rule.
- The exemption applies to ALL git push block rules (force, delete, tags, main/master) when the remote is owned.
