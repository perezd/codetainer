#!/usr/bin/env bash
# Sync fork's main branch with upstream.
# Reads repo identity from the immutable boot-time snapshot, not live git state.
# No-op if the snapshot doesn't contain two GitHub URLs (non-fork repos).
# Always exits 0 — sync failures must not block sessions or worktree creation.

set +e

SNAPSHOT="/tmp/approval/git-remote-urls.txt"
REPO_DIR="/workspace/repo"
GITHUB_RE='^https://github\.com/([^/]+/[^/]+)(\.git)?$'

# --- Read snapshot ---
if [[ ! -f "$SNAPSHOT" ]]; then
  exit 0
fi

urls=()
while IFS= read -r line; do
  [[ -n "$line" ]] && urls+=("$line")
done < "$SNAPSHOT"

# Fork repos have exactly 2 URLs (origin + upstream); non-forks have 1
if [[ ${#urls[@]} -lt 2 ]]; then
  exit 0
fi

# --- Extract NWOs from snapshot URLs ---
origin_nwo=""
upstream_nwo=""

for url in "${urls[@]}"; do
  if [[ "$url" =~ $GITHUB_RE ]]; then
    nwo="${BASH_REMATCH[1]}"
    # First URL is origin, second is upstream (entrypoint adds them in this order)
    if [[ -z "$origin_nwo" ]]; then
      origin_nwo="$nwo"
    else
      upstream_nwo="$nwo"
      break
    fi
  fi
done

if [[ -z "$origin_nwo" || -z "$upstream_nwo" ]]; then
  echo "[SYNC-FORK] WARNING: Could not extract NWOs from snapshot, skipping sync" >&2
  exit 0
fi

# --- Sync fork on GitHub ---
echo "[SYNC-FORK] Syncing ${origin_nwo} with upstream ${upstream_nwo}..." >&2
if ! gh repo sync "$origin_nwo" --source "$upstream_nwo" --branch main >&2; then
  echo "[SYNC-FORK] WARNING: gh repo sync failed, proceeding with current state" >&2
  exit 0
fi

# --- Pull locally ---
# Fetch and update local main ref in one step.
# When main is checked out, use merge --ff-only (safe for working tree).
# When on another branch (e.g., in a worktree), update the ref directly
# so push doesn't send stale state.
current_branch=$(git -C "$REPO_DIR" symbolic-ref --short HEAD 2>/dev/null)
if [[ "$current_branch" == "main" ]]; then
  git -C "$REPO_DIR" fetch origin main >&2 || {
    echo "[SYNC-FORK] WARNING: git fetch origin main failed" >&2
    exit 0
  }
  git -C "$REPO_DIR" merge --ff-only origin/main >&2 || {
    echo "[SYNC-FORK] WARNING: git merge --ff-only origin/main failed (local divergence?)" >&2
    exit 0
  }
else
  # fetch origin main:main updates the local main ref directly (fast-forward only)
  git -C "$REPO_DIR" fetch origin main:main >&2 || {
    echo "[SYNC-FORK] WARNING: git fetch origin main:main failed" >&2
    exit 0
  }
fi

# --- Push to fork origin (safety check first) ---
ahead_count=$(git -C "$REPO_DIR" rev-list origin/main..main --count 2>/dev/null || echo "0")
if [[ "$ahead_count" -gt 0 ]]; then
  echo "[SYNC-FORK] WARNING: local main is ${ahead_count} commits ahead of origin/main, skipping push" >&2
  exit 0
fi

git -C "$REPO_DIR" push origin main >&2 || {
  echo "[SYNC-FORK] WARNING: git push origin main failed" >&2
  exit 0
}

echo "[SYNC-FORK] Synced ${origin_nwo} with upstream ${upstream_nwo}" >&2
exit 0
