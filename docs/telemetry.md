# Telemetry

Optional OpenTelemetry export to Grafana Cloud for metrics, events, and traces.

## Overview

Codetainer can export Claude Code's native OpenTelemetry metrics and events to [Grafana Cloud](https://grafana.com/products/cloud/) via direct OTLP push. This gives you dashboards for token usage, costs, session activity, and full prompt-level event traces — all in Grafana.

The feature is **opt-in** and **disabled by default**. It activates only when all three Grafana Cloud secrets are set (`GRAFANA_INSTANCE_ID`, `GRAFANA_API_TOKEN`, `GRAFANA_OTLP_ENDPOINT`). When off, there is zero telemetry, zero outbound traffic, and no behavior change.

## Setup

These three secrets enable optional OpenTelemetry export to Grafana Cloud. All three must be set to activate the feature — if any is missing, telemetry is off and there is zero outbound traffic to Grafana.

#### `GRAFANA_INSTANCE_ID`

Your Grafana Cloud instance ID (numeric). Find it in the Grafana Cloud portal under your stack's OTLP configuration.

#### `GRAFANA_API_TOKEN`

A Grafana Cloud Access Policy token with OTLP push (write) permissions. Create one in the Grafana Cloud portal under **Security → Access Policies**. The token needs the `metrics:write`, `logs:write`, and `traces:write` scopes.

#### `GRAFANA_OTLP_ENDPOINT`

The full OTLP gateway URL for your Grafana Cloud stack. Format: `https://otlp-gateway-prod-<region>.grafana.net/otlp`. Find the exact URL in the Grafana Cloud portal under your stack's OTLP configuration.

```bash
fly secrets set \
  GRAFANA_INSTANCE_ID=<your-instance-id> \
  GRAFANA_API_TOKEN=<your-token> \
  GRAFANA_OTLP_ENDPOINT=https://otlp-gateway-prod-us-west-2.grafana.net/otlp \
  -a <your-app-name>
```

## What Gets Exported

**Metrics** (→ Grafana Mimir):

- Active usage time, session count
- API request token counts and cost (input, output, cache creation, cache read)
- Lines of code added/removed
- Pull requests and commits created

**Events** (→ Grafana Loki):

- `user_prompt` — emitted per user prompt (content included by default, opt-out with `OTEL_LOG_USER_PROMPTS=0`)
- `api_request` — emitted per API call (model, tokens, cost)
- `tool_result` — emitted per tool execution (tool name, parameters; opt-out details with `OTEL_LOG_TOOL_DETAILS=0`)

All events from a single user prompt share a `prompt.id` for correlation.

**Traces** (→ Grafana Tempo):

- Distributed tracing links each user prompt to the API requests and tool executions it triggers, viewable as a single trace in Grafana
- Auto-enabled alongside metrics and logs when Grafana Cloud credentials are configured
- Span content fidelity is controlled by the same privacy settings described below

When tracing is active, Bash subprocesses automatically inherit a `TRACEPARENT` environment variable containing the W3C trace context of the active tool execution span. This lets any subprocess that reads `TRACEPARENT` parent its own spans under the same trace, enabling end-to-end distributed tracing through scripts and commands that Claude runs.

## Privacy Controls

When telemetry is enabled, **full fidelity is the default** — prompt content and tool parameters are included. The rationale: if you've provided Grafana Cloud credentials, you want full observability.

To reduce fidelity, set these as env vars on the Fly machine:

```bash
fly machine run ... \
  --env OTEL_LOG_USER_PROMPTS=0 \
  --env OTEL_LOG_TOOL_DETAILS=0
```

With `OTEL_LOG_USER_PROMPTS=0`, only prompt length is recorded (not content). With `OTEL_LOG_TOOL_DETAILS=0`, only tool names are recorded (not parameters) — this applies to both log events and trace spans. Raw file contents are never included regardless of settings.

**Data residency note:** When enabled, telemetry data (including prompt content if not opted out) leaves the container and is stored in Grafana Cloud. You are responsible for ensuring this meets your data residency and privacy requirements.

## Resource Attributes

All metrics, events, and traces are tagged with resource attributes for filtering and grouping in Grafana dashboards.

**Auto-injected** (always present when telemetry is enabled):

- `fly.app_name` — from the Fly VM's `FLY_APP_NAME` env var
- `fly.machine_id` — from the Fly VM's `FLY_MACHINE_ID` env var

**Custom attributes** — add your own via the `OTEL_RESOURCE_ATTRIBUTES` env var:

```bash
fly machine run ... \
  --env OTEL_RESOURCE_ATTRIBUTES="department=engineering,team.id=platform,cost_center=eng-123"
```

The auto-injected Fly attributes and your custom attributes are merged. If you set a key that conflicts with an auto-injected one, your value wins (last-write-wins).

Values must not contain spaces. Use underscores or camelCase instead (e.g., `team.name=my_team`).

## How It Works

The feature uses a two-phase activation in the entrypoint:

1. **Phase 1** (before network setup): Extracts the OTLP gateway hostname from `GRAFANA_OTLP_ENDPOINT` and dynamically adds it to CoreDNS and iptables — no static domain allowlist changes needed.
2. **Phase 2** (after auth setup): Writes OTEL configuration to a root-only file that `start-claude.sh` forwards to the Claude Code process.

No new binaries, no collector sidecar, no Dockerfile changes. Claude Code's built-in OTLP exporter handles everything.

See [Architecture](architecture.md) for the full boot sequence.
