import { normalizeAndSplit, prescanLine } from "./prescan";
import { tokenize, splitSegments, parseSegment } from "./tokenize";
import { evaluateRules } from "./rules";
import { checkOwnedRemotePush } from "./ownership";
import { checkGhExemption } from "./gh-exemption";
import { classifyWithHaiku } from "./classifier";
import { outputDecision } from "./hook-output";

type Decision = "allow" | "deny" | "ask";

interface SegmentResult {
  decision: Decision;
  reason: string;
}

/**
 * Evaluate a single segment through layers 6a-6g.
 */
async function evaluateSegment(
  tokens: Array<string | { op: string }>,
  isPipeTarget: boolean,
  rawLine: string,
): Promise<SegmentResult> {
  const segment = parseSegment(tokens, isPipeTarget);

  // 6a. Structural signal check
  if (segment.hasOperatorTokens) {
    return { decision: "deny", reason: "subshell/substitution operator" };
  }
  if (segment.hasBackticks) {
    return { decision: "deny", reason: "backtick command substitution" };
  }
  if (segment.hasEmbeddedSubstitution) {
    // Escalate to Haiku — potentially legitimate (commit messages)
    const verdict = await classifyWithHaiku(rawLine);
    if (verdict.verdict === "block")
      return { decision: "deny", reason: verdict.reason };
    if (verdict.verdict === "approve")
      return { decision: "ask", reason: verdict.reason };
    return { decision: "allow", reason: verdict.reason };
  }

  // 6b. Structural deny rules (before ownership exemption)
  const ruleResult = evaluateRules(segment);
  if (ruleResult.decision === "deny") {
    return { decision: "deny", reason: ruleResult.reason };
  }

  // 6c. Owned-remote push exemption (after deny rules)
  if (segment.program === "git" && segment.positionals[0] === "push") {
    const isOwned = await checkOwnedRemotePush(segment);
    if (isOwned) {
      return { decision: "allow", reason: "owned remote push" };
    }
  }

  // 6d. Structural escalation rules
  if (ruleResult.decision === "escalate") {
    // 6e. Contextual gh exemption
    if (segment.program === "gh") {
      const ghResult = await checkGhExemption(segment);
      if (ghResult === "allow") {
        return { decision: "allow", reason: "related repo gh command" };
      }
      if (ghResult === "deny") {
        return { decision: "deny", reason: "missing remote snapshot" };
      }
      // ghResult === "escalate" → fall through to Haiku
    }

    // 6f. Haiku classification
    const verdict = await classifyWithHaiku(rawLine);
    if (verdict.verdict === "block")
      return { decision: "deny", reason: verdict.reason };
    if (verdict.verdict === "approve")
      return { decision: "ask", reason: verdict.reason };
    return { decision: "allow", reason: verdict.reason };
  }

  // 6g. Default allow
  return { decision: "allow", reason: "no rule matched" };
}

/**
 * Main pipeline: evaluate a command through all 7 layers.
 */
async function evaluateCommand(raw: string): Promise<SegmentResult> {
  // Layer 1+2: normalize and split
  const splitResult = normalizeAndSplit(raw);
  if (splitResult.decision === "deny") {
    return { decision: "deny", reason: splitResult.reason };
  }

  if (!("lines" in splitResult)) {
    return { decision: "allow", reason: "empty command" };
  }

  let worstDecision: Decision = "allow";
  let worstReason = "no rule matched";

  for (const line of splitResult.lines) {
    // Layer 3: raw string pre-scan
    const prescanResult = prescanLine(line);
    if (prescanResult.decision === "deny") {
      return { decision: "deny", reason: prescanResult.reason };
    }

    let lineDecision: Decision = "allow";
    let lineReason = "";

    if (prescanResult.decision === "escalate") {
      // Escalate the whole line to Haiku
      const verdict = await classifyWithHaiku(line);
      if (verdict.verdict === "block") {
        return { decision: "deny", reason: verdict.reason };
      }
      lineDecision = verdict.verdict === "approve" ? "ask" : "allow";
      lineReason = verdict.reason;
    } else {
      // Layer 4: tokenize
      const tokens = tokenize(line);

      // Layer 5: segment split
      const segments = splitSegments(tokens);

      // Layer 6: per-segment evaluation
      for (const seg of segments) {
        const result = await evaluateSegment(
          seg.tokens,
          seg.isPipeTarget,
          line,
        );

        // Layer 7: aggregate — most restrictive wins
        if (result.decision === "deny") {
          return result; // Immediate short-circuit
        }
        if (result.decision === "ask") {
          lineDecision = "ask";
          lineReason = result.reason;
        }
      }
    }

    // Cross-line aggregation
    if (lineDecision === "ask" && worstDecision === "allow") {
      worstDecision = "ask";
      worstReason = lineReason;
    }
  }

  return { decision: worstDecision, reason: worstReason };
}

// --- Main entry point ---

async function main() {
  try {
    const input = await new Response(Bun.stdin.stream()).text();
    const hookInput = JSON.parse(input);
    const command: string = hookInput.hook_specific_input?.command ?? "";

    if (!command) {
      outputDecision("allow", "empty command");
      return;
    }

    console.error(`[HOOK] evaluating: ${command.slice(0, 200)}`);

    const result = await evaluateCommand(command);

    console.error(`[HOOK] decision=${result.decision} reason=${result.reason}`);

    outputDecision(result.decision, result.reason);
  } catch (error) {
    console.error(`[HOOK] error: ${error}`);
    outputDecision("deny", "pipeline error");
  }
}

main();
