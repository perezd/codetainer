# OTEL Metrics Export to Fly Managed Grafana

## Overview

Enable Claude Code's native OpenTelemetry telemetry and export metrics to Fly.io's managed Grafana system (fly-metrics.net) via Fly's built-in Prometheus scraping.

Claude Code has a native Prometheus exporter (`OTEL_METRICS_EXPORTER=prometheus`) that exposes a `/metrics` HTTP endpoint directly -- no sidecar or collector needed. Fly scrapes this endpoint on its own schedule.

The feature is **opt-in** and **disabled by default** -- it activates only when the `OTEL_METRICS_PORT` environment variable is set.

## Architecture

Fly.io's managed Prometheus is **pull-based** -- there is no remote-write endpoint. Fly scrapes a `/metrics` HTTP endpoint exposed by the application.

```
+--------------------------------------------------+
|  Claudetainer (Fly Machine)                      |
|                                                  |
|  +--------------+                                |
|  |  Claude Code  |                               |
|  |              |                                |
|  |  :${OTEL_METRICS_PORT}/metrics                |
|  +--------------+                                |
+--------------------------------------------------+
           ^
           | Prometheus scrape (Fly internal network)
           |
    Fly Managed Prometheus
    (VictoriaMetrics)
           |
           v
    Fly Managed Grafana
    (fly-metrics.net)
```

- Claude Code exposes Prometheus metrics directly on `0.0.0.0:${OTEL_METRICS_PORT}/metrics`.
- Fly's managed Prometheus scrapes this endpoint on its own schedule (~15s interval).
- **No outbound network traffic** is required. No sidecar process. No new binary. Fly pulls from inside its network.
- Only **metrics** are exported via Prometheus. OTEL logs/events (tool_result, api_request, user_prompt) are a separate signal type that Fly's Prometheus cannot store. These are not exported. A logs pipeline can be added later when a backend is available -- at that point, an OTEL Collector sidecar could be introduced to receive OTLP and fan out to multiple backends.

## Opt-in Mechanism

### User-provided environment variable

| Variable            | Required        | Purpose                                                |
| ------------------- | --------------- | ------------------------------------------------------ |
| `OTEL_METRICS_PORT` | Yes (to enable) | Port for the Prometheus scrape endpoint (e.g., `9091`) |

A single env var controls the feature. No tokens, org slugs, or collector config needed.

### Fly.io machine configuration

The operator must also configure Fly to scrape the metrics port. This is done outside the container via:

```bash
# Option 1: fly.toml (if introduced later)
# [metrics]
# port = 9091
# path = "/metrics"

# Option 2: Machine API metadata (current deployment model)
fly machine update <machine-id> --metadata fly_metrics_port=9091
```

The `fly machine update` approach works with the project's current CLI-based deployment (no `fly.toml`). The operator sets `OTEL_METRICS_PORT` on the machine env and configures Fly's scrape metadata -- both values must match. A mismatch results in silent failure (no metrics, no error).

### Internally set environment variables (when enabled)

Set by `entrypoint.sh` before Claude Code launches:

| Variable                        | Value                  | Purpose                                    |
| ------------------------------- | ---------------------- | ------------------------------------------ |
| `CLAUDE_CODE_ENABLE_TELEMETRY`  | `1`                    | Tells Claude Code to emit OTEL data        |
| `OTEL_METRICS_EXPORTER`         | `prometheus`           | Use the native Prometheus exporter         |
| `OTEL_EXPORTER_PROMETHEUS_HOST` | `0.0.0.0`              | Bind to all interfaces (Fly must reach it) |
| `OTEL_EXPORTER_PROMETHEUS_PORT` | `${OTEL_METRICS_PORT}` | Port for the scrape endpoint               |

### Experimental env var caveat

`OTEL_EXPORTER_PROMETHEUS_HOST` and `OTEL_EXPORTER_PROMETHEUS_PORT` are marked **experimental** in the OpenTelemetry specification. The Node.js SDK (which Claude Code uses) may not honor them. If these env vars are not respected at runtime:

**Fallback plan:** Introduce an OTEL Collector sidecar that receives OTLP from Claude Code on `localhost:4317` and exposes a Prometheus endpoint on the configured port. This is a strictly additive change (add binary + config) and does not alter the rest of this design. The implementation should test the direct approach first and only fall back to the collector if needed.

### Privacy controls (hardcoded OFF)

| Variable                | Value         | Rationale                                                        |
| ----------------------- | ------------- | ---------------------------------------------------------------- |
| `OTEL_LOG_USER_PROMPTS` | `0` (not set) | Prompt content should not leave the container                    |
| `OTEL_LOG_TOOL_DETAILS` | `0` (not set) | Tool arguments may contain file paths, URLs, or sensitive values |

These are intentionally not configurable. The security model assumes telemetry should contain aggregate metrics and event metadata, not content.

### Activation logic

```bash
if [ -n "${OTEL_METRICS_PORT:-}" ]; then
  export CLAUDE_CODE_ENABLE_TELEMETRY=1
  export OTEL_METRICS_EXPORTER=prometheus
  export OTEL_EXPORTER_PROMETHEUS_HOST=0.0.0.0
  export OTEL_EXPORTER_PROMETHEUS_PORT="$OTEL_METRICS_PORT"
  echo "[ENTRYPOINT] OTEL metrics enabled on port $OTEL_METRICS_PORT"
fi
```

When the variable is not set, no OTEL env vars are injected and Claude Code behaves exactly as it does today.

## What You Get in Grafana

### Available metrics (from Claude Code's native OTEL)

| Metric                                 | Type    | Description                                                                |
| -------------------------------------- | ------- | -------------------------------------------------------------------------- |
| `claude_code_cost_usage_USD_total`     | Counter | Cumulative cost in USD                                                     |
| `claude_code_token_usage_tokens_total` | Counter | Token usage, segmented by type (input, output, cache_creation, cache_read) |
| `claude_code_sessions`                 | Counter | Session count                                                              |

### Segmentation labels

Metrics include OTEL resource attributes as Prometheus labels: `model`, `app_version`, `session_id`, `user_account_uuid`, `organization_id`.

Note: `session_id` and `user_account_uuid` are pseudonymous identifiers that could be correlated to individuals. These become visible to anyone with Grafana dashboard access. If multi-tenant Grafana access is introduced in the future, review which labels are exported.

### What you do NOT get (until a logs backend is added)

- Per-tool-call breakdowns (tool name, success/failure, duration)
- Per-API-request cost and token detail
- Prompt-level correlation (which prompt triggered which costs)
- Tool argument details (file paths, commands)

These are exported as OTEL log records (events), not metrics. Fly's Prometheus backend cannot store them.

## Dockerfile Changes

**None.** No new binary, no config template, no image size change. The entire feature is activated via environment variables in `entrypoint.sh`.

If the fallback collector approach is needed, the Dockerfile changes would be:

- Download the `otelcol` binary (linux/amd64) from the official [opentelemetry-collector-releases](https://github.com/open-telemetry/opentelemetry-collector-releases) GitHub repo.
- Pin to a specific release version with SHA256 checksum verification.
- Place at `/usr/local/bin/otelcol`.
- Image size impact: ~50MB.

## Boot Sequence Integration

The OTEL setup is a simple conditional env var export in `entrypoint.sh`. It slots in **before Claude Code settings copy** (step 4 in the current sequence) so the env vars are available when Claude Code launches.

```
1. Validate secrets
2. Mount tmpfs
3. Start CoreDNS
4. Apply iptables
5. Configure git/gh/npm auth
6. Copy Claude settings
7. ** Set OTEL env vars (if OTEL_METRICS_PORT is set) **
8. Remount rootfs read-only
9. Clone repo
10. Readiness checks
```

No new background processes. No config files to generate. No auto-restart loops.

The env vars are exported in the entrypoint (PID 1) shell, so they are inherited by all child processes including the Claude Code session launched via `start-claude.sh` → tmux.

## Network and Security Changes

### Domain allowlist

**No changes required.** No outbound connections are made.

### Approval rules

**No changes required.** No credentials are involved.

### Layer impact assessment

| Layer               | Impact                                                             |
| ------------------- | ------------------------------------------------------------------ |
| Container Hardening | **None** -- no new binaries, no config files, no privilege changes |
| Network Isolation   | **None** -- no new outbound access, no domain allowlist changes    |
| Command Approval    | **None** -- no new credentials to protect                          |

### Exposed port

The Prometheus scrape endpoint listens on `0.0.0.0:${OTEL_METRICS_PORT}`. This port is reachable by Fly's infrastructure for scraping. It serves read-only Prometheus metrics -- no write capability, no sensitive data beyond the metric values and labels documented above.

This is the same exposure model as any Fly app that exposes an HTTP service. The port is reachable from the Fly private network (other machines in the same org), not the public internet (unless a Fly service is explicitly configured to route to it).

## Testing and Validation

### Feature-off path

Deploy without `OTEL_METRICS_PORT`. Confirm: no OTEL env vars in Claude Code's environment, no listening port on 9091, no behavior change.

### Feature-on path

Deploy with `OTEL_METRICS_PORT=9091`. Confirm: Claude Code has `CLAUDE_CODE_ENABLE_TELEMETRY=1` and `OTEL_METRICS_EXPORTER=prometheus` in its environment. Verify `:9091/metrics` responds with Prometheus exposition format.

### Env var verification

During implementation, test whether `OTEL_EXPORTER_PROMETHEUS_HOST` and `OTEL_EXPORTER_PROMETHEUS_PORT` are honored by Claude Code's Node.js OTEL SDK. If not, implement the collector fallback.

### Metrics flow

1. Configure Fly to scrape the metrics port: `fly machine update <id> --metadata fly_metrics_port=9091`
2. Run a Claude Code session.
3. Check Fly Grafana (fly-metrics.net) for `claude_code_*` metrics appearing.

### No automated integration test

The full pipeline requires a live Fly deployment. Metrics flow validation is manual. The `/metrics` endpoint can be tested locally with `curl` during development.
