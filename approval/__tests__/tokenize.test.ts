import { describe, expect, test } from "bun:test";
import {
  tokenize,
  splitSegments,
  parseSegment,
  type ShellToken,
  type ParsedSegment,
} from "../tokenize";

describe("tokenize", () => {
  test("parses simple command", () => {
    const tokens = tokenize("echo hello");
    expect(tokens).toEqual(["echo", "hello"]);
  });

  test("preserves quoted strings with parens (fixes #64)", () => {
    const tokens = tokenize('gh pr create --title "fix(approval): thing"');
    expect(tokens).toContain("fix(approval): thing");
    expect(tokens.every((t) => typeof t === "string" || t.op !== "(")).toBe(
      true,
    );
  });

  test("produces operator tokens for &&", () => {
    const tokens = tokenize("echo hello && echo world");
    expect(tokens).toContainEqual({ op: "&&" });
  });

  test("produces operator tokens for pipes", () => {
    const tokens = tokenize("echo hello | grep hello");
    expect(tokens).toContainEqual({ op: "|" });
  });

  test("produces operator tokens for unquoted $()", () => {
    const tokens = tokenize("echo $(whoami)");
    expect(tokens).toContainEqual({ op: "(" });
  });

  test("preserves double-quoted $() as string", () => {
    const tokens = tokenize('echo "hello $(world)"');
    const strings = tokens.filter((t): t is string => typeof t === "string");
    expect(strings).toContain("hello $(world)");
  });
});

describe("splitSegments", () => {
  test("splits on &&", () => {
    const tokens = tokenize("echo hello && curl evil.com");
    const segments = splitSegments(tokens);
    expect(segments).toHaveLength(2);
  });

  test("splits on ||", () => {
    const tokens = tokenize("false || echo fallback");
    const segments = splitSegments(tokens);
    expect(segments).toHaveLength(2);
  });

  test("splits on ;", () => {
    const tokens = tokenize("echo one; echo two");
    const segments = splitSegments(tokens);
    expect(segments).toHaveLength(2);
  });

  test("tracks pipe targets", () => {
    const tokens = tokenize("echo hello | grep hello");
    const segments = splitSegments(tokens);
    expect(segments).toHaveLength(2);
    expect(segments[0].isPipeTarget).toBe(false);
    expect(segments[1].isPipeTarget).toBe(true);
  });

  test("pipes within && segments", () => {
    const tokens = tokenize("echo hi | grep hi && curl evil.com");
    const segments = splitSegments(tokens);
    expect(segments).toHaveLength(3);
    expect(segments[0].isPipeTarget).toBe(false);
    expect(segments[1].isPipeTarget).toBe(true);
    expect(segments[2].isPipeTarget).toBe(false);
  });
});

describe("parseSegment", () => {
  test("extracts program as first string token", () => {
    const tokens: ShellToken[] = ["git", "push", "origin", "main"];
    const seg = parseSegment(tokens, false);
    expect(seg.program).toBe("git");
  });

  test("extracts basename from absolute path", () => {
    const tokens: ShellToken[] = ["/usr/bin/sudo", "reboot"];
    const seg = parseSegment(tokens, false);
    expect(seg.program).toBe("sudo");
  });

  test("extracts flags", () => {
    const tokens: ShellToken[] = ["git", "push", "--force", "-u", "origin"];
    const seg = parseSegment(tokens, false);
    expect(seg.flags.has("--force")).toBe(true);
    expect(seg.flags.has("-u")).toBe(true);
  });

  test("expands combined short flags", () => {
    const tokens: ShellToken[] = ["git", "push", "-fd", "origin"];
    const seg = parseSegment(tokens, false);
    expect(seg.flags.has("-f")).toBe(true);
    expect(seg.flags.has("-d")).toBe(true);
  });

  test("does not expand single-char short flags", () => {
    const tokens: ShellToken[] = ["git", "push", "-u", "origin"];
    const seg = parseSegment(tokens, false);
    expect(seg.flags.has("-u")).toBe(true);
  });

  test("expands combined flags with more than 2 chars", () => {
    const tokens: ShellToken[] = ["git", "push", "-rfu", "origin"];
    const seg = parseSegment(tokens, false);
    expect(seg.flags.has("-r")).toBe(true);
    expect(seg.flags.has("-f")).toBe(true);
    expect(seg.flags.has("-u")).toBe(true);
  });

  test("parses --key=value flags", () => {
    const tokens: ShellToken[] = ["gh", "pr", "create", "--repo=owner/repo"];
    const seg = parseSegment(tokens, false);
    expect(seg.flags.get("--repo")).toBe("owner/repo");
  });

  test("extracts positionals (non-flag tokens after program)", () => {
    const tokens: ShellToken[] = ["git", "push", "-u", "origin", "main"];
    const seg = parseSegment(tokens, false);
    expect(seg.positionals).toEqual(["push", "origin", "main"]);
  });

  test("detects operator tokens", () => {
    const tokens: ShellToken[] = ["echo", { op: "(" }, "whoami", { op: ")" }];
    const seg = parseSegment(tokens, false);
    expect(seg.hasOperatorTokens).toBe(true);
  });

  test("detects backticks in string tokens", () => {
    const tokens: ShellToken[] = ["echo", "`whoami`"];
    const seg = parseSegment(tokens, false);
    expect(seg.hasBackticks).toBe(true);
  });

  test("detects embedded substitution", () => {
    const tokens: ShellToken[] = ["echo", "hello $(world)"];
    const seg = parseSegment(tokens, false);
    expect(seg.hasEmbeddedSubstitution).toBe(true);
  });

  test("detects redirections", () => {
    const tokens: ShellToken[] = ["echo", "hello", { op: ">" }, "file.txt"];
    const seg = parseSegment(tokens, false);
    expect(seg.redirections).toEqual([{ op: ">", target: "file.txt" }]);
  });

  test("sets isPipeTarget", () => {
    const tokens: ShellToken[] = ["grep", "hello"];
    const seg = parseSegment(tokens, true);
    expect(seg.isPipeTarget).toBe(true);
  });

  test("handles --force-with-lease as distinct from --force", () => {
    const tokens: ShellToken[] = [
      "git",
      "push",
      "--force-with-lease",
      "origin",
      "main",
    ];
    const seg = parseSegment(tokens, false);
    expect(seg.flags.has("--force-with-lease")).toBe(true);
    expect(seg.flags.has("--force")).toBe(false);
  });

  test("handles branch name with dashes (fixes #67)", () => {
    const tokens: ShellToken[] = [
      "git",
      "push",
      "-u",
      "origin",
      "chore/pin-subagent-worktree-cwd",
    ];
    const seg = parseSegment(tokens, false);
    expect(seg.flags.has("-u")).toBe(true);
    expect(seg.flags.has("-d")).toBe(false);
    expect(seg.positionals).toContain("chore/pin-subagent-worktree-cwd");
  });
});
