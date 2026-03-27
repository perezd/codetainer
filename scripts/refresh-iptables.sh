#!/usr/bin/env bash
set -euo pipefail

DOMAINS_FILE="/opt/network/domains.conf"
RULES_FILE=$(mktemp)

cat > "$RULES_FILE" <<'HEADER'
*filter
:INPUT ACCEPT [0:0]
:FORWARD ACCEPT [0:0]
:OUTPUT DROP [0:0]
-A OUTPUT -o lo -j ACCEPT
-A OUTPUT -d 169.254.0.0/16 -j DROP
-A OUTPUT -d 172.16.0.0/12 -j DROP
-A OUTPUT -p udp -d 127.0.0.53 --dport 53 -j ACCEPT
-A OUTPUT -p tcp -d 127.0.0.53 --dport 53 -j ACCEPT
-A OUTPUT -p udp -d 8.8.8.8 --dport 53 -j ACCEPT
-A OUTPUT -p udp -d 1.1.1.1 --dport 53 -j ACCEPT
-A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
-A OUTPUT -p tcp -d 140.82.112.0/20 --dport 443 -j ACCEPT
-A OUTPUT -p tcp -d 185.199.108.0/22 --dport 443 -j ACCEPT
-A OUTPUT -p tcp -d 143.55.64.0/20 --dport 443 -j ACCEPT
HEADER

while IFS= read -r domain || [[ -n "$domain" ]]; do
  [[ "$domain" =~ ^[[:space:]]*# ]] && continue
  [[ -z "$domain" ]] && continue
  domain=$(echo "$domain" | tr -d '[:space:]')

  ips=$(dig +short "$domain" 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' || true)
  for ip in $ips; do
    echo "-A OUTPUT -d $ip -j ACCEPT" >> "$RULES_FILE"
  done
done < "$DOMAINS_FILE"

# Read optional supplementary domains from root-only dir (written by entrypoint)
EXTRA_DOMAINS_FILE="/tmp/otel/extra-domains.conf"
if [[ -f "$EXTRA_DOMAINS_FILE" ]] && [[ ! -L "$EXTRA_DOMAINS_FILE" ]]; then
  while IFS= read -r domain || [[ -n "$domain" ]]; do
    [[ "$domain" =~ ^[[:space:]]*# ]] && continue
    [[ -z "$domain" ]] && continue
    domain=$(echo "$domain" | tr -d '[:space:]')

    ips=$(dig +short "$domain" 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' || true)
    for ip in $ips; do
      echo "-A OUTPUT -d $ip -j ACCEPT" >> "$RULES_FILE"
    done
  done < "$EXTRA_DOMAINS_FILE"
fi

echo "-A OUTPUT -p udp -j DROP" >> "$RULES_FILE"
echo '-A OUTPUT -j NFLOG --nflog-prefix "CLAUDETAINER_DROP" --nflog-group 100' >> "$RULES_FILE"
echo "COMMIT" >> "$RULES_FILE"

iptables-restore < "$RULES_FILE"

# IPv6: leave default ACCEPT policy.
# Fly SSH uses public IPv6 (2605:4c40::/32) and private (fdaa::/16) for
# communication, and conntrack doesn't appear to work for IPv6 on Fly's
# kernel. IPv4 iptables is where our real security enforcement happens.
# Restricting IPv6 OUTPUT breaks SSH with no security benefit since all
# our allowlisted services are contacted over IPv4.

rm -f "$RULES_FILE"
echo "[NETWORK] iptables refreshed at $(date)" >&2
