import SYSTEM_PROMPT from "./system-prompt.txt" with { type: "text" };

export type Verdict =
  | { verdict: "allow"; reason: string }
  | { verdict: "block"; reason: string }
  | { verdict: "approve"; reason: string };

export function buildUserMessage(command: string): string {
  return `<command>\n${command}\n</command>`;
}

export { SYSTEM_PROMPT };

export function parseVerdict(text: string): Verdict {
  let jsonStr = text.trim();

  // Extract JSON by finding first { and last } — handles surrounding text
  // and reason strings containing braces
  const firstBrace = jsonStr.indexOf("{");
  const lastBrace = jsonStr.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);
  }

  const parsed = JSON.parse(jsonStr);

  if (!["allow", "block", "approve"].includes(parsed.verdict)) {
    throw new Error(`invalid verdict: ${parsed.verdict}`);
  }
  if (typeof parsed.reason !== "string") {
    throw new Error("missing reason");
  }

  return { verdict: parsed.verdict, reason: parsed.reason };
}

export async function classifyWithHaiku(
  command: string,
  maxAttempts = 2,
): Promise<Verdict> {
  const prompt = `${SYSTEM_PROMPT}\n\n${buildUserMessage(command)}`;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Use claude -p which authenticates via CLAUDE_CODE_OAUTH_TOKEN natively.
      // Pipe prompt via stdin to avoid shell argument length/escaping issues.
      // CLAUDE_SESSION_NAMER=1 prevents the Stop hook's session-namer from firing.
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
          stdin: new TextEncoder().encode(prompt),
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, CLAUDE_SESSION_NAMER: "1" },
        },
      );

      // Drain stdout and stderr concurrently to avoid pipe buffer deadlock
      const [result, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      if (exitCode !== 0) {
        throw new Error(
          `claude -p exited ${exitCode}: ${stderr.slice(0, 200)}`,
        );
      }

      return parseVerdict(result);
    } catch (err) {
      console.error(
        `[HOOK] Haiku attempt ${attempt}/${maxAttempts} failed: ${err}`,
      );
      if (attempt === maxAttempts) throw err;
    }
  }

  throw new Error("unreachable");
}
