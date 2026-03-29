# Session Initialization: Fork Sync Before Every Task

## Problem

When working with a forked repository, the local main branch can fall behind upstream. This means any work -- whether writing code, answering questions, or reviewing files -- may be based on stale source. The current CLAUDE.md has a "Syncing a Fork After Merge" section that handles post-merge cleanup, but nothing ensures the repo is current _before_ a task begins.

## Design

Add a new "Session Initialization" subsection as the **first subsection** under "## Git Workflow" in CLAUDE.md, before "Worktree-First Development". This positions it as a precondition for all subsequent workflow steps.

### New Section Content

The section contains an ordered list of initialization steps to complete before beginning any task. The first (and currently only) step is fork sync:

1. **Sync fork with upstream** -- Run `gh repo view --json isFork,parent` to detect whether the repo is a fork. If it is, sync main with upstream via `gh repo sync`, then `git pull origin main` to update the local checkout. If the repo is not a fork, skip this step.

### Placement

```
## Git Workflow
### Session Initialization       <-- NEW (first subsection)
### Worktree-First Development   <-- existing
### PR-Based Integration         <-- existing
### Fork-Aware PRs               <-- existing
### Syncing a Fork After Merge   <-- existing (unchanged)
...
```

### Scope

This applies to **every task**, not just tasks that produce commits. Explanations, code reviews, and exploratory reads should also be against the latest upstream state.

### Relationship to Existing Sections

- **"Syncing a Fork After Merge"** remains unchanged. It handles a different lifecycle moment (post-merge cleanup). The two sections are complementary.
- **"Fork-Aware PRs"** remains unchanged. It handles PR targeting at creation time.

### Future Extensibility

The "Session Initialization" section uses an ordered list, allowing additional pre-task steps to be appended later without restructuring.

## Security Layer Impact

- **Affected layers:** None.
- **Why:** This change modifies CLAUDE.md instructions only. No security-layer files (Dockerfile, iptables, approval rules, etc.) are touched. The `gh repo sync` and `git pull` commands are standard git operations that don't affect the security posture.
- **Panel review triggered:** Yes -- new designs and specifications require panel review per the Modification Protocol.
