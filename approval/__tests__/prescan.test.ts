import { describe, expect, test } from "bun:test";
import { normalizeAndSplit, prescanLine, type PrescanResult } from "../prescan";

describe("normalizeAndSplit", () => {
  test("rejects null bytes", () => {
    const result = normalizeAndSplit("echo hello\0sudo reboot");
    expect(result).toEqual({
      decision: "deny",
      reason: "null byte in command",
    });
  });

  test("rejects non-printable control characters", () => {
    const result = normalizeAndSplit("echo \x01hello");
    expect(result).toEqual({
      decision: "deny",
      reason: expect.stringContaining("control character"),
    });
  });

  test("allows tabs", () => {
    const result = normalizeAndSplit("echo\thello");
    expect(result.decision).toBe("continue");
  });

  test("normalizes CRLF to LF", () => {
    const result = normalizeAndSplit("echo hello\r\necho world");
    expect(result.decision).toBe("continue");
    if (result.decision === "continue") {
      expect(result.lines).toEqual(["echo hello", "echo world"]);
    }
  });

  test("splits on newlines", () => {
    const result = normalizeAndSplit("echo hello\necho world");
    expect(result.decision).toBe("continue");
    if (result.decision === "continue") {
      expect(result.lines).toEqual(["echo hello", "echo world"]);
    }
  });

  test("joins backslash line continuations", () => {
    const result = normalizeAndSplit("sudo\\\nreboot");
    expect(result.decision).toBe("continue");
    if (result.decision === "continue") {
      expect(result.lines).toEqual(["sudoreboot"]);
    }
  });

  test("filters empty lines", () => {
    const result = normalizeAndSplit("echo hello\n\necho world");
    expect(result.decision).toBe("continue");
    if (result.decision === "continue") {
      expect(result.lines).toEqual(["echo hello", "echo world"]);
    }
  });

  test("single line with no newlines", () => {
    const result = normalizeAndSplit("echo hello");
    expect(result.decision).toBe("continue");
    if (result.decision === "continue") {
      expect(result.lines).toEqual(["echo hello"]);
    }
  });

  test("rejects DEL character (0x7f)", () => {
    const result = normalizeAndSplit("echo \x7fhello");
    expect(result).toEqual({
      decision: "deny",
      reason: expect.stringContaining("control character"),
    });
  });

  test("allows newline and tab but rejects other control chars", () => {
    const result = normalizeAndSplit("echo \x0bhello");
    expect(result.decision).toBe("deny");
  });
});

describe("prescanLine", () => {
  test("denies $GH_PAT", () => {
    const result = prescanLine("echo $GH_PAT");
    expect(result).toEqual({
      decision: "deny",
      reason: expect.stringContaining("credential reference"),
    });
  });

  test("denies ${CLAUDE_CODE_OAUTH_TOKEN}", () => {
    const result = prescanLine("echo ${CLAUDE_CODE_OAUTH_TOKEN}");
    expect(result).toEqual({
      decision: "deny",
      reason: expect.stringContaining("credential reference"),
    });
  });

  test("denies $FLY_ACCESS_TOKEN", () => {
    const result = prescanLine("echo $FLY_ACCESS_TOKEN");
    expect(result.decision).toBe("deny");
  });

  test("denies ANSI-C quoting", () => {
    const result = prescanLine("$'\\x73\\x75\\x64\\x6f' reboot");
    expect(result).toEqual({
      decision: "deny",
      reason: expect.stringContaining("ANSI-C"),
    });
  });

  test("does not false-positive on normal commands", () => {
    const result = prescanLine("echo hello");
    expect(result.decision).not.toBe("deny");
  });

  test("escalates .npmrc reference", () => {
    const result = prescanLine("cat .npmrc");
    expect(result).toEqual({
      decision: "escalate",
      reason: expect.stringContaining("credential file"),
    });
  });

  test("escalates .ghtoken reference", () => {
    const result = prescanLine("cat .ghtoken");
    expect(result.decision).toBe("escalate");
  });

  test("escalates hosts.yml reference", () => {
    const result = prescanLine("cat hosts.yml");
    expect(result.decision).toBe("escalate");
  });

  test("escalates .fly/ reference", () => {
    const result = prescanLine("ls .fly/config");
    expect(result.decision).toBe("escalate");
  });

  test("escalates GH_PAT as string", () => {
    const result = prescanLine('echo "the token is GH_PAT"');
    expect(result.decision).toBe("escalate");
  });

  test("escalates GH_TOKEN as string", () => {
    const result = prescanLine("grep GH_TOKEN .env");
    expect(result.decision).toBe("escalate");
  });

  test("escalates GH_DEBUG", () => {
    const result = prescanLine("GH_DEBUG=1 gh api");
    expect(result.decision).toBe("escalate");
  });

  test("escalates OTEL_EXPORTER_OTLP_HEADERS", () => {
    const result = prescanLine("echo OTEL_EXPORTER_OTLP_HEADERS");
    expect(result.decision).toBe("escalate");
  });

  test("continues for clean command", () => {
    const result = prescanLine("echo hello world");
    expect(result).toEqual({ decision: "continue" });
  });

  test("continues for git command", () => {
    const result = prescanLine("git status");
    expect(result).toEqual({ decision: "continue" });
  });
});
