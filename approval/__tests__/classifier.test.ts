import { describe, expect, test } from "bun:test";
import { parseVerdict, buildPrompt } from "../classifier";

describe("parseVerdict", () => {
  test("parses allow verdict", () => {
    const v = parseVerdict('{"verdict":"allow","reason":"safe command"}');
    expect(v).toEqual({ verdict: "allow", reason: "safe command" });
  });

  test("parses block verdict", () => {
    const v = parseVerdict('{"verdict":"block","reason":"privilege escalation"}');
    expect(v).toEqual({ verdict: "block", reason: "privilege escalation" });
  });

  test("parses approve verdict", () => {
    const v = parseVerdict('{"verdict":"approve","reason":"installs lodash"}');
    expect(v).toEqual({ verdict: "approve", reason: "installs lodash" });
  });

  test("throws on invalid verdict value", () => {
    expect(() => parseVerdict('{"verdict":"unknown","reason":"x"}')).toThrow("invalid verdict");
  });

  test("throws on missing reason", () => {
    expect(() => parseVerdict('{"verdict":"allow"}')).toThrow("missing reason");
  });

  test("throws on non-JSON", () => {
    expect(() => parseVerdict("not json")).toThrow();
  });

  test("extracts JSON from text with surrounding content", () => {
    const v = parseVerdict('Here is my response: {"verdict":"allow","reason":"safe"}\n');
    expect(v).toEqual({ verdict: "allow", reason: "safe" });
  });

  test("handles reason strings containing braces", () => {
    const v = parseVerdict('{"verdict":"block","reason":"uses eval{} syntax in code"}');
    expect(v).toEqual({ verdict: "block", reason: "uses eval{} syntax in code" });
  });
});

describe("buildPrompt", () => {
  test("includes the command in a code fence", () => {
    const prompt = buildPrompt("curl http://example.com");
    expect(prompt).toContain("```\ncurl http://example.com\n```");
  });

  test("includes classification rules", () => {
    const prompt = buildPrompt("curl http://example.com");
    expect(prompt).toContain("ALLOW when the command");
    expect(prompt).toContain("BLOCK when the command");
    expect(prompt).toContain("APPROVE when the command");
  });
});
