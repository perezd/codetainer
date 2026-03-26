# Git Push Ownership Exemption

## Problem

The approval classifier hard-blocks all `git push` commands to `main`/`master`, as well as force pushes, `--delete`, and `--tags`. This is correct for upstream repos the user doesn't own, but overly restrictive when pushing to the user's own fork (identified by matching the GitHub remote owner against `GIT_USER_NAME`).

Additionally, the existing `git push` block rules are anchored with `^`, meaning compound commands like `cd /repo && git push --force origin main` bypass them entirely. This pre-existing gap should be fixed as part of this work.

## Design

### Part 1: Pre-tier ownership exemption in `check-command.ts`

Add an early-exit path in the main entry point of `check-command.ts`, before `evaluateTiers()` is called, that detects git push commands targeting an owned remote and allows them immediately.

### Detection flow

1. **Quick regex gate**: Check if the command matches `^git\s+push\b`. If not, skip entirely — zero cost for non-push commands.
2. **Parse target remote from command**: Tokenize the arguments after `git push`, skip any tokens starting with `-` (flags like `-u`, `--force`, `--set-upstream`). The first non-flag token is the remote name. If no non-flag positional argument exists (bare `git push`), default to `origin`.
3. **Resolve remote push URL**: Run `git remote get-url --push <remote>` from the hook's CWD (Claude Code sets this to the workspace directory). **Critical: the `--push` flag must be used** because it returns the URL git actually uses for push operations (`pushurl` if set, otherwise `url`). This is the security invariant — the URL we check ownership against is the same URL git will push to. Add a code comment explaining this.
4. **Extract GitHub owner**: Parse the owner from the URL, handling both formats:
   - `https://github.com/<owner>/<repo>` (HTTPS)
   - `git@github.com:<owner>/<repo>` (SSH)
5. **Compare against `GIT_USER_NAME`**: Read from `process.env.GIT_USER_NAME`. Case-insensitive comparison (GitHub usernames are case-insensitive).
6. **Check for `--delete` flag**: Even if the remote is owned, if the command contains `--delete` or `-d` flag, do NOT exempt — fall through to normal tier evaluation. Branch deletion is rarely needed in the fork-branch-PR workflow and limiting it reduces blast radius.
7. **Decision**:
   - Owned remote and no `--delete` → allow immediately, skip all tier evaluation. Log: `[HOOK] ALLOW (owned remote): <command>`
   - No match / `GIT_USER_NAME` unset / remote fetch fails / non-GitHub URL / `--delete` present → fall through to normal tier evaluation

### Part 2: Fix compound command bypass of git push block rules

The existing `rules.conf` git push block patterns are anchored with `^`, which means they only match when `git push` is the first command in the string. Compound commands bypass the blocks entirely:

```
# This is blocked:
git push --force origin main

# This is NOT blocked (pre-existing gap):
cd /repo && git push --force origin main
```

**Fix**: Remove the `^` anchor from the git push block patterns and use an unanchored pattern with a command-position anchor that accounts for compound command separators:

```
# Before:
block-pattern:^git\s+push\s+.*--force

# After:
block-pattern:(^|\s*[;&|]\s*|[(]\s*)git\s+push\s+.*--force
```

This matches `git push` at the start of the string OR after `&&`, `||`, `;`, `|`, or `(`. This is the same pattern already used for `fly auth`, `fly ssh`, etc. in `rules.conf`.

### CWD for subprocess

The `git remote get-url` subprocess runs from the CWD of the hook process itself. Claude Code hooks execute from the project working directory, so this will resolve to the correct repo. If the CWD is not a git repo (e.g., `/workspace` with the repo in `/workspace/repo`), the git command fails and the exemption falls through to normal blocking — fail-safe behavior.

### Fail-safe behavior

Any error in the ownership check (missing env var, git command failure, unparseable URL, non-GitHub host) results in **no exemption** — the command proceeds through normal tier evaluation and will be blocked by existing rules. The system fails closed.

### Logging

The exemption path logs `[HOOK] ALLOW (owned remote): <command>` via `console.error`, consistent with all other decision paths in the classifier.

## Files changed

- **`approval/check-command.ts`**: Add `isOwnedRemotePush()` async function and early-exit logic before `evaluateTiers()` call in the main entry point. Export helper functions for testing.
- **`approval/rules.conf`**: Update git push block patterns to use compound-command-aware anchoring instead of `^`.
- **`approval/__tests__/tiers.test.ts`**: Add test cases for ownership exemption and compound command blocking.
- **`approval/rules.ts`**: No changes.
- **`approval/classifier.ts`**: No changes.

## Test cases

### Ownership exemption tests

- `git push origin main` with owned remote → allowed
- `git push origin main` with non-owned remote → falls through to block
- `git push` (bare, no remote specified) with owned `origin` → allowed
- `git push my-fork feature` with owned `my-fork` remote → allowed
- `GIT_USER_NAME` unset → falls through to block
- `git remote get-url` fails (not in a git repo) → falls through to block
- Non-GitHub remote URL (e.g., GitLab) → falls through to block
- Case-insensitive username match (`Alice` vs `alice`) → allowed
- `git push --force origin main` with owned remote → allowed
- `git push -u origin feature` with owned remote → allowed (flags before remote are skipped)
- `git push --delete origin feature` with owned remote → **still blocked** (`--delete` exemption exclusion)
- `git push -d origin feature` with owned remote → **still blocked** (`-d` exemption exclusion)
- `pushurl` differs from `url` → ownership check uses the push URL (the one git actually pushes to)

### Compound command block tests

- `cd /repo && git push --force origin main` → blocked (compound command)
- `(git push origin main)` → blocked (subshell)
- `ls; git push --delete origin branch` → blocked (semicolon separator)
- `cd /repo && git push origin feature` → NOT blocked (non-destructive push, no block rule matches)

## Security notes

- **`--push` invariant**: The `git remote get-url --push` flag is critical to security. It returns the URL git will actually use for push operations. If a repo has both `url` and `pushurl` configured, `--push` returns `pushurl` (which is what git pushes to). This ensures the ownership check cannot be tricked by setting a different `url` and `pushurl`. Code must include a comment explaining this.
- **GH_PAT scope**: The blast radius of this feature depends on the PAT being scoped to only the repos the agent should access. Ideally the PAT should be scoped to only the fork repo.
- **`--delete` remains blocked**: Even for owned remotes, `--delete` pushes are not exempted. Branch deletion is rarely needed in the fork workflow and keeping it blocked reduces blast radius.

## Scope exclusions

- Only GitHub URL formats are supported. Other Git hosts are not matched and will fall through to normal blocking.
- The `git tag` creation rule (`^git\s+tag\b`) is unrelated and not affected by this exemption — it is not a push rule.
- The `git remote` manipulation rules (`^git\s+remote`) retain their `^` anchor — they are not compound-command-fixed in this work since they are lower risk and the ownership exemption does not depend on them.
