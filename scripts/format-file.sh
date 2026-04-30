#!/usr/bin/env bash
set -uo pipefail

CONFIG="/opt/claude/formatters.conf"

[[ -f "$CONFIG" ]] || exit 0

input="$(cat)"
file_path="$(echo "$input" | jq -r '.tool_input.file_path')"

[[ -f "$file_path" ]] || exit 0

real_path="$(realpath "$file_path")"
if [[ "$real_path" != /workspace/* && "$real_path" != /home/claude/* ]]; then
    exit 0
fi

while IFS=$'\t' read -r pattern command; do
    [[ -z "$pattern" || "$pattern" == \#* ]] && continue
    if [[ "$real_path" =~ $pattern ]]; then
        IFS=' ' read -ra cmd_parts <<< "$command"
        "${cmd_parts[@]}" "$real_path" || echo "[format-hook] ${cmd_parts[0]} failed on $(basename "$real_path")" >&2
        exit 0
    fi
done < "$CONFIG"

exit 0
