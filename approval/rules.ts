import type { ParsedSegment } from "./tokenize";

export interface RuleResult {
  decision: "deny" | "escalate" | "continue";
  reason: string;
}

// ─── Deny sets & tables ──────────────────────────────────────────────────────

const ALWAYS_BLOCK_PROGRAMS = new Set([
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
]);

// Interpreter + flag that enables inline code execution
const INTERPRETER_INLINE: Array<{ prog: string; flags: string[] }> = [
  { prog: "python3", flags: ["-c"] },
  { prog: "python", flags: ["-c"] },
  { prog: "node", flags: ["-e", "--eval"] },
  { prog: "perl", flags: ["-e"] },
  { prog: "ruby", flags: ["-e"] },
  { prog: "declare", flags: ["-p"] },
];

const PIPE_TO_INTERPRETER = new Set([
  "python3",
  "python",
  "node",
  "bun",
  "perl",
  "ruby",
  "bash",
  "sh",
]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Normalise flyctl → fly so rules only need to handle "fly". */
function normalizeProgram(prog: string): string {
  return prog === "flyctl" ? "fly" : prog;
}

/**
 * Match a gh subcommand pattern.
 * positionals[0] is the first sub-command, positionals[1] is the second, etc.
 */
function matchesGhPattern(
  seg: ParsedSegment,
  sub1: string,
  sub2?: string,
): boolean {
  if (seg.positionals[0] !== sub1) return false;
  if (sub2 !== undefined && seg.positionals[1] !== sub2) return false;
  return true;
}

// ─── Deny rules ──────────────────────────────────────────────────────────────

function denyCheck(seg: ParsedSegment): RuleResult | null {
  const prog = normalizeProgram(seg.program);

  // 1. Always-block programs
  if (ALWAYS_BLOCK_PROGRAMS.has(prog)) {
    return { decision: "deny", reason: `program '${prog}' is always blocked` };
  }

  // 2. Interpreter inline execution (-c / -e / --eval)
  for (const { prog: p, flags } of INTERPRETER_INLINE) {
    if (prog === p) {
      for (const f of flags) {
        if (seg.flags.has(f) || seg.args.includes(f)) {
          return {
            decision: "deny",
            reason: `${prog} with ${f} flag executes arbitrary code`,
          };
        }
      }
    }
  }

  // 3. Pipe-to-interpreter
  if (seg.isPipeTarget && PIPE_TO_INTERPRETER.has(prog)) {
    return {
      decision: "deny",
      reason: `piping into '${prog}' executes arbitrary code`,
    };
  }

  // 4. Destructive filesystem
  if (prog === "rm") {
    // rm -rf <absolute path> — block only when a positional starts with /
    if (
      (seg.flags.has("-r") || seg.flags.has("--recursive")) &&
      (seg.flags.has("-f") || seg.flags.has("--force"))
    ) {
      const hasAbsPath = seg.positionals.some((p) => p.startsWith("/"));
      if (hasAbsPath) {
        return {
          decision: "deny",
          reason: "rm -rf with absolute path is destructive",
        };
      }
    }
  }

  if (prog === "chmod") {
    // chmod 777 is world-writable
    if (seg.positionals.some((p) => p === "777" || p === "0777")) {
      return {
        decision: "deny",
        reason: "chmod 777 makes files world-writable",
      };
    }
  }

  // /proc/ access
  if (seg.args.some((a) => a.startsWith("/proc/"))) {
    return {
      decision: "deny",
      reason: "/proc/ access can leak kernel/process state",
    };
  }

  // /dev/tcp/ or /dev/udp/ bash network redirection
  // Check both args (positional use) and redirection targets (e.g. > /dev/tcp/...)
  {
    const allPaths = [...seg.args, ...seg.redirections.map((r) => r.target)];
    if (
      allPaths.some(
        (a) => a.startsWith("/dev/tcp/") || a.startsWith("/dev/udp/"),
      )
    ) {
      return {
        decision: "deny",
        reason: "/dev/tcp/ and /dev/udp/ are bash network sockets",
      };
    }
  }

  // 5. find -exec / -execdir
  if (prog === "find") {
    if (seg.args.includes("-exec") || seg.args.includes("-execdir")) {
      return {
        decision: "deny",
        reason: "find -exec/-execdir executes arbitrary commands",
      };
    }
  }

  // 6. Git destructive operations
  if (prog === "git") {
    // git -c remote.* — flag injection to redirect remotes
    if (
      seg.args.includes("-c") &&
      seg.args.some((a) => a.startsWith("remote."))
    ) {
      return {
        decision: "deny",
        reason: "git -c remote.* can redirect push destinations",
      };
    }

    const sub = seg.positionals[0];

    if (sub === "push") {
      // Destructive push flags
      const destructiveLongFlags = [
        "--force",
        "--delete",
        "--tags",
        "--mirror",
        "--all",
      ];
      for (const f of destructiveLongFlags) {
        if (seg.flags.has(f)) {
          return {
            decision: "deny",
            reason: `git push ${f} is destructive`,
          };
        }
      }
      // Short flags: -f, -d (may be combined e.g. -fd)
      if (seg.flags.has("-f") || seg.flags.has("-d")) {
        return {
          decision: "deny",
          reason: "git push -f/-d is destructive",
        };
      }

      // Push to main/master (positional after "origin")
      const remote = seg.positionals[1]; // e.g. "origin"
      const branch = seg.positionals[2]; // e.g. "main"
      if (branch === "main" || branch === "master") {
        return {
          decision: "deny",
          reason: `git push to ${branch} is not allowed`,
        };
      }
      // Also catch: git push origin main (remote=origin, branch=main)
      if (remote === "main" || remote === "master") {
        return {
          decision: "deny",
          reason: `git push to ${remote} is not allowed`,
        };
      }
    }

    if (sub === "remote") {
      const action = seg.positionals[1];
      if (action === "add" || action === "set-url") {
        return {
          decision: "deny",
          reason: `git remote ${action} can redirect push destinations`,
        };
      }
    }

    if (sub === "config") {
      // git config remote.* ...
      if (seg.positionals.some((p) => p.startsWith("remote."))) {
        return {
          decision: "deny",
          reason: "git config remote.* can redirect push destinations",
        };
      }
    }

    if (sub === "tag") {
      return { decision: "deny", reason: "git tag can create/modify tags" };
    }
  }

  // 7. GH destructive
  if (prog === "gh") {
    if (matchesGhPattern(seg, "gist")) {
      return { decision: "deny", reason: "gh gist can exfiltrate data" };
    }
    if (matchesGhPattern(seg, "repo", "create")) {
      return {
        decision: "deny",
        reason: "gh repo create creates repositories",
      };
    }
    if (matchesGhPattern(seg, "repo", "delete")) {
      return {
        decision: "deny",
        reason: "gh repo delete destroys repositories",
      };
    }
    if (matchesGhPattern(seg, "auth")) {
      return { decision: "deny", reason: "gh auth can expose credentials" };
    }
    if (matchesGhPattern(seg, "repo", "sync") && seg.flags.has("--force")) {
      return {
        decision: "deny",
        reason: "gh repo sync --force can overwrite history",
      };
    }
  }

  // 8. Bun destructive
  if (prog === "bun") {
    const sub = seg.positionals[0];
    if (sub === "publish" || sub === "upgrade" || sub === "feedback") {
      return {
        decision: "deny",
        reason: `bun ${sub} is not allowed`,
      };
    }
  }

  // 9. tmux injection
  if (prog === "tmux") {
    const sub = seg.positionals[0];
    if (
      sub === "send-keys" ||
      sub === "send-prefix" ||
      sub === "capture-pane" ||
      sub === "pipe-pane"
    ) {
      return {
        decision: "deny",
        reason: `tmux ${sub} can inject commands into other sessions`,
      };
    }
  }

  // 10. fly destructive
  if (prog === "fly") {
    const sub = seg.positionals[0];
    if (
      sub === "auth" ||
      sub === "tokens" ||
      sub === "token" ||
      sub === "ssh" ||
      sub === "proxy" ||
      sub === "sftp" ||
      sub === "console"
    ) {
      return {
        decision: "deny",
        reason: `fly ${sub} is not allowed`,
      };
    }
  }

  return null;
}

// ─── Escalation rules ────────────────────────────────────────────────────────

function escalateCheck(seg: ParsedSegment): RuleResult | null {
  const prog = normalizeProgram(seg.program);

  // Package managers — bun
  if (prog === "bun") {
    const sub = seg.positionals[0];
    if (
      sub === "add" ||
      sub === "install" ||
      sub === "create" ||
      sub === "update" ||
      sub === "x"
    ) {
      return {
        decision: "escalate",
        reason: `bun ${sub} installs/executes packages`,
      };
    }
  }

  if (prog === "bunx") {
    return { decision: "escalate", reason: "bunx executes packages" };
  }

  // npm
  if (prog === "npm") {
    const sub = seg.positionals[0];
    if (
      sub === "install" ||
      sub === "ci" ||
      sub === "exec" ||
      sub === "config" ||
      sub === "publish" ||
      sub === "whoami" ||
      sub === "token"
    ) {
      return { decision: "escalate", reason: `npm ${sub} requires review` };
    }
  }

  if (prog === "npx") {
    return { decision: "escalate", reason: "npx executes packages" };
  }

  // apt-get / apt
  if (prog === "apt-get" || prog === "apt") {
    return { decision: "escalate", reason: `${prog} installs system packages` };
  }

  // pip / pip3 / pipx
  if (prog === "pip" || prog === "pip3") {
    const sub = seg.positionals[0];
    if (sub === "install") {
      return { decision: "escalate", reason: "pip install installs packages" };
    }
  }

  if (prog === "pipx") {
    return { decision: "escalate", reason: "pipx installs/executes packages" };
  }

  // Network tools
  if (prog === "curl" || prog === "wget") {
    return { decision: "escalate", reason: `${prog} makes network requests` };
  }

  // GH mutations
  if (prog === "gh") {
    if (matchesGhPattern(seg, "api")) {
      return { decision: "escalate", reason: "gh api makes mutations" };
    }
    if (matchesGhPattern(seg, "issue", "create")) {
      return { decision: "escalate", reason: "gh issue create is a mutation" };
    }
    if (matchesGhPattern(seg, "pr", "create")) {
      return { decision: "escalate", reason: "gh pr create is a mutation" };
    }
    if (matchesGhPattern(seg, "pr", "merge")) {
      return { decision: "escalate", reason: "gh pr merge is a mutation" };
    }
    // gh repo sync without --force (with --force it was already denied above)
    if (matchesGhPattern(seg, "repo", "sync")) {
      return { decision: "escalate", reason: "gh repo sync modifies branches" };
    }
  }

  // Fly mutations
  if (prog === "fly") {
    const sub = seg.positionals[0];
    if (sub === "deploy" || sub === "secrets") {
      return {
        decision: "escalate",
        reason: `fly ${sub} modifies production resources`,
      };
    }
  }

  // awk ENVIRON — env variable access
  if (prog === "awk") {
    if (seg.args.some((a) => a.includes("ENVIRON"))) {
      return {
        decision: "escalate",
        reason:
          "awk ENVIRON can access environment variables including secrets",
      };
    }
  }

  return null;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function evaluateRules(seg: ParsedSegment): RuleResult {
  const deny = denyCheck(seg);
  if (deny) return deny;

  const escalate = escalateCheck(seg);
  if (escalate) return escalate;

  return { decision: "continue", reason: "no rules matched" };
}
