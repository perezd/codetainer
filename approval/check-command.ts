import { readFileSync } from "fs";
import { parseRules, type Rules } from "./rules";
import { classifyWithHaiku } from "./classifier";
import { outputDecision } from "./hook-output";

// --- Exported for testing ---

export type TierResult =
  | { decision: "allow" }
  | { decision: "deny"; reason: string; rule: string }
  | { decision: "escalate"; hotWord: string };

export function evaluateTiers(command: string, rules: Rules): TierResult {
  // Tier 1: Hard-block
  for (const rule of rules.blocks) {
    if (rule.pattern.test(command)) {
      return { decision: "deny", reason: command, rule: rule.raw };
    }
  }

  // Tier 2: Hot-word scan
  const matchedHotWord = rules.hotWords.find((hw) => command.includes(hw));
  if (matchedHotWord) {
    return { decision: "escalate", hotWord: matchedHotWord };
  }

  return { decision: "allow" };
}

// --- Ownership exemption helpers (exported for testing) ---

const GIT_PUSH_RE = /^git\s+push\b/;

// Flags that consume the next token as a value (e.g., -o <value>, --repo <value>).
// If present, we can't reliably parse the remote name, so we refuse the exemption.
const VALUE_CONSUMING_FLAGS =
  /^(-o|--push-option|--repo|--receive-pack|--exec|--signed)$/;

/**
 * Parse the target remote name from a git push command string.
 * Skips flags (tokens starting with -). Returns the first positional
 * argument after "git push".
 * Returns null if:
 *   - the command is not a git push
 *   - no explicit remote is specified (bare "git push" — can't assume origin
 *     because git config like remote.pushDefault may override it)
 *   - value-consuming flags are present (e.g., -o <value>) which make
 *     positional parsing unreliable
 */
export function parseRemoteFromPushCommand(command: string): string | null {
  if (!GIT_PUSH_RE.test(command)) return null;

  // Tokenize everything after "git push"
  const afterPush = command.replace(GIT_PUSH_RE, "").trim();
  if (!afterPush) return null;

  const tokens = afterPush.split(/\s+/);

  // Bail if any value-consuming flags are present — positional parsing is unreliable
  for (const token of tokens) {
    if (VALUE_CONSUMING_FLAGS.test(token)) return null;
    // Also catch --option=value forms of value-consuming flags
    const eqFlag = token.split("=")[0];
    if (VALUE_CONSUMING_FLAGS.test(eqFlag)) return null;
  }

  const firstPositional = tokens.find((t) => !t.startsWith("-"));
  return firstPositional ?? null;
}

/**
 * Extract the GitHub owner from a remote URL.
 * Supports:
 *   https://github.com/<owner>/<repo>
 *   git@github.com:<owner>/<repo>
 * Returns null for non-GitHub URLs.
 */
export function extractGitHubOwner(url: string): string | null {
  // HTTPS format
  const httpsMatch = url.match(/^https:\/\/github\.com\/([^/]+)\//);
  if (httpsMatch) return httpsMatch[1];

  // SSH format
  const sshMatch = url.match(/^git@github\.com:([^/]+)\//);
  if (sshMatch) return sshMatch[1];

  return null;
}

const HAS_DELETE_FLAG = /\s--delete\b|\s-[a-zA-Z]*d/;

/**
 * Check if a git push command targets a remote owned by GIT_USER_NAME.
 * Returns true if the push should be exempted from block rules.
 *
 * Fail-safe: returns false on any error (missing git config, git failure,
 * unparseable URL, non-GitHub host, --delete flag present).
 */
export async function isOwnedRemotePush(command: string): Promise<boolean> {
  const remote = parseRemoteFromPushCommand(command);
  if (remote === null) return false;

  // --delete pushes are never exempted, even to owned remotes
  if (HAS_DELETE_FLAG.test(command)) return false;

  try {
    // Read identity from git config (set during entrypoint from GIT_USER_NAME).
    // We don't use process.env.GIT_USER_NAME because the env var may not be
    // available to the approval process at runtime.
    const configProc = Bun.spawn(["git", "config", "user.name"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const [configStdout, , configExitCode] = await Promise.all([
      new Response(configProc.stdout).text(),
      new Response(configProc.stderr).text(),
      configProc.exited,
    ]);

    if (configExitCode !== 0) return false;

    const gitUserName = configStdout.trim();
    if (!gitUserName) return false;

    // SECURITY: --push returns the URL git actually uses for push operations.
    // If pushurl is configured, --push returns pushurl (not url).
    // This ensures we check ownership against the same URL git will push to,
    // preventing attacks where url and pushurl are set to different owners.
    const proc = Bun.spawn(["git", "remote", "get-url", "--push", remote], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, , exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0) return false;

    const owner = extractGitHubOwner(stdout.trim());
    if (!owner) return false;

    return owner.toLowerCase() === gitUserName.toLowerCase();
  } catch {
    return false;
  }
}

// --- Main entry point (only runs when executed directly) ---

const isMainModule = import.meta.main === true;

if (isMainModule) {
  (async () => {
    try {
      const RULES_FILE = process.env.RULES_FILE ?? "/opt/approval/rules.conf";

      // Read hook input from stdin
      const input = JSON.parse(await Bun.stdin.text());
      if (input.tool_name !== "Bash") process.exit(0);
      const command: string = input.tool_input?.command ?? "";
      if (!command) process.exit(0);

      console.error(`[HOOK] Evaluating: ${command}`);

      // Pre-tier: check if this is a git push to an owned remote
      if (await isOwnedRemotePush(command)) {
        console.error(`[HOOK] ALLOW (owned remote): ${command}`);
        outputDecision("allow");
        process.exit(0);
      }

      const rules = parseRules(readFileSync(RULES_FILE, "utf-8"));
      const tierResult = evaluateTiers(command, rules);

      switch (tierResult.decision) {
        case "deny":
          console.error(
            `[HOOK] BLOCK (${tierResult.rule}): ${tierResult.reason}`,
          );
          outputDecision(
            "deny",
            `Blocked: ${command}. Do NOT attempt to work around this.`,
          );
          process.exit(0);

        case "allow":
          console.error(`[HOOK] ALLOW (no hot words): ${command}`);
          outputDecision("allow");
          process.exit(0);

        case "escalate":
          console.error(
            `[HOOK] Hot word "${tierResult.hotWord}" -> escalating to Haiku`,
          );
          break; // fall through to Tier 3
      }

      // Tier 3: Haiku classification
      const verdict = await classifyWithHaiku(command);
      console.error(`[HOOK] Haiku verdict: ${JSON.stringify(verdict)}`);

      switch (verdict.verdict) {
        case "allow":
          console.error(`[HOOK] HAIKU ALLOW: ${verdict.reason}`);
          outputDecision("allow");
          break;
        case "block":
          console.error(`[HOOK] HAIKU BLOCK: ${verdict.reason}`);
          outputDecision(
            "deny",
            `${verdict.reason}. Do NOT attempt to work around this.`,
          );
          break;
        case "approve":
          console.error(`[HOOK] HAIKU ASK: ${verdict.reason}`);
          outputDecision("ask", verdict.reason);
          break;
      }
    } catch (err) {
      // Fail closed: any unhandled error → deny
      console.error(`[HOOK] FATAL ERROR: ${err}`);
      outputDecision(
        "deny",
        "Command approval system error. Please contact the operator.",
      );
    }

    process.exit(0);
  })();
}
