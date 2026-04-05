export type PrescanResult =
  | { decision: "deny"; reason: string }
  | { decision: "escalate"; reason: string }
  | { decision: "continue"; lines: string[] }
  | { decision: "continue" };

const INVALID_CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

const CREDENTIAL_REF =
  /\$\{?(CLAUDE_CODE_OAUTH_TOKEN|GH_PAT|GH_TOKEN|CLAUDETAINER_NPM_TOKEN|FLY_ACCESS_TOKEN|FLY_API_TOKEN|GRAFANA_API_TOKEN|GRAFANA_INSTANCE_ID)\b/;

const ANSI_C_QUOTE = /\$'/;

const CREDENTIAL_FILE_PATHS = /\.npmrc|\.ghtoken|hosts\.yml|\.fly\//;

const CREDENTIAL_NAMES =
  /CLAUDE_CODE_OAUTH_TOKEN|GH_PAT|GH_TOKEN|CLAUDETAINER_NPM_TOKEN|FLY_ACCESS_TOKEN|FLY_API_TOKEN|GRAFANA_API_TOKEN|GRAFANA_INSTANCE_ID/;

const DEBUG_TELEMETRY = /GH_DEBUG|OTEL_EXPORTER_OTLP_HEADERS/;

export function normalizeAndSplit(
  raw: string,
): Extract<PrescanResult, { lines: string[] } | { decision: "deny" }> {
  if (raw.includes("\0")) {
    return { decision: "deny", reason: "null byte in command" };
  }

  if (INVALID_CONTROL_CHARS.test(raw)) {
    return {
      decision: "deny",
      reason: "non-printable control character in command",
    };
  }

  let normalized = raw.replace(/\r\n/g, "\n");
  normalized = normalized.replace(/\r/g, "\n");
  normalized = normalized.replace(/\\\n/g, "");

  const lines = normalized.split("\n").filter((line) => line.trim() !== "");

  return { decision: "continue", lines };
}

export function prescanLine(
  line: string,
): Exclude<PrescanResult, { lines: string[] }> {
  if (CREDENTIAL_REF.test(line)) {
    return { decision: "deny", reason: "credential reference in command" };
  }

  if (ANSI_C_QUOTE.test(line)) {
    return { decision: "deny", reason: "ANSI-C quoting ($') in command" };
  }

  if (CREDENTIAL_FILE_PATHS.test(line)) {
    return { decision: "escalate", reason: "credential file path in command" };
  }

  if (CREDENTIAL_NAMES.test(line)) {
    return { decision: "escalate", reason: "credential name in command" };
  }

  if (DEBUG_TELEMETRY.test(line)) {
    return {
      decision: "escalate",
      reason: "debug/telemetry config in command",
    };
  }

  return { decision: "continue" };
}
