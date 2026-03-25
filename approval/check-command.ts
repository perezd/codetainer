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

// --- Main entry point (only runs when executed directly) ---

const isMainModule =
  typeof Bun !== "undefined" && Bun.main === import.meta.path;

if (isMainModule) {
  try {
    const RULES_FILE = process.env.RULES_FILE ?? "/opt/approval/rules.conf";

    // Read hook input from stdin
    const input = JSON.parse(await Bun.stdin.text());
    if (input.tool_name !== "Bash") process.exit(0);
    const command: string = input.tool_input?.command ?? "";
    if (!command) process.exit(0);

    console.error(`[HOOK] Evaluating: ${command}`);

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
}
