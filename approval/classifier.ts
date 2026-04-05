import { existsSync, statSync, openSync, readSync, closeSync } from "fs";
import SYSTEM_PROMPT from "./system-prompt.txt" with { type: "text" };

export type Verdict =
  | { verdict: "allow"; reason: string }
  | { verdict: "block"; reason: string }
  | { verdict: "approve"; reason: string }
  | { verdict: "need_files"; files: string[]; reason: string };

const VALID_VERDICTS = new Set(["allow", "block", "approve", "need_files"]);
const BLOCKED_FILE_PATTERNS = [".ghtoken", ".npmrc", "hosts.yml", "/tmp/otel/"];
const MAX_FILE_SIZE = 8192; // 8KB
const MAX_FILES = 3;

/**
 * Parse a verdict JSON string from Haiku's response.
 * Extracts JSON from surrounding text if needed.
 */
export function parseVerdict(text: string): Verdict {
  try {
    const trimmed = text.trim();
    let parsed: Record<string, unknown>;

    // Try direct parse first (clean JSON response)
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Extract JSON with brace balancing for responses with surrounding text
      const start = trimmed.indexOf("{");
      if (start === -1)
        return { verdict: "block", reason: "no JSON in response" };

      let depth = 0;
      let end = -1;
      for (let i = start; i < trimmed.length; i++) {
        if (trimmed[i] === "{") depth++;
        else if (trimmed[i] === "}") {
          depth--;
          if (depth === 0) {
            end = i + 1;
            break;
          }
        }
      }
      if (end === -1)
        return { verdict: "block", reason: "no JSON in response" };

      parsed = JSON.parse(trimmed.slice(start, end));
    }

    if (!VALID_VERDICTS.has(parsed.verdict as string)) {
      return { verdict: "block", reason: `unknown verdict: ${parsed.verdict}` };
    }

    if (parsed.verdict === "need_files") {
      if (!Array.isArray(parsed.files)) {
        return { verdict: "block", reason: "need_files without files array" };
      }
      // Validate entries are strings and enforce MAX_FILES
      const validFiles = parsed.files
        .filter((f: unknown): f is string => typeof f === "string")
        .slice(0, MAX_FILES);
      if (validFiles.length === 0) {
        return { verdict: "block", reason: "need_files with no valid paths" };
      }
      return {
        verdict: "need_files",
        files: validFiles,
        reason: (parsed.reason as string) || "",
      };
    }

    return {
      verdict: parsed.verdict as "allow" | "block" | "approve",
      reason: (parsed.reason as string) || "",
    };
  } catch {
    return { verdict: "block", reason: "failed to parse verdict" };
  }
}

/**
 * Validate a file path requested by Haiku for inspection.
 */
export function validateFilePath(path: string): boolean {
  if (path.includes("..")) return false;
  if (!path.startsWith("/tmp/") && !path.startsWith("/workspace/")) {
    return false;
  }
  for (const pattern of BLOCKED_FILE_PATTERNS) {
    if (path.includes(pattern)) return false;
  }
  return true;
}

/**
 * Read a file for Haiku inspection with safety checks.
 */
function readFileForInspection(path: string): string {
  if (!validateFilePath(path)) return "<access denied>";
  if (!existsSync(path)) return "<file not found>";

  try {
    // Check file size before reading to avoid unnecessary memory use
    const stat = statSync(path);
    if (!stat.isFile()) return "<not a regular file>";
    const fileSize = stat.size;

    if (fileSize === 0) return "";

    // Read only what we need
    const readSize = Math.min(fileSize, MAX_FILE_SIZE + 1);
    const fd = openSync(path, "r");
    const buf = new Uint8Array(readSize);
    readSync(fd, buf, 0, readSize, 0);
    closeSync(fd);

    // Binary detection: check first 512 bytes for null bytes
    const header = buf.subarray(0, Math.min(512, readSize));
    if (header.includes(0)) return "<binary file, not shown>";

    const text = new TextDecoder().decode(buf);
    if (fileSize > MAX_FILE_SIZE) {
      return text.slice(0, MAX_FILE_SIZE) + "\n<truncated at 8KB>";
    }

    return text;
  } catch {
    return "<error reading file>";
  }
}

/**
 * Build the user message for Turn 1 (command only).
 */
export function buildUserMessage(command: string): string {
  return `<command>\n${command}\n</command>`;
}

/**
 * Build the user message for Turn 2 (command + referenced files).
 */
export function buildFileInspectionMessage(
  command: string,
  files: Array<{ path: string; content: string }>,
): string {
  let msg = `<command>\n${command}\n</command>\n`;
  for (const file of files) {
    msg += `\n<referenced-file path="${file.path}">\n${file.content}\n</referenced-file>`;
  }
  return msg;
}

/**
 * Classify a command using Haiku with two-turn file inspection.
 */
export async function classifyWithHaiku(
  command: string,
  maxAttempts = 2,
): Promise<Verdict> {
  // Turn 1: classify or request files
  const turn1Verdict = await invokeHaiku(
    buildUserMessage(command),
    maxAttempts,
  );

  if (turn1Verdict.verdict !== "need_files") {
    return turn1Verdict;
  }

  // Between turns: read requested files (already capped at MAX_FILES by parseVerdict)
  const fileContents = turn1Verdict.files.map((path) => ({
    path,
    content: readFileForInspection(path),
  }));

  // Turn 2: classify with file context
  const turn2Verdict = await invokeHaiku(
    buildFileInspectionMessage(command, fileContents),
    maxAttempts,
  );

  // Turn 2 must produce a final verdict — no further need_files
  if (turn2Verdict.verdict === "need_files") {
    return { verdict: "block", reason: "recursive file request denied" };
  }

  return turn2Verdict;
}

/**
 * Invoke Haiku via claude -p subprocess.
 */
async function invokeHaiku(
  userMessage: string,
  maxAttempts: number,
): Promise<Verdict> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const proc = Bun.spawn(
        [
          "claude",
          "-p",
          "--model",
          "claude-haiku-4-5-20251001",
          "--max-turns",
          "1",
          "-",
        ],
        {
          stdin: new TextEncoder().encode(
            JSON.stringify({
              system: SYSTEM_PROMPT,
              messages: [{ role: "user", content: userMessage }],
            }),
          ),
          stdout: "pipe",
          stderr: "ignore",
          env: { ...process.env, CLAUDE_SESSION_NAMER: "1" },
        },
      );

      const output = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;

      if (exitCode !== 0) continue;

      const verdict = parseVerdict(output);
      return verdict;
    } catch {
      continue;
    }
  }

  return { verdict: "block", reason: "haiku classification failed" };
}
