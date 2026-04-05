import type { ParsedSegment } from "./tokenize";
import type { RepoTarget } from "./github-utils";
import { extractGitHubRepo, getRelatedRepos } from "./github-utils";

export type { RepoTarget } from "./github-utils";

const VALID_OWNER_REPO = /^[a-zA-Z0-9._-]+$/;

export function extractRepoTarget(
  segment: ParsedSegment,
): RepoTarget | "implicit" | null {
  const { positionals, flags, args } = segment;
  const sub1 = positionals[0];

  // gh api repos/owner/repo/...
  // Only check the first positional after "api" (the endpoint path).
  // Other positionals may be flag values and should not be treated as targets.
  if (sub1 === "api") {
    const endpoint = positionals[1];
    if (!endpoint) return null;

    // Pre-validate the path before regex matching
    if (endpoint.includes("..")) return null;
    if (endpoint.includes("%")) return null;
    if (endpoint.includes("//")) return null;

    const match = endpoint.match(/^\/?(repos\/([^/]+)\/([^/]+))/);
    if (match) {
      const owner = match[2];
      const repo = match[3];

      if (!VALID_OWNER_REPO.test(owner)) return null;
      if (!VALID_OWNER_REPO.test(repo)) return null;

      return { owner, repo };
    }
    // Endpoint is not a repos/ path — cannot validate
    return null;
  }

  // --repo=value or -R=value (from flags map)
  const repoFlag = flags.get("--repo") ?? flags.get("-R");
  if (typeof repoFlag === "string") {
    const parts = repoFlag.split("/");
    if (parts.length === 2 && parts[0] && parts[1]) {
      return { owner: parts[0], repo: parts[1] };
    }
    return null;
  }

  // -R value (next arg) — short flags are expanded, so -R is in flags as true
  // but the value is the next arg after -R in the args array
  const rIdx = args.indexOf("-R");
  if (rIdx >= 0 && rIdx + 1 < args.length) {
    const val = args[rIdx + 1];
    if (!val.startsWith("-")) {
      const parts = val.split("/");
      if (parts.length === 2 && parts[0] && parts[1]) {
        return { owner: parts[0], repo: parts[1] };
      }
    }
  }

  // --repo value (next arg)
  const repoIdx = args.indexOf("--repo");
  if (repoIdx >= 0 && repoIdx + 1 < args.length) {
    const val = args[repoIdx + 1];
    if (!val.startsWith("-")) {
      const parts = val.split("/");
      if (parts.length === 2 && parts[0] && parts[1]) {
        return { owner: parts[0], repo: parts[1] };
      }
    }
  }

  // No explicit target → implicit
  return "implicit";
}

export function isRelatedRepo(
  target: RepoTarget,
  snapshot: RepoTarget[],
): boolean {
  const tOwner = target.owner.toLowerCase();
  const tRepo = target.repo.toLowerCase();
  return snapshot.some(
    (r) => r.owner.toLowerCase() === tOwner && r.repo.toLowerCase() === tRepo,
  );
}

export function isDeleteMethod(segment: ParsedSegment): boolean {
  const { args, flags } = segment;

  // --method=DELETE
  if (flags.get("--method") === "DELETE") return true;

  // --method DELETE (next arg)
  const methodIdx = args.indexOf("--method");
  if (methodIdx >= 0 && args[methodIdx + 1] === "DELETE") return true;

  // -X DELETE (next arg)
  const xIdx = args.indexOf("-X");
  if (xIdx >= 0 && args[xIdx + 1] === "DELETE") return true;

  // -XDELETE (combined form — single token)
  if (args.some((a) => a === "-XDELETE")) return true;

  return false;
}

export async function checkGhExemption(
  segment: ParsedSegment,
): Promise<"allow" | "escalate" | "deny"> {
  // DELETE method always escalates
  if (segment.positionals[0] === "api" && isDeleteMethod(segment)) {
    return "escalate";
  }

  // gh repo sync: both target and --source must be related
  if (segment.positionals[0] === "repo" && segment.positionals[1] === "sync") {
    return checkGhRepoSync(segment);
  }

  const snapshot = getRelatedRepos();
  if (!snapshot) return "deny";

  const target = extractRepoTarget(segment);

  if (target === null) return "escalate";
  if (target === "implicit") {
    return resolveImplicitRepo(snapshot);
  }

  return isRelatedRepo(target, snapshot) ? "allow" : "escalate";
}

async function checkGhRepoSync(
  segment: ParsedSegment,
): Promise<"allow" | "escalate" | "deny"> {
  const snapshot = getRelatedRepos();
  if (!snapshot) return "deny";

  const target = segment.positionals[2];
  if (!target) return "escalate";

  const source =
    segment.flags.get("--source") ??
    (() => {
      const idx = segment.args.indexOf("--source");
      return idx >= 0 ? segment.args[idx + 1] : undefined;
    })();

  if (!source || typeof source !== "string") return "escalate";

  const targetParts = target.split("/");
  const sourceParts = source.split("/");

  if (targetParts.length !== 2 || sourceParts.length !== 2) return "escalate";

  const targetRepo = { owner: targetParts[0], repo: targetParts[1] };
  const sourceRepo = { owner: sourceParts[0], repo: sourceParts[1] };

  return isRelatedRepo(targetRepo, snapshot) &&
    isRelatedRepo(sourceRepo, snapshot)
    ? "allow"
    : "escalate";
}

async function resolveImplicitRepo(
  snapshot: RepoTarget[],
): Promise<"allow" | "escalate"> {
  try {
    const proc = Bun.spawn(["git", "remote", "get-url", "origin"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return "escalate";

    const url = output.trim();
    const repo = extractGitHubRepo(url);
    if (!repo) return "escalate";

    return isRelatedRepo(repo, snapshot) ? "allow" : "escalate";
  } catch {
    return "escalate";
  }
}
