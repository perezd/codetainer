#!/usr/bin/env bash
set -euo pipefail
# generate-stargate-config.sh — Generate Stargate config at boot from environment.
# allowed_domains is derived exclusively from domains.conf and must not be expanded independently.

# === 1. Set config path ===
export STARGATE_CONFIG=/opt/stargate/stargate.toml

# === 2. Create directory ===
mkdir -p /opt/stargate && chmod 755 /opt/stargate

# === 3. Symlink guard ===
[[ -L "$STARGATE_CONFIG" ]] && rm -f "$STARGATE_CONFIG"

# === 4. Install static template, then initialize directories ===
# Copy template first so stargate init validates OUR config (not the embedded default)
# and creates corpus/trace directories based on our settings.
cp /opt/stargate/stargate.toml.template "$STARGATE_CONFIG"
/usr/local/bin/stargate --config "$STARGATE_CONFIG" init

# === 5. Extract GitHub owner from REPO_URL ===
GITHUB_OWNER=""
if [[ -n "${REPO_URL:-}" ]]; then
    _extracted=$(echo "$REPO_URL" | sed -n 's|.*github\.com[:/]\([^/]*\)/.*|\1|p')
    if [[ "$_extracted" =~ ^[a-zA-Z0-9][a-zA-Z0-9-]*$ ]]; then
        GITHUB_OWNER="$_extracted"
    else
        echo "[STARGATE] WARN: REPO_URL owner failed validation, using empty github_owners (fail-closed)" >&2
    fi
fi

# === 6. Build allowed_domains from domains.conf ===
ALLOWED_DOMAINS="["
first=true
while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%%#*}"
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z "$line" ]] && continue
    domain="$line"
    if [[ "$first" == "true" ]]; then
        ALLOWED_DOMAINS+="\"${domain}\""
        first=false
    else
        ALLOWED_DOMAINS+=", \"${domain}\""
    fi
done < /opt/network/domains.conf
ALLOWED_DOMAINS+="]"

# === 7. Patch [scopes] section ===
if [[ -z "$GITHUB_OWNER" ]]; then
    sed -i "s|^github_owners = .*|github_owners = []|" "$STARGATE_CONFIG"
else
    sed -i "s|^github_owners = .*|github_owners = [\"${GITHUB_OWNER}\"]|" "$STARGATE_CONFIG"
fi
sed -i "s|^allowed_domains = .*|allowed_domains = ${ALLOWED_DOMAINS}|" "$STARGATE_CONFIG"

# === 8. Patch [telemetry] section ===
if [[ -n "${GRAFANA_INSTANCE_ID:-}" ]] && [[ -n "${GRAFANA_API_TOKEN:-}" ]] && [[ -n "${GRAFANA_OTLP_ENDPOINT:-}" ]]; then
    sed -i '/^\[telemetry\]/,/^$/{
        s|^enabled = .*|enabled = true|
    }' "$STARGATE_CONFIG"
    # Add endpoint line after [telemetry] header (before enabled)
    sed -i "/^\[telemetry\]/a endpoint = \"${GRAFANA_OTLP_ENDPOINT}\"" "$STARGATE_CONFIG"
fi

# Patch service_name from FLY_APP_NAME (for per-app telemetry grouping)
if [[ -n "${FLY_APP_NAME:-}" ]]; then
    if [[ "${FLY_APP_NAME}" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]]; then
        sed -i '/^\[telemetry\]/,/^$/{
            s|^service_name = .*|service_name = "'"${FLY_APP_NAME}"'"|
        }' "$STARGATE_CONFIG"
    else
        echo "[STARGATE] WARN: FLY_APP_NAME failed validation, using default service_name" >&2
    fi
fi

# === 9. Lock permissions ===
chmod 444 "$STARGATE_CONFIG"

echo "[STARGATE] Config generated at $STARGATE_CONFIG"
