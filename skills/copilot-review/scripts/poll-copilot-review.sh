#!/usr/bin/env bash
set -euo pipefail

# Polls for Copilot review completion on a GitHub PR.
# Usage: poll-copilot-review.sh <owner/repo> <pr-number> [stale-review-id]
# Outputs one of:
#   REVIEW_COMPLETE:<review_id>:<unresolved_thread_count>
#   REVIEW_CLEAN:<review_id>  (requires both 0 threads AND "generated no new comments" body text)
#   ERROR:<message>  (non-transient API or GraphQL failure — fail-closed)
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

  REVIEW_JSON=$(gh api "repos/${OWNER_REPO}/pulls/${PR_NUMBER}/reviews" \
    --jq '[.[] | select(.user.login == "copilot-pull-request-reviewer[bot]")] | sort_by(.id) | last // empty' \
    2>"$STDERR_FILE") || {
      STDERR=$(cat "$STDERR_FILE" 2>/dev/null)
      if echo "$STDERR" | grep -qiE "rate limit|secondary rate|abuse detection"; then
        RATE_LIMIT_CONSECUTIVE=$((RATE_LIMIT_CONSECUTIVE + 1))
        if (( RATE_LIMIT_CONSECUTIVE >= RATE_LIMIT_MAX )); then
          echo "RATE_LIMITED"
          exit 0
        fi
        BACKOFF=$((120 * (2 ** (RATE_LIMIT_CONSECUTIVE - 1))))
        echo "Rate limited, backing off ${BACKOFF}s..." >&2
        sleep "$BACKOFF"
      else
        STDERR_SINGLE_LINE=$(printf '%s' "$STDERR" | tr '\r\n' ' ' | sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//')
        echo "gh api error: $STDERR_SINGLE_LINE" >&2
        echo "ERROR:${STDERR_SINGLE_LINE}"
        exit 0
      fi
      continue
    }

  RATE_LIMIT_CONSECUTIVE=0

  [[ -z "$REVIEW_JSON" ]] && continue

  REVIEW_ID=$(printf '%s' "$REVIEW_JSON" | jq -r '.id // empty')
  REVIEW_BODY=$(printf '%s' "$REVIEW_JSON" | jq -r '.body // empty')

  [[ -z "$REVIEW_ID" ]] && continue
  [[ "$REVIEW_ID" == "$STALE_REVIEW_ID" ]] && continue

  # Thread count includes all reviewers, not just Copilot — by design, since the
  # skill runs before human review and should address all unresolved threads.
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
    2>&1) || {
      GRAPHQL_ERROR_SINGLE_LINE=$(printf '%s' "$THREAD_COUNT" | tr '\r\n' ' ' | sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//')
      echo "GraphQL error: $GRAPHQL_ERROR_SINGLE_LINE" >&2
      echo "ERROR:${GRAPHQL_ERROR_SINGLE_LINE}"
      exit 0
    }

  if ! [[ "$THREAD_COUNT" =~ ^[0-9]+$ ]]; then
    echo "Unexpected thread count: $THREAD_COUNT" >&2
    echo "ERROR:Non-numeric thread count: ${THREAD_COUNT}"
    exit 0
  fi

  if [[ "$THREAD_COUNT" -eq 0 ]] && echo "$REVIEW_BODY" | grep -qi "generated no new comments"; then
    echo "REVIEW_CLEAN:${REVIEW_ID}"
    exit 0
  fi

  echo "REVIEW_COMPLETE:${REVIEW_ID}:${THREAD_COUNT}"
  exit 0
done

echo "TIMEOUT"
exit 0
