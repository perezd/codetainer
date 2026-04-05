// @ts-expect-error — vendored JS module, no type declarations
import { parse } from "./vendor/shell-quote/index.js";

export type ShellToken = string | { op: string };

export interface ParsedSegment {
  program: string;
  args: string[];
  flags: Map<string, string | true>;
  positionals: string[];
  isPipeTarget: boolean;
  hasOperatorTokens: boolean;
  hasBackticks: boolean;
  hasEmbeddedSubstitution: boolean;
  redirections: Array<{ op: string; target: string }>;
}

export interface RawSegment {
  tokens: ShellToken[];
  isPipeTarget: boolean;
}

const COMPOUND_OPS = new Set(["&&", "||", ";"]);
const REDIRECTION_OPS = new Set([">", ">>", ">&", "<", "<<", "<&"]);
const SUBSHELL_OPS = new Set(["(", ")", "<(", ">(", "$(", "`"]);
const ENV_ASSIGNMENT = /^[a-zA-Z_][a-zA-Z0-9_]*=/;

/**
 * Preserve environment variable references as literal strings.
 * Without this, shell-quote replaces $VAR with "" when no env is provided,
 * which can make programs disappear and bypass deny rules.
 */
function preserveEnvReference(key: string): string {
  return `$${key}`;
}

export function tokenize(line: string): ShellToken[] {
  return parse(line, preserveEnvReference) as ShellToken[];
}

export function splitSegments(tokens: ShellToken[]): RawSegment[] {
  const segments: RawSegment[] = [];
  let current: ShellToken[] = [];
  let nextIsPipeTarget = false;

  for (const token of tokens) {
    if (typeof token === "object" && token.op) {
      if (COMPOUND_OPS.has(token.op) || token.op === "&") {
        if (current.length > 0) {
          segments.push({ tokens: current, isPipeTarget: nextIsPipeTarget });
          current = [];
          nextIsPipeTarget = false;
        }
      } else if (token.op === "|" || token.op === "|&") {
        if (current.length > 0) {
          segments.push({ tokens: current, isPipeTarget: nextIsPipeTarget });
          current = [];
          nextIsPipeTarget = true;
        }
      } else {
        current.push(token);
      }
    } else {
      current.push(token);
    }
  }

  if (current.length > 0) {
    segments.push({ tokens: current, isPipeTarget: nextIsPipeTarget });
  }

  return segments;
}

export function parseSegment(
  tokens: ShellToken[],
  isPipeTarget: boolean,
): ParsedSegment {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  const redirections: Array<{ op: string; target: string }> = [];
  let program = "";
  const args: string[] = [];
  let hasOperatorTokens = false;
  let hasBackticks = false;
  let hasEmbeddedSubstitution = false;

  let i = 0;

  while (i < tokens.length) {
    const token = tokens[i];
    if (typeof token === "string") {
      // Skip leading NAME=VALUE environment assignments
      if (ENV_ASSIGNMENT.test(token)) {
        args.push(token);
        i++;
        continue;
      }
      const lastSlash = token.lastIndexOf("/");
      program = lastSlash >= 0 ? token.slice(lastSlash + 1) : token;
      i++;
      break;
    } else if (SUBSHELL_OPS.has(token.op)) {
      hasOperatorTokens = true;
    }
    i++;
  }

  while (i < tokens.length) {
    const token = tokens[i];

    if (typeof token === "object" && token.op) {
      if (SUBSHELL_OPS.has(token.op)) {
        hasOperatorTokens = true;
      } else if (REDIRECTION_OPS.has(token.op)) {
        const nextToken = tokens[i + 1];
        if (typeof nextToken === "string") {
          redirections.push({ op: token.op, target: nextToken });
          i += 2;
          continue;
        }
      }
      i++;
      continue;
    }

    const str = token as string;
    args.push(str);

    if (str.includes("`")) {
      hasBackticks = true;
    }

    if (str.includes("$(")) {
      hasEmbeddedSubstitution = true;
    }

    if (str.startsWith("--")) {
      const eqIdx = str.indexOf("=");
      if (eqIdx > 0) {
        flags.set(str.slice(0, eqIdx), str.slice(eqIdx + 1));
      } else {
        flags.set(str, true);
      }
    } else if (str.startsWith("-") && str.length > 1) {
      const flagBody = str.slice(1);
      if (flagBody.length === 1) {
        flags.set(str, true);
      } else {
        for (const ch of flagBody) {
          flags.set(`-${ch}`, true);
        }
      }
    } else {
      positionals.push(str);
    }

    i++;
  }

  return {
    program,
    args,
    flags,
    positionals,
    isPipeTarget,
    hasOperatorTokens,
    hasBackticks,
    hasEmbeddedSubstitution,
    redirections,
  };
}
