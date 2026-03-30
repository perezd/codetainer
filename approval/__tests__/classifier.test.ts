import { describe, expect, test } from "bun:test";
import { parseVerdict, buildUserMessage, SYSTEM_PROMPT } from "../classifier";

describe("parseVerdict", () => {
  test("parses allow verdict", () => {
    const v = parseVerdict('{"verdict":"allow","reason":"safe command"}');
    expect(v).toEqual({ verdict: "allow", reason: "safe command" });
  });

  test("parses block verdict", () => {
    const v = parseVerdict(
      '{"verdict":"block","reason":"privilege escalation"}',
    );
    expect(v).toEqual({ verdict: "block", reason: "privilege escalation" });
  });

  test("parses approve verdict", () => {
    const v = parseVerdict('{"verdict":"approve","reason":"installs lodash"}');
    expect(v).toEqual({ verdict: "approve", reason: "installs lodash" });
  });

  test("throws on invalid verdict value", () => {
    expect(() => parseVerdict('{"verdict":"unknown","reason":"x"}')).toThrow(
      "invalid verdict",
    );
  });

  test("throws on missing reason", () => {
    expect(() => parseVerdict('{"verdict":"allow"}')).toThrow("missing reason");
  });

  test("throws on non-JSON", () => {
    expect(() => parseVerdict("not json")).toThrow();
  });

  test("extracts JSON from text with surrounding content", () => {
    const v = parseVerdict(
      'Here is my response: {"verdict":"allow","reason":"safe"}\n',
    );
    expect(v).toEqual({ verdict: "allow", reason: "safe" });
  });

  test("handles reason strings containing braces", () => {
    const v = parseVerdict(
      '{"verdict":"block","reason":"uses eval{} syntax in code"}',
    );
    expect(v).toEqual({
      verdict: "block",
      reason: "uses eval{} syntax in code",
    });
  });
});

describe("buildUserMessage", () => {
  test("wraps command in <command> tags", () => {
    const msg = buildUserMessage("curl http://example.com");
    expect(msg).toContain("<command>\ncurl http://example.com\n</command>");
  });

  test("does not include system prompt (sent separately via API)", () => {
    const msg = buildUserMessage("curl http://example.com");
    expect(msg).not.toContain("ALLOW when the command");
  });
});

describe("SYSTEM_PROMPT", () => {
  test("includes classification rules", () => {
    expect(SYSTEM_PROMPT).toContain("ALLOW when the command");
    expect(SYSTEM_PROMPT).toContain("BLOCK when the command");
    expect(SYSTEM_PROMPT).toContain("APPROVE when the command");
  });
});
