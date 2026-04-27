#!/usr/bin/env bash
set -euo pipefail

# Polls for Copilot review completion on a GitHub PR.
# Usage: poll-copilot-review.sh <owner/repo> <pr-number> [stale-review-id]
# Outputs one of:
#   REVIEW_COMPLETE:<review_id>:<unresolved_thread_count>
#   REVIEW_CLEAN:<review_id>  (requires both 0 threads AND "generated no new comments" body text)
#   TIMEOUT
#   RATE_LIMITED

OWNER_REPO="${1:?Usage: poll-copilot-review.sh <owner/repo> <pr-number> [stale-review-id]}"
PR_NUMBER="${2:?Usage: poll-copilot-review.sh <owner/repo> <pr-number> [stale-review-id]}"
STALE_REVIEW_ID="${3:-}"

[[ "$OWNER_REPO" == */* ]] || { echo "owner/repo must contain a slash, got: $OWNER_REPO" >&2; exit 1; }
[[ "$PR_NUMBER" =~ ^[0-9]+$ ]] || { echo "PR number must be numeric, got: $PR_NUMBER" >&2; exit 1; }

MAX_POLLS=30
POLL_INTERVAL=60
RATE_LIMIT_CONSECUTIVE=0
RATE_LIMIT_MAX=3

OWNER="${OWNER_REPO%%/*}"
REPO="${OWNER_REPO##*/}"

STDERR_FILE=$(mktemp /tmp/poll-stderr.XXXXXX)
trap 'rm -f "$STDERR_FILE"' EXIT

for (( i=1; i<=MAX_POLLS; i++ )); do
  if (( i > 1 )); then
    sleep "$POLL_INTERVAL"
  fi

  REVIEWS=$(gh api "repos/${OWNER_REPO}/pulls/${PR_NUMBER}/reviews" \
    --paginate \
    --jq '[.[] | select(.user.login == "copilot-pull-request-reviewer[bot]")] | sort_by(.id) | last | "\(.id)\t\(.body)"' \
    2>"$STDERR_FILE") || {
      STDERR=$(cat "$STDERR_FILE" 2>/dev/null)
      if echo "$STDERR" | grep -qE "HTTP (403|429)"; then
        RATE_LIMIT_CONSECUTIVE=$((RATE_LIMIT_CONSECUTIVE + 1))
        if (( RATE_LIMIT_CONSECUTIVE >= RATE_LIMIT_MAX )); then
          echo "RATE_LIMITED"
          exit 0
        fi
        BACKOFF=$((120 * (2 ** (RATE_LIMIT_CONSECUTIVE - 1))))
        echo "Rate limited, backing off ${BACKOFF}s..." >&2
        sleep "$BACKOFF"
      else
        echo "gh api error: $STDERR" >&2
      fi
      continue
    }

  RATE_LIMIT_CONSECUTIVE=0

  [[ -z "$REVIEWS" || "$REVIEWS" == "null" ]] && continue

  REVIEW_ID=$(printf '%s' "$REVIEWS" | cut -f1)
  REVIEW_BODY=$(printf '%s' "$REVIEWS" | cut -f2-)

  [[ -z "$REVIEW_ID" || "$REVIEW_ID" == "null" ]] && continue
  [[ "$REVIEW_ID" == "$STALE_REVIEW_ID" ]] && continue

  THREAD_COUNT=$(gh api graphql -f query='
    query($owner: String!, $repo: String!, $pr: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $pr) {
          reviewThreads(filterBy: {resolved: false}) {
            totalCount
          }
        }
      }
    }' -f owner="$OWNER" -f repo="$REPO" -F pr="$PR_NUMBER" \
    --jq '.data.repository.pullRequest.reviewThreads.totalCount' \
    2>&1) || { echo "GraphQL error: $THREAD_COUNT" >&2; continue; }

  [[ "$THREAD_COUNT" =~ ^[0-9]+$ ]] || { echo "Unexpected thread count: $THREAD_COUNT" >&2; continue; }

  if [[ "$THREAD_COUNT" -eq 0 ]] && echo "$REVIEW_BODY" | grep -qi "generated no new comments"; then
    echo "REVIEW_CLEAN:${REVIEW_ID}"
    exit 0
  fi

  echo "REVIEW_COMPLETE:${REVIEW_ID}:${THREAD_COUNT}"
  exit 0
done

echo "TIMEOUT"
exit 0
