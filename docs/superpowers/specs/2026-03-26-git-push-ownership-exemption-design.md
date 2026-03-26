# Git Push Ownership Exemption

## Problem

The approval classifier hard-blocks all `git push` commands to `main`/`master`, as well as force pushes, `--delete`, and `--tags`. This is correct for upstream repos the user doesn't own, but overly restrictive when pushing to the user's own fork (identified by matching the GitHub remote owner against `GIT_USER_NAME`).

## Design

### Approach: Pre-tier exemption in `check-command.ts`

Add an early-exit path in the main entry point of `check-command.ts`, before `evaluateTiers()` is called, that detects git push commands targeting an owned remote and allows them immediately.

### Detection flow

1. **Quick regex gate**: Check if the command matches `^git\s+push\b`. If not, skip entirely — zero cost for non-push commands.
2. **Resolve remote URL**: Run `git remote get-url origin` (from `/workspace`) to get the current remote URL.
3. **Extract GitHub owner**: Parse the owner from the URL, handling both formats:
   - `https://github.com/<owner>/<repo>` (HTTPS)
   - `git@github.com:<owner>/<repo>` (SSH)
4. **Compare against `GIT_USER_NAME`**: Case-insensitive comparison (GitHub usernames are case-insensitive).
5. **Decision**:
   - Match → allow immediately, skip all tier evaluation
   - No match / `GIT_USER_NAME` unset / remote fetch fails → fall through to normal tier evaluation

### Fail-safe behavior

Any error in the ownership check (missing env var, git command failure, unparseable URL) results in **no exemption** — the command proceeds through normal tier evaluation and will be blocked by existing rules. The system fails closed.

## Files changed

- **`approval/check-command.ts`**: Add `isOwnedRemotePush()` async function and early-exit logic before `evaluateTiers()` call in the main entry point.
- **`approval/__tests__/tiers.test.ts`**: Add test cases for the ownership exemption logic, mocking `git remote get-url` output.
- **`approval/rules.conf`**: No changes.
- **`approval/rules.ts`**: No changes.
- **`approval/classifier.ts`**: No changes.

## Scope exclusions

- Only the `origin` remote is checked. Multi-remote setups are not considered.
- Only GitHub URL formats are supported. Other Git hosts are not matched and will fall through to normal blocking.
- The exemption applies to ALL git push block rules (force, delete, tags, main/master) when the remote is owned.
