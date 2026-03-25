#!/usr/bin/env bash
set -euo pipefail

echo "=== Claudetainer Status ==="
echo ""

echo "--- Recent iptables Drops ---"
dmesg 2>/dev/null | grep "CLAUDETAINER_DROP" | tail -5 || echo "  (none)"
echo ""

echo "--- CoreDNS ---"
COREDNS_PID=$(pidof coredns 2>/dev/null || true)
if [[ -n "$COREDNS_PID" ]]; then
  echo "  Process: running (PID $COREDNS_PID)"
else
  echo "  Process: NOT RUNNING"
  if [[ -f /tmp/coredns.log ]]; then
    echo "  Last log output:"
    tail -20 /tmp/coredns.log 2>/dev/null | sed 's/^/    /'
  fi
fi
