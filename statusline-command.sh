#!/bin/bash

input=$(cat)

model=$(echo "$input" | jq -r '.model.display_name // "Unknown Model"')
session_id=$(echo "$input" | jq -r '.session_id // "unknown"')
session_name=$(tmux display-message -p '#S' 2>/dev/null || echo "$session_id")
used=$(echo "$input" | jq -r '.context_window.used_percentage // empty')

if [ -n "$used" ]; then
  used_int=$(printf "%.0f" "$used")
  bar_filled=$(( used_int / 5 ))
  bar_empty=$(( 20 - bar_filled ))
  bar=""
  for i in $(seq 1 $bar_filled); do bar="${bar}█"; done
  for i in $(seq 1 $bar_empty); do bar="${bar}░"; done

  if [ "$used_int" -le 65 ]; then
    pct_color="\033[0;32m"
  elif [ "$used_int" -le 85 ]; then
    pct_color="\033[0;33m"
  else
    pct_color="\033[0;31m"
  fi

  printf "\033[0;36m%s\033[0m  %s  ${pct_color}%d%%\033[0m\n\033[2mSession: %s\033[0m" "$model" "$bar" "$used_int" "$session_name"
else
  printf "\033[0;36m%s\033[0m  ░░░░░░░░░░░░░░░░░░░░  \033[0;32m--%%\033[0m\n\033[2mSession: %s\033[0m" "$model" "$session_name"
fi
