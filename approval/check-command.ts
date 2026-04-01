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

  // Tier 2: Hot-word scan (normalize whitespace to prevent bypass via extra spaces/tabs/newlines)
  const normalized = command.replace(/\s+/g, " ").trim();
  const matchedHotWord = rules.hotWords.find((hw) => normalized.includes(hw));
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

// --- Contextual GitHub command helpers (exported for testing) ---

export interface RepoTarget {
  owner: string;
  repo: string;
}

const SAFE_NAME_RE = /^[a-zA-Z0-9._-]+$/;

const GH_API_RE = /^gh\s+api\s+/;

/**
 * Extract the target owner/repo from a `gh api repos/<owner>/<repo>/...` command.
 * Returns null if:
 *   - the command is not a `gh api` call
 *   - the API path doesn't start with [/]repos/<owner>/<repo>
 *   - the path contains traversal (..), encoding (%), or double slashes (//)
 *   - owner or repo contain characters outside [a-zA-Z0-9._-]
 */
// Flags for `gh api` that consume the next token as a value.
// Their values must be skipped when scanning for the API path positional arg.
const GH_API_VALUE_FLAGS =
  /^(-X|--method|-H|--header|-F|-f|--field|--raw-field|--input|--template|--jq|-q|-p|--preview|--hostname|--cache)$/;

export function parseGhApiTarget(command: string): RepoTarget | null {
  if (!GH_API_RE.test(command)) return null;

  // Extract tokens after "gh api" and find the API path positional arg.
  // Skip flags and their consumed values to avoid false matches on
  // flag values like `--input repos/OWNER/REPO/file`.
  const afterGhApi = command.replace(GH_API_RE, "").trim();
  const tokens = afterGhApi.split(/\s+/);

  let pathToken: string | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (GH_API_VALUE_FLAGS.test(t)) {
      i++; // skip the next token (flag's value)
      continue;
    }
    // Skip --flag=value forms and boolean flags
    if (t.startsWith("-")) continue;
    // First positional arg — check if it's a repos/ path
    if (/^\/?repos\//.test(t)) {
      pathToken = t;
    }
    break; // first positional arg found (whether it matches or not)
  }
  if (!pathToken) return null;

  // Validate: no traversal, encoding, or double slashes
  if (
    pathToken.includes("..") ||
    pathToken.includes("%") ||
    pathToken.includes("//")
  ) {
    return null;
  }

  // Match repos/<owner>/<repo> with optional leading slash
  const match = pathToken.match(/^\/?repos\/([^/]+)\/([^/]+)/);
  if (!match) return null;

  const [, owner, repo] = match;

  // Validate owner and repo are safe names
  if (!SAFE_NAME_RE.test(owner) || !SAFE_NAME_RE.test(repo)) return null;

  return { owner, repo };
}

const GH_CMD_RE = /^gh\s+(?!api\b)/;

/**
 * Extract the target owner/repo from a `gh` command's --repo or -R flag.
 * Only applies to non-api gh commands (gh pr, gh issue, etc.).
 * Returns null if:
 *   - the command is not a non-api gh command
 *   - no --repo or -R flag is found
 *   - the value doesn't contain owner/repo format
 *   - owner or repo contain characters outside [a-zA-Z0-9._-]
 */
export function parseGhRepoFlag(command: string): RepoTarget | null {
  if (!GH_CMD_RE.test(command)) return null;

  // Match --repo owner/repo or --repo=owner/repo
  const repoFlagMatch = command.match(
    /(?:(?:^|\s)--repo(?:=|\s+)|(?:^|\s)-R\s+)([^\s]+)/,
  );
  if (!repoFlagMatch) return null;

  const value = repoFlagMatch[1];
  const slashIdx = value.indexOf("/");
  if (slashIdx === -1) return null;

  const owner = value.slice(0, slashIdx);
  const repo = value.slice(slashIdx + 1);

  if (!owner || !repo) return null;
  if (!SAFE_NAME_RE.test(owner) || !SAFE_NAME_RE.test(repo)) return null;

  return { owner, repo };
}

const GH_REPO_SYNC_RE = /^gh\s+repo\s+sync\b/;
const GH_REPO_SYNC_VALUE_FLAGS = /^(--source|--branch|-b)$/;

export interface GhRepoSyncResult {
  target: RepoTarget | null;
  source: RepoTarget | null;
}

export function parseGhRepoSyncTarget(
  command: string,
): GhRepoSyncResult | null {
  if (!GH_REPO_SYNC_RE.test(command)) return null;

  const afterSync = command.replace(/^gh\s+repo\s+sync\b/, "").trim();
  if (!afterSync) return { target: null, source: null };
  const tokens = afterSync.split(/\s+/);

  let target: RepoTarget | null = null;
  let source: RepoTarget | null = null;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];

    // Handle --source=<value> equals form
    if (t.startsWith("--source=")) {
      const value = t.slice("--source=".length);
      if (value) {
        const slashIdx = value.indexOf("/");
        if (slashIdx !== -1) {
          const owner = value.slice(0, slashIdx);
          const repo = value.slice(slashIdx + 1);
          if (
            owner &&
            repo &&
            SAFE_NAME_RE.test(owner) &&
            SAFE_NAME_RE.test(repo)
          ) {
            source = { owner, repo };
          }
        }
      }
      continue;
    }

    // Handle --branch=<value> and -b=<value> equals forms — skip them
    if (t.startsWith("--branch=") || t.startsWith("-b=")) {
      continue;
    }

    if (GH_REPO_SYNC_VALUE_FLAGS.test(t)) {
      const value = tokens[++i];
      if (t === "--source" && value) {
        const slashIdx = value.indexOf("/");
        if (slashIdx !== -1) {
          const owner = value.slice(0, slashIdx);
          const repo = value.slice(slashIdx + 1);
          if (
            owner &&
            repo &&
            SAFE_NAME_RE.test(owner) &&
            SAFE_NAME_RE.test(repo)
          ) {
            source = { owner, repo };
          }
        }
      }
      continue;
    }
    if (t.startsWith("-")) continue;
    if (!target) {
      const slashIdx = t.indexOf("/");
      if (slashIdx !== -1) {
        const owner = t.slice(0, slashIdx);
        const repo = t.slice(slashIdx + 1);
        if (
          owner &&
          repo &&
          SAFE_NAME_RE.test(owner) &&
          SAFE_NAME_RE.test(repo)
        ) {
          target = { owner, repo };
        }
      }
    }
  }

  return { target, source };
}

const METHOD_RE = /(?:-X\s*|--method[\s=])([A-Za-z]+)/gi;
const ALLOWED_METHODS = new Set(["GET", "POST", "PATCH"]);

/**
 * Check if a gh command uses a non-allowed HTTP method.
 * Allowlist: GET, POST, PATCH. No explicit method flag → treated as GET (allowed).
 * Any other explicit method (DELETE, PUT, OPTIONS, HEAD, TRACE, etc.) → blocked.
 * Checks ALL method flags in the command — if any is outside the allowlist, blocked.
 * Case-insensitive. Handles -X, -XDELETE, --method, and --method=DELETE forms.
 */
export function hasBlockedMethod(command: string): boolean {
  const matches = [...command.matchAll(METHOD_RE)];
  if (matches.length === 0) return false; // no explicit method → GET (allowed)
  return matches.some((m) => !ALLOWED_METHODS.has(m[1].toUpperCase()));
}

const COMPOUND_OPERATORS_RE = /[;&|`\n$()]/;

/**
 * Check if a command contains compound operators or shell metacharacters.
 * Commands with these are never contextually exempted — they fall through
 * to normal tier evaluation (Haiku).
 */
export function hasCompoundOperators(command: string): boolean {
  return COMPOUND_OPERATORS_RE.test(command);
}

/**
 * Extract owner/repo from a GitHub remote URL.
 * Supports HTTPS and SSH formats. Strips .git suffix.
 * Returns null for non-GitHub URLs.
 */
export function extractGitHubRepo(url: string): RepoTarget | null {
  // HTTPS: https://github.com/<owner>/<repo>[.git]
  const httpsMatch = url.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/\s]+?)(?:\.git)?\s*$/,
  );
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };

  // SSH (scp-like): git@github.com:<owner>/<repo>[.git]
  const sshMatch = url.match(
    /^git@github\.com:([^/]+)\/([^/\s]+?)(?:\.git)?\s*$/,
  );
  if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };

  // SSH (URL): ssh://git@github.com/<owner>/<repo>[.git]
  const sshUrlMatch = url.match(
    /^ssh:\/\/git@github\.com\/([^/]+)\/([^/\s]+?)(?:\.git)?\s*$/,
  );
  if (sshUrlMatch) return { owner: sshUrlMatch[1], repo: sshUrlMatch[2] };

  return null;
}

const MAX_REMOTES = 5;

/**
 * Path to the boot-time snapshot of git remote URLs.
 * Created by entrypoint.sh (as root) in a root-owned directory before claude
 * starts. Reading from this snapshot instead of live git state eliminates
 * runtime remote injection via .git/config edits, ~/.gitconfig, GIT_CONFIG_*
 * env vars, or include directives.
 */
export const REMOTE_URLS_PATH = "/tmp/approval/git-remote-urls.txt";

/**
 * Get owner/repo for all git remotes from the boot-time snapshot.
 * Returns empty array on any error or if more than MAX_REMOTES URLs exist.
 */
export async function getRelatedRepos(): Promise<RepoTarget[]> {
  try {
    const file = Bun.file(REMOTE_URLS_PATH);
    const content = await file.text();
    const urls = content.trim().split("\n").filter(Boolean);

    if (urls.length === 0 || urls.length > MAX_REMOTES) return [];

    const repos: RepoTarget[] = [];
    for (const url of urls) {
      const repo = extractGitHubRepo(url.trim());
      if (repo) repos.push(repo);
    }
    return repos;
  } catch {
    return [];
  }
}

// NOTE: These hot words must also be present in rules.conf (Tier 2) to trigger
// Tier 2 escalation in the first place. If a hot word is removed from rules.conf
// but kept here (or vice versa), the contextual exemption gate will be silently
// bypassed or this set will have dead entries. Keep both in sync.
export const ALWAYS_ESCALATE_HOT_WORDS = new Set([
  "gh pr merge",
  "gh pr close",
  "gh issue close",
]);

/**
 * Check if a gh command targets a repo associated with configured git remotes.
 * Returns true if the command should be exempted from Haiku classification.
 *
 * Fail-safe: returns false on any error (missing git config, unparseable
 * command, no matching remote, blocked method, compound operators).
 */
export async function isContextualGhCommand(command: string): Promise<boolean> {
  // Normalize leading whitespace — Tier 2 trims before hot word matching
  // but the raw command string is passed here, so parsers with ^-anchored
  // regexes would miss commands with leading spaces.
  const cmd = command.trimStart();

  // Reject compound commands — they must go through Haiku
  if (hasCompoundOperators(cmd)) return false;

  // Reject disallowed HTTP methods (anything outside GET/POST/PATCH allowlist).
  // Only applies to gh api — other subcommands don't use -X/--method flags.
  if (/^gh\s+api\b/.test(cmd) && hasBlockedMethod(cmd)) return false;

  // Parse target repo from the command (including gh repo sync)
  const syncResult = parseGhRepoSyncTarget(cmd);
  const target =
    parseGhApiTarget(cmd) ?? parseGhRepoFlag(cmd) ?? syncResult?.target ?? null;
  if (!target) return false;

  // Resolve related repos from git remotes
  const relatedRepos = await getRelatedRepos();
  if (relatedRepos.length === 0) return false;

  const isRelated = (repo: RepoTarget) =>
    relatedRepos.some(
      (r) =>
        r.owner.toLowerCase() === repo.owner.toLowerCase() &&
        r.repo.toLowerCase() === repo.repo.toLowerCase(),
    );

  // Check if target matches any related repo (case-insensitive)
  if (!isRelated(target)) return false;

  // For gh repo sync, require --source and validate it is related.
  // Bare `gh repo sync` (no --source) lets GitHub infer the source,
  // which we can't validate against the snapshot — send to Haiku.
  if (syncResult) {
    if (!syncResult.source) return false;
    if (!isRelated(syncResult.source)) return false;
  }

  return true;
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
          // Pre-Haiku: check if this is a contextual gh command.
          // Only apply when the hot word is gh-related — credential hot words
          // (GH_PAT, CLAUDE_CODE_OAUTH_TOKEN, etc.) must always reach Haiku.
          if (
            tierResult.hotWord.startsWith("gh ") &&
            !ALWAYS_ESCALATE_HOT_WORDS.has(tierResult.hotWord) &&
            (await isContextualGhCommand(command))
          ) {
            console.error(`[HOOK] ALLOW (contextual gh command): ${command}`);
            outputDecision("allow");
            process.exit(0);
          }
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
