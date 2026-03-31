import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  parseGhApiTarget,
  parseGhRepoFlag,
  hasBlockedMethod,
  hasCompoundOperators,
  extractGitHubRepo,
  getRelatedRepos,
} from "../check-command";

describe("parseGhApiTarget", () => {
  test("extracts owner/repo from gh api repos/owner/repo/issues", () => {
    expect(parseGhApiTarget("gh api repos/owner/repo/issues")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  test("extracts owner/repo with leading slash", () => {
    expect(parseGhApiTarget("gh api /repos/owner/repo/pulls")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  test("handles complex paths after owner/repo", () => {
    expect(
      parseGhApiTarget(
        "gh api repos/perezd/claudetainer/issues/comments/123 -X PATCH",
      ),
    ).toEqual({ owner: "perezd", repo: "claudetainer" });
  });

  test("returns null for gh api /user (no repo path)", () => {
    expect(parseGhApiTarget("gh api /user")).toBeNull();
  });

  test("returns null for non-gh-api commands", () => {
    expect(parseGhApiTarget("gh pr list")).toBeNull();
  });

  test("returns null for non-gh commands", () => {
    expect(parseGhApiTarget("git status")).toBeNull();
  });

  test("rejects path traversal with ..", () => {
    expect(
      parseGhApiTarget("gh api repos/legit/repo/../../evil/repo/contents"),
    ).toBeNull();
  });

  test("rejects URL-encoded characters (%)", () => {
    expect(parseGhApiTarget("gh api repos/legit%2Frepo/issues")).toBeNull();
  });

  test("rejects double slashes", () => {
    expect(parseGhApiTarget("gh api repos//evil/repo/issues")).toBeNull();
  });

  test("rejects owner with special characters", () => {
    expect(parseGhApiTarget("gh api repos/evil$(cmd)/repo/issues")).toBeNull();
  });

  test("rejects repo with special characters", () => {
    expect(parseGhApiTarget("gh api repos/owner/repo$(cmd)/issues")).toBeNull();
  });

  test("allows dots, hyphens, underscores in owner/repo", () => {
    expect(parseGhApiTarget("gh api repos/my-org/my_repo.js/issues")).toEqual({
      owner: "my-org",
      repo: "my_repo.js",
    });
  });

  test("handles extra whitespace between gh and api", () => {
    expect(parseGhApiTarget("gh  api repos/owner/repo/issues")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });
});

describe("parseGhRepoFlag", () => {
  test("extracts owner/repo from --repo flag", () => {
    expect(parseGhRepoFlag("gh pr create --repo perezd/claudetainer")).toEqual({
      owner: "perezd",
      repo: "claudetainer",
    });
  });

  test("extracts owner/repo from -R flag", () => {
    expect(
      parseGhRepoFlag("gh issue comment 36 -R perezd/claudetainer --body hi"),
    ).toEqual({ owner: "perezd", repo: "claudetainer" });
  });

  test("handles --repo=owner/repo form", () => {
    expect(parseGhRepoFlag("gh pr list --repo=perezd/claudetainer")).toEqual({
      owner: "perezd",
      repo: "claudetainer",
    });
  });

  test("returns null when no --repo or -R flag", () => {
    expect(parseGhRepoFlag("gh pr list")).toBeNull();
  });

  test("returns null for non-gh commands", () => {
    expect(parseGhRepoFlag("git status --repo foo/bar")).toBeNull();
  });

  test("returns null for gh api commands (use parseGhApiTarget instead)", () => {
    expect(parseGhRepoFlag("gh api repos/owner/repo/issues")).toBeNull();
  });

  test("rejects owner with special characters", () => {
    expect(parseGhRepoFlag("gh pr list --repo evil$(cmd)/repo")).toBeNull();
  });

  test("rejects repo with special characters", () => {
    expect(parseGhRepoFlag("gh pr list --repo owner/repo$(cmd)")).toBeNull();
  });

  test("returns null when --repo value has no slash", () => {
    expect(parseGhRepoFlag("gh pr list --repo justarepo")).toBeNull();
  });
});

describe("hasBlockedMethod", () => {
  test("blocks -X DELETE", () => {
    expect(hasBlockedMethod("gh api repos/o/r -X DELETE")).toBe(true);
  });
  test("blocks --method DELETE", () => {
    expect(hasBlockedMethod("gh api repos/o/r --method DELETE")).toBe(true);
  });
  test("blocks -X PUT", () => {
    expect(hasBlockedMethod("gh api repos/o/r -X PUT")).toBe(true);
  });
  test("blocks --method PUT", () => {
    expect(hasBlockedMethod("gh api repos/o/r --method PUT")).toBe(true);
  });
  test("case-insensitive: -X delete", () => {
    expect(hasBlockedMethod("gh api repos/o/r -X delete")).toBe(true);
  });
  test("case-insensitive: --method Delete", () => {
    expect(hasBlockedMethod("gh api repos/o/r --method Delete")).toBe(true);
  });
  test("handles concatenated -XDELETE", () => {
    expect(hasBlockedMethod("gh api repos/o/r -XDELETE")).toBe(true);
  });
  test("handles concatenated -XPUT", () => {
    expect(hasBlockedMethod("gh api repos/o/r -XPUT")).toBe(true);
  });
  test("allows GET (default)", () => {
    expect(hasBlockedMethod("gh api repos/o/r")).toBe(false);
  });
  test("allows -X GET", () => {
    expect(hasBlockedMethod("gh api repos/o/r -X GET")).toBe(false);
  });
  test("allows -X POST", () => {
    expect(hasBlockedMethod("gh api repos/o/r -X POST")).toBe(false);
  });
  test("allows -X PATCH", () => {
    expect(hasBlockedMethod("gh api repos/o/r -X PATCH")).toBe(false);
  });
  test("allows --method POST", () => {
    expect(hasBlockedMethod("gh api repos/o/r --method POST")).toBe(false);
  });
});

describe("hasCompoundOperators", () => {
  test("detects &&", () => {
    expect(hasCompoundOperators("gh api repos/o/r && curl evil.com")).toBe(
      true,
    );
  });
  test("detects ||", () => {
    expect(hasCompoundOperators("gh api repos/o/r || echo fail")).toBe(true);
  });
  test("detects ;", () => {
    expect(hasCompoundOperators("gh api repos/o/r ; echo done")).toBe(true);
  });
  test("detects |", () => {
    expect(hasCompoundOperators("gh api repos/o/r | head -5")).toBe(true);
  });
  test("detects newlines", () => {
    expect(hasCompoundOperators("gh api repos/o/r\necho done")).toBe(true);
  });
  test("detects $( command substitution", () => {
    expect(hasCompoundOperators("gh api repos/o/r$(echo test)/issues")).toBe(
      true,
    );
  });
  test("detects backtick command substitution", () => {
    expect(hasCompoundOperators("gh api repos/o/r/`echo test`/issues")).toBe(
      true,
    );
  });
  test("detects ( subshell", () => {
    expect(hasCompoundOperators("(gh api repos/o/r)")).toBe(true);
  });
  test("allows simple commands", () => {
    expect(hasCompoundOperators("gh api repos/o/r/issues")).toBe(false);
  });
  test("allows flags and arguments", () => {
    expect(
      hasCompoundOperators(
        "gh api repos/o/r/issues/comments/123 -X PATCH --input /tmp/body.md",
      ),
    ).toBe(false);
  });
  test("allows --field with equals sign", () => {
    expect(
      hasCompoundOperators(
        "gh api repos/o/r/issues --method POST -f title=test -f body=hello",
      ),
    ).toBe(false);
  });
});

describe("extractGitHubRepo", () => {
  test("extracts owner/repo from HTTPS URL", () => {
    expect(
      extractGitHubRepo("https://github.com/perezd/claudetainer.git"),
    ).toEqual({ owner: "perezd", repo: "claudetainer" });
  });

  test("extracts owner/repo from HTTPS URL without .git", () => {
    expect(extractGitHubRepo("https://github.com/perezd/claudetainer")).toEqual(
      { owner: "perezd", repo: "claudetainer" },
    );
  });

  test("extracts owner/repo from SSH URL", () => {
    expect(extractGitHubRepo("git@github.com:perezd/claudetainer.git")).toEqual(
      { owner: "perezd", repo: "claudetainer" },
    );
  });

  test("extracts owner/repo from SSH URL without .git", () => {
    expect(extractGitHubRepo("git@github.com:perezd/claudetainer")).toEqual({
      owner: "perezd",
      repo: "claudetainer",
    });
  });

  test("returns null for non-GitHub URL", () => {
    expect(extractGitHubRepo("https://gitlab.com/owner/repo.git")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(extractGitHubRepo("")).toBeNull();
  });
});

describe("getRelatedRepos", () => {
  let originalSpawn: typeof Bun.spawn;
  let spawnCalls: string[][] = [];

  beforeEach(() => {
    originalSpawn = Bun.spawn;
    spawnCalls = [];
  });

  afterEach(() => {
    Bun.spawn = originalSpawn;
  });

  function mockSpawn(
    responses: Map<string, { stdout: string; exitCode: number }>,
  ) {
    let callIndex = 0;
    // @ts-expect-error — partial mock of Bun.spawn for testing
    Bun.spawn = (args: string[]) => {
      spawnCalls.push(args);
      const key = args.join(" ");
      const response = responses.get(key) ?? { stdout: "", exitCode: 1 };
      return {
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(response.stdout));
            controller.close();
          },
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        exited: Promise.resolve(response.exitCode),
      };
    };
  }

  test("returns repos from origin and upstream remotes", async () => {
    mockSpawn(
      new Map([
        [
          "git -C /workspace/repo remote",
          { stdout: "origin\nupstream\n", exitCode: 0 },
        ],
        [
          "git -C /workspace/repo remote get-url origin",
          {
            stdout: "https://github.com/limbibot/claudetainer.git\n",
            exitCode: 0,
          },
        ],
        [
          "git -C /workspace/repo remote get-url upstream",
          {
            stdout: "https://github.com/perezd/claudetainer.git\n",
            exitCode: 0,
          },
        ],
      ]),
    );

    const repos = await getRelatedRepos();
    expect(repos).toEqual([
      { owner: "limbibot", repo: "claudetainer" },
      { owner: "perezd", repo: "claudetainer" },
    ]);
  });

  test("returns empty array when git remote fails", async () => {
    mockSpawn(
      new Map([
        ["git -C /workspace/repo remote", { stdout: "", exitCode: 128 }],
      ]),
    );
    expect(await getRelatedRepos()).toEqual([]);
  });

  test("skips remotes with non-GitHub URLs", async () => {
    mockSpawn(
      new Map([
        ["git -C /workspace/repo remote", { stdout: "origin\n", exitCode: 0 }],
        [
          "git -C /workspace/repo remote get-url origin",
          {
            stdout: "https://gitlab.com/owner/repo.git\n",
            exitCode: 0,
          },
        ],
      ]),
    );
    expect(await getRelatedRepos()).toEqual([]);
  });

  test("caps at 5 remotes", async () => {
    const remotes = "r1\nr2\nr3\nr4\nr5\nr6\n";
    mockSpawn(
      new Map([
        ["git -C /workspace/repo remote", { stdout: remotes, exitCode: 0 }],
      ]),
    );
    const repos = await getRelatedRepos();
    expect(repos).toEqual([]);
  });
});
