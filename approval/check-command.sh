#!/usr/bin/env bash
set -euo pipefail

RULES_FILE="/opt/approval/rules.conf"
APPROVED_DIR="/run/claude-approved"

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""')

if [[ "$TOOL_NAME" != "Bash" ]]; then
  exit 0
fi

COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""')
[[ -z "$COMMAND" ]] && exit 0

echo "[HOOK] Evaluating: $COMMAND" >&2

evaluate_command() {
  local cmd="$1"
  cmd=$(echo "$cmd" | sed 's/^[[:space:]]*//')
  [[ -z "$cmd" ]] && return 0

  local hash
  hash=$(echo -n "$cmd" | sha256sum | cut -d' ' -f1)
  if [[ -f "$APPROVED_DIR/$hash" ]]; then
    rm -f "$APPROVED_DIR/$hash" 2>/dev/null || true
    echo "[HOOK] APPROVED (token): $cmd" >&2
    return 0
  fi

  local default_action="block"

  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ -z "$line" ]] && continue

    local type="${line%%:*}"
    local pattern="${line#*:}"

    case "$type" in
      allow)
        if echo "$cmd" | grep -qE "$pattern"; then
          echo "[HOOK] ALLOW ($pattern): $cmd" >&2
          return 0
        fi
        ;;
      block)
        if echo "$cmd" | grep -qE "$pattern"; then
          echo "[HOOK] BLOCK ($pattern): $cmd" >&2
          echo "⛔ Blocked: $cmd" >&2
          return 2
        fi
        ;;
      approve)
        if echo "$cmd" | grep -qE "$pattern"; then
          echo "[HOOK] APPROVAL REQUIRED ($pattern): $cmd" >&2
          echo "⛔ Approval required — run: ! approve '$cmd'" >&2
          return 2
        fi
        ;;
      default)
        default_action="$pattern"
        ;;
    esac
  done < "$RULES_FILE"

  if [[ "$default_action" == "allow" ]]; then
    echo "[HOOK] DEFAULT ALLOW: $cmd" >&2
    return 0
  else
    echo "[HOOK] DEFAULT BLOCK: $cmd" >&2
    echo "⛔ Blocked (no matching rule): $cmd" >&2
    return 2
  fi
}

split_and_evaluate() {
  local full_cmd="$1"

  # Check for $() and backtick subshells — extract and evaluate inner commands
  local inner
  inner=$(echo "$full_cmd" | grep -oP '\$\(\K[^)]+' || true)
  if [[ -n "$inner" ]]; then
    while IFS= read -r subcmd; do
      evaluate_command "$subcmd" || return $?
    done <<< "$inner"
  fi
  inner=$(echo "$full_cmd" | grep -oP '`\K[^`]+' || true)
  if [[ -n "$inner" ]]; then
    while IFS= read -r subcmd; do
      evaluate_command "$subcmd" || return $?
    done <<< "$inner"
  fi

  # Split on ; && || and evaluate each sub-command
  local subcmds
  subcmds=$(echo "$full_cmd" | sed 's/\s*&&\s*/\x00/g; s/\s*||\s*/\x00/g; s/\s*;\s*/\x00/g')

  while IFS= read -r -d $'\0' subcmd || [[ -n "$subcmd" ]]; do
    # Strip any remaining $() or backtick wrappers from the subcmd itself
    subcmd=$(echo "$subcmd" | sed 's/\$([^)]*)//g; s/`[^`]*`//g; s/^[[:space:]]*//')
    [[ -z "$subcmd" ]] && continue
    evaluate_command "$subcmd" || return $?
  done <<< "$subcmds"

  return 0
}

split_and_evaluate "$COMMAND"
exit $?
