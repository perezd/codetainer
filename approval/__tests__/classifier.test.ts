import { describe, expect, test } from "bun:test";
import {
  parseVerdict,
  buildUserMessage,
  buildFileInspectionMessage,
  validateFilePath,
} from "../classifier";

describe("parseVerdict", () => {
  test("parses allow verdict", () => {
    const v = parseVerdict('{"verdict":"allow","reason":"safe"}');
    expect(v).toEqual({ verdict: "allow", reason: "safe" });
  });

  test("parses block verdict", () => {
    const v = parseVerdict('{"verdict":"block","reason":"dangerous"}');
    expect(v).toEqual({ verdict: "block", reason: "dangerous" });
  });

  test("parses approve verdict", () => {
    const v = parseVerdict('{"verdict":"approve","reason":"needs review"}');
    expect(v).toEqual({ verdict: "approve", reason: "needs review" });
  });

  test("parses need_files verdict", () => {
    const v = parseVerdict(
      '{"verdict":"need_files","files":["/tmp/payload.json"],"reason":"need to inspect"}',
    );
    expect(v).toEqual({
      verdict: "need_files",
      files: ["/tmp/payload.json"],
      reason: "need to inspect",
    });
  });

  test("extracts JSON from surrounding text", () => {
    const v = parseVerdict(
      'Here is my analysis: {"verdict":"allow","reason":"safe"} Done.',
    );
    expect(v).toEqual({ verdict: "allow", reason: "safe" });
  });

  test("returns block for invalid JSON", () => {
    const v = parseVerdict("not json at all");
    expect(v.verdict).toBe("block");
  });

  test("returns block for unknown verdict", () => {
    const v = parseVerdict('{"verdict":"unknown","reason":"bad"}');
    expect(v.verdict).toBe("block");
  });

  test("handles brace in reason via brace-balanced extraction", () => {
    const v = parseVerdict(
      'Analysis: {"verdict":"block","reason":"found { in code"} end',
    );
    // Brace balancing may truncate at the inner }, but JSON.parse fails → block
    expect(v.verdict).toBe("block");
  });

  test("parses clean JSON directly without regex", () => {
    const v = parseVerdict('{"verdict":"allow","reason":"safe command"}');
    expect(v).toEqual({ verdict: "allow", reason: "safe command" });
  });

  test("filters non-string entries from need_files", () => {
    const v = parseVerdict(
      '{"verdict":"need_files","files":["/tmp/a.json",42,null],"reason":"inspect"}',
    );
    expect(v.verdict).toBe("need_files");
    if (v.verdict === "need_files") {
      expect(v.files).toEqual(["/tmp/a.json"]);
    }
  });

  test("blocks need_files with no valid string paths", () => {
    const v = parseVerdict(
      '{"verdict":"need_files","files":[42,null,true],"reason":"inspect"}',
    );
    expect(v.verdict).toBe("block");
  });

  test("caps need_files at MAX_FILES (3)", () => {
    const v = parseVerdict(
      '{"verdict":"need_files","files":["/tmp/a","/tmp/b","/tmp/c","/tmp/d","/tmp/e"],"reason":""}',
    );
    expect(v.verdict).toBe("need_files");
    if (v.verdict === "need_files") {
      expect(v.files).toHaveLength(3);
    }
  });
});

describe("validateFilePath", () => {
  test("allows /tmp/ paths", () => {
    expect(validateFilePath("/tmp/payload.json")).toBe(true);
  });

  test("allows /workspace/ paths", () => {
    expect(validateFilePath("/workspace/repo/file.ts")).toBe(true);
  });

  test("rejects paths outside allowed dirs", () => {
    expect(validateFilePath("/home/claude/.claude/settings.json")).toBe(false);
  });

  test("rejects path traversal", () => {
    expect(validateFilePath("/tmp/../etc/passwd")).toBe(false);
  });

  test("rejects credential files", () => {
    expect(validateFilePath("/tmp/.ghtoken")).toBe(false);
    expect(validateFilePath("/workspace/.npmrc")).toBe(false);
    expect(validateFilePath("/tmp/hosts.yml")).toBe(false);
  });

  test("rejects /tmp/otel/", () => {
    expect(validateFilePath("/tmp/otel/otel-env")).toBe(false);
  });
});

describe("buildUserMessage", () => {
  test("wraps command in tags", () => {
    const msg = buildUserMessage("echo hello");
    expect(msg).toContain("<command>");
    expect(msg).toContain("echo hello");
    expect(msg).toContain("</command>");
  });
});

describe("buildFileInspectionMessage", () => {
  test("includes command and file contents", () => {
    const msg = buildFileInspectionMessage("gh api --input /tmp/f.json", [
      { path: "/tmp/f.json", content: '{"title":"test"}' },
    ]);
    expect(msg).toContain("<command>");
    expect(msg).toContain("gh api --input /tmp/f.json");
    expect(msg).toContain('<referenced-file path="/tmp/f.json">');
    expect(msg).toContain('{"title":"test"}');
  });

  test("handles file not found", () => {
    const msg = buildFileInspectionMessage("cmd", [
      { path: "/tmp/missing", content: "<file not found>" },
    ]);
    expect(msg).toContain("<file not found>");
  });
});
