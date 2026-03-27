import { describe, expect, test, afterEach, beforeEach } from "bun:test";
import {
  parseRemoteFromPushCommand,
  extractGitHubOwner,
  isOwnedRemotePush,
} from "../check-command";

describe("parseRemoteFromPushCommand", () => {
  test("extracts remote from 'git push origin main'", () => {
    expect(parseRemoteFromPushCommand("git push origin main")).toBe("origin");
  });

  test("extracts remote from 'git push my-fork feature'", () => {
    expect(parseRemoteFromPushCommand("git push my-fork feature")).toBe(
      "my-fork",
    );
  });

  test("skips flags: 'git push --force origin main'", () => {
    expect(parseRemoteFromPushCommand("git push --force origin main")).toBe(
      "origin",
    );
  });

  test("skips flags: 'git push -u origin feature'", () => {
    expect(parseRemoteFromPushCommand("git push -u origin feature")).toBe(
      "origin",
    );
  });

  test("skips compound flags: 'git push --set-upstream origin main'", () => {
    expect(
      parseRemoteFromPushCommand("git push --set-upstream origin main"),
    ).toBe("origin");
  });

  test("returns null for bare 'git push' (can't assume origin)", () => {
    expect(parseRemoteFromPushCommand("git push")).toBeNull();
  });

  test("returns null for 'git push --force' without explicit remote", () => {
    expect(parseRemoteFromPushCommand("git push --force")).toBeNull();
  });

  test("returns null when value-consuming flag -o is present", () => {
    expect(
      parseRemoteFromPushCommand("git push -o ci.skip origin main"),
    ).toBeNull();
  });

  test("returns null when --push-option is present", () => {
    expect(
      parseRemoteFromPushCommand("git push --push-option ci.skip origin main"),
    ).toBeNull();
  });

  test("returns null when --repo is present", () => {
    expect(
      parseRemoteFromPushCommand(
        "git push --repo=https://example.com origin main",
      ),
    ).toBeNull();
  });

  test("returns null for non-git-push command", () => {
    expect(parseRemoteFromPushCommand("git status")).toBeNull();
  });

  test("returns null for 'echo git push'", () => {
    expect(parseRemoteFromPushCommand("echo git push")).toBeNull();
  });
});

describe("extractGitHubOwner", () => {
  test("extracts owner from HTTPS URL", () => {
    expect(extractGitHubOwner("https://github.com/alice/repo.git")).toBe(
      "alice",
    );
  });

  test("extracts owner from HTTPS URL without .git", () => {
    expect(extractGitHubOwner("https://github.com/alice/repo")).toBe("alice");
  });

  test("extracts owner from SSH URL", () => {
    expect(extractGitHubOwner("git@github.com:alice/repo.git")).toBe("alice");
  });

  test("extracts owner from SSH URL without .git", () => {
    expect(extractGitHubOwner("git@github.com:alice/repo")).toBe("alice");
  });

  test("returns null for GitLab URL", () => {
    expect(extractGitHubOwner("https://gitlab.com/alice/repo.git")).toBeNull();
  });

  test("returns null for non-URL string", () => {
    expect(extractGitHubOwner("not-a-url")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(extractGitHubOwner("")).toBeNull();
  });
});

describe("isOwnedRemotePush", () => {
  let originalSpawn: typeof Bun.spawn;

  beforeEach(() => {
    originalSpawn = Bun.spawn;
  });

  afterEach(() => {
    Bun.spawn = originalSpawn;
  });

  let spawnCalls: string[][] = [];

  /**
   * Mock Bun.spawn to handle two sequential calls:
   *   1. git config user.name → returns userName
   *   2. git remote get-url --push <remote> → returns remoteUrl
   *
   * configExitCode / remoteExitCode let individual tests simulate failures.
   */
  function mockGitSpawn(
    userName: string,
    remoteUrl: string,
    { configExitCode = 0, remoteExitCode = 0 } = {},
  ) {
    spawnCalls = [];
    let callIndex = 0;
    // @ts-expect-error — partial mock of Bun.spawn for testing
    Bun.spawn = (args: string[]) => {
      spawnCalls.push(args);
      const idx = callIndex++;
      const isConfigCall = idx === 0;
      const output = isConfigCall ? userName : remoteUrl;
      const exit = isConfigCall ? configExitCode : remoteExitCode;
      return {
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(output + "\n"));
            controller.close();
          },
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        exited: Promise.resolve(exit),
      };
    };
  }

  test("allows push to owned remote", async () => {
    mockGitSpawn("alice", "https://github.com/alice/repo.git");
    expect(await isOwnedRemotePush("git push origin main")).toBe(true);
    // Verify both spawn calls
    expect(spawnCalls[0]).toEqual(["git", "config", "user.name"]);
    expect(spawnCalls[1]).toEqual([
      "git",
      "remote",
      "get-url",
      "--push",
      "origin",
    ]);
  });

  test("denies push to non-owned remote", async () => {
    mockGitSpawn("alice", "https://github.com/upstream-org/repo.git");
    expect(await isOwnedRemotePush("git push origin main")).toBe(false);
  });

  test("allows push to owned non-origin remote", async () => {
    mockGitSpawn("alice", "https://github.com/alice/repo.git");
    expect(await isOwnedRemotePush("git push my-fork feature")).toBe(true);
    expect(spawnCalls[1]).toEqual([
      "git",
      "remote",
      "get-url",
      "--push",
      "my-fork",
    ]);
  });

  test("case-insensitive username match", async () => {
    mockGitSpawn("Alice", "https://github.com/alice/repo.git");
    expect(await isOwnedRemotePush("git push origin main")).toBe(true);
  });

  test("allows force push to owned remote", async () => {
    mockGitSpawn("alice", "https://github.com/alice/repo.git");
    expect(await isOwnedRemotePush("git push --force origin main")).toBe(true);
  });

  test("blocks --delete even on owned remote", async () => {
    mockGitSpawn("alice", "https://github.com/alice/repo.git");
    expect(await isOwnedRemotePush("git push --delete origin feature")).toBe(
      false,
    );
  });

  test("blocks -d even on owned remote", async () => {
    mockGitSpawn("alice", "https://github.com/alice/repo.git");
    expect(await isOwnedRemotePush("git push -d origin feature")).toBe(false);
  });

  test("returns false when git config user.name fails", async () => {
    mockGitSpawn("", "https://github.com/alice/repo.git", {
      configExitCode: 1,
    });
    expect(await isOwnedRemotePush("git push origin main")).toBe(false);
  });

  test("returns false when git config user.name is empty", async () => {
    mockGitSpawn("", "https://github.com/alice/repo.git");
    expect(await isOwnedRemotePush("git push origin main")).toBe(false);
  });

  test("returns false when git remote get-url fails", async () => {
    mockGitSpawn("alice", "", { remoteExitCode: 128 });
    expect(await isOwnedRemotePush("git push origin main")).toBe(false);
  });

  test("returns false for non-GitHub remote", async () => {
    mockGitSpawn("alice", "https://gitlab.com/alice/repo.git");
    expect(await isOwnedRemotePush("git push origin main")).toBe(false);
  });

  test("returns false for bare 'git push' (can't assume origin)", async () => {
    mockGitSpawn("alice", "https://github.com/alice/repo.git");
    expect(await isOwnedRemotePush("git push")).toBe(false);
  });

  test("returns false when value-consuming flags are present", async () => {
    mockGitSpawn("alice", "https://github.com/alice/repo.git");
    expect(await isOwnedRemotePush("git push -o ci.skip origin main")).toBe(
      false,
    );
  });

  test("returns false for non-push commands", async () => {
    mockGitSpawn("alice", "https://github.com/alice/repo.git");
    expect(await isOwnedRemotePush("git status")).toBe(false);
  });

  test("handles SSH remote URL", async () => {
    mockGitSpawn("alice", "git@github.com:alice/repo.git");
    expect(await isOwnedRemotePush("git push origin main")).toBe(true);
  });

  test("skips -u flag and finds remote", async () => {
    mockGitSpawn("alice", "https://github.com/alice/repo.git");
    expect(await isOwnedRemotePush("git push -u origin feature")).toBe(true);
  });

  // SECURITY: pushurl vs url divergence — ownership check must use pushurl
  // because that is the URL git actually pushes to.
  test("uses push URL for ownership check (pushurl security invariant)", async () => {
    mockGitSpawn("alice", "https://github.com/victim-org/repo.git");
    expect(await isOwnedRemotePush("git push origin main")).toBe(false);
  });

  // Regression: in the container, GIT_USER_NAME is only available during the
  // entrypoint boot sequence. The approval process inherits git config (set via
  // `git config --system user.name`) but NOT the env var. The ownership check
  // must use `git config user.name`, not process.env.GIT_USER_NAME.
  test("allows push when env var is unset but git config has correct owner", async () => {
    delete process.env.GIT_USER_NAME;
    mockGitSpawn("limbibot", "https://github.com/limbibot/claudetainer.git");
    expect(
      await isOwnedRemotePush(
        "git push -u origin feat/claude-install-verification",
      ),
    ).toBe(true);
  });
});
