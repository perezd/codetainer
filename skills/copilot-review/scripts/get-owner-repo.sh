#!/usr/bin/env bash
set -euo pipefail
# Extracts owner/repo from the git origin remote URL.
# Supports both HTTPS and SSH formats.
# Usage: get-owner-repo.sh
# Output: owner/repo (e.g., "limbic-systems/codetainer")

REMOTE_URL=$(git remote get-url origin 2>/dev/null) || {
  echo "ERROR: no git remote 'origin' found" >&2
  exit 1
}

OWNER_REPO=$(echo "$REMOTE_URL" | sed -E 's#.*[:/]([^/]+/[^/.]+)(\.git)?$#\1#')

if [[ -z "$OWNER_REPO" || "$OWNER_REPO" != */* ]]; then
  echo "ERROR: could not extract owner/repo from: $REMOTE_URL" >&2
  exit 1
fi

echo "$OWNER_REPO"
