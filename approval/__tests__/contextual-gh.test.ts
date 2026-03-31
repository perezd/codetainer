import { describe, expect, test } from "bun:test";
import { parseGhApiTarget, parseGhRepoFlag } from "../check-command";

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
