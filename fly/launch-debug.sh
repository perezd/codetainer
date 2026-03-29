#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/config.sh"

REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

exec fly machine run "$REPO_ROOT" --dockerfile Dockerfile "${COMMON_FLAGS[@]}" "$@"
