import { renderLedger, resolveCitations, stripUnknownUrls, usableEvidence } from "./evidence";
import { parseJsonObject, stripReasoning, type Reasoner } from "./reasoner";
import type { Decision, DecisionVerdict, Evidence } from "./types";
import { signatureOf, type RoutableTool } from "./router";

/**
 * The decision engine.
 *
 * The model proposes; this module disposes. Everything coming back is treated as
 * a claim to be checked against the ledger rather than an answer to be relayed:
 * citations must resolve, URLs must have been seen, confidence must be earned,
 * and a verdict that outruns its evidence is downgraded rather than published.
 *
 * The result is that the worst a badly behaved model can do is produce a mission
 * that concludes "evidence is not sufficient" — never one that invents a number.
 */

const VERDICTS: DecisionVerdict[] = ["conclude", "investigate", "act", "insufficient_evidence"];

/** Long enough to justify, short enough that it cannot become a narrative. */
const MAX_REASON_CHARS = 400;

/**
 * Output budget for one decision.
 *
 * Has to hold the finished answer as well as the envelope around it. At 900 a
 * live run truncated mid-JSON and lost the mission; the ledger is rendered
 * shorter to pay for this.
 */
const DECISION_MAX_TOKENS = 1_500;

/**
 * Below this, a confidence figure is decoration.
 *
 * A number produced from a single observation describes the model's certainty
 * about its own guess, not the strength of a case. Two independent observations
 * is the minimum at which the word means anything.
 */
export const MIN_EVIDENCE_FOR_CONFIDENCE = 2;

const OBSERVE_SYSTEM = `You are the decision engine of Veltr, an autonomous market and research agent for Robinhood Chain.

You do not chat. You decide what to observe next, or what has been established.

Rules that are enforced, not requested:
- Every factual claim must cite evidence ids from the ledger, e.g. ["e1","e3"]. A citation that does not exist in the ledger is discarded.
- Never state a number, date, source or URL that is not in the ledger.
- If the ledger does not support a conclusion, answer with verdict "insufficient_evidence". Guessing is a failure, not a fallback.
- Do not explain your reasoning process. Give the conclusion and the evidence behind it.

Reply with a single JSON object and nothing else:
{
  "verdict": "conclude" | "investigate" | "act" | "insufficient_evidence",
  "reason": "one or two sentences, under 400 characters",
  "evidenceIds": ["e1"],
  "confidence": 0.0 to 1.0 or null,
  "answer": "the finished answer for the user, when verdict is conclude, else null",
  "calls": [ { "tool": "tool_name", "args": {} } ],
  "action": { "tool": "tool_name", "args": {} } or null
}

"calls" is used only with verdict "investigate": the tool calls to run next, at most 4, chosen from the available tools.
"action" is used only with verdict "act": one tool that changes something.`;

export type DecisionInput = {
  objective: string;
  ledger: Evidence[];
  tools: RoutableTool[];
  iteration: number;
  remainingToolCalls: number;
  /** Appended to the prompt when the loop is out of budget and must conclude. */
  mustConclude?: boolean;
};

export type DecisionOutcome = {
  decision: Decision;
  /** Tool calls requested with verdict "investigate". Already capped. */
  calls: { tool: string; args: Record<string, unknown> }[];
  model: string;
  /** Set when the reply could not be used; the decision is then a safe default. */
  malformed?: string;
};

function clampConfidence(raw: unknown, evidenceCount: number): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  if (evidenceCount < MIN_EVIDENCE_FOR_CONFIDENCE) return null;
  return Math.min(1, Math.max(0, raw));
}

function asVerdict(raw: unknown): DecisionVerdict | null {
  const value = String(raw ?? "").toLowerCase();
  return (VERDICTS as string[]).includes(value) ? (value as DecisionVerdict) : null;
}

/** A decision that claims nothing — used whenever the model cannot be trusted. */
function insufficient(reason: string): Decision {
  return {
    verdict: "insufficient_evidence",
    evidenceIds: [],
    reason,
    confidence: null,
    action: null,
    answer: null,
  };
}

/**
 * Asks for the next decision and validates the answer.
 *
 * Never throws and never returns something unchecked. A provider outage, a
 * malformed reply and a hallucinated citation all converge on the same safe
 * shape, because the caller must not have to distinguish between them to stay
 * honest.
 */
export async function decide(
  reasoner: Reasoner,
  input: DecisionInput
): Promise<DecisionOutcome> {
  // Signatures, not just names: a model given only a description invents
  // argument names and the call fails as though the data were missing.
  const toolList = input.tools
    .map((tool) => `- ${signatureOf(tool)}\n    ${tool.description.slice(0, 180)}`)
    .join("\n");

  const user = [
    `OBJECTIVE: ${input.objective}`,
    "",
    `ITERATION: ${input.iteration}`,
    `TOOL CALLS REMAINING: ${input.remainingToolCalls}`,
    "",
    "AVAILABLE TOOLS (use exactly these argument names):",
    toolList || "(none)",
    "",
    "EVIDENCE LEDGER:",
    renderLedger(input.ledger),
    "",
    input.mustConclude
      ? 'The budget is exhausted. You may not request more observations. Reply with verdict "conclude" using only the ledger above, or "insufficient_evidence" if it does not support an answer.'
      : "Decide the next step.",
  ].join("\n");

  const reply = await reasoner.think({ system: OBSERVE_SYSTEM, user, maxTokens: DECISION_MAX_TOKENS });

  if (!reply) {
    return {
      decision: insufficient("The reasoning provider is unavailable, so no conclusion was drawn."),
      calls: [],
      model: "unavailable",
      malformed: "provider_unavailable",
    };
  }

  let parsed = parseJsonObject(reply.text);
  let model = reply.model;

  /**
   * One retry on an unreadable reply.
   *
   * The usual cause is a decision truncated mid-JSON because the answer ran long
   * — seen on a live run, where four good observations were discarded over a
   * missing closing brace. Repairing the JSON would mean guessing at content, so
   * the model is asked again, once, with the answer length constrained. One extra
   * call is cheaper than the mission it saves.
   */
  if (!parsed) {
    const retry = await reasoner.think({
      system: OBSERVE_SYSTEM,
      user: `${user}\n\nYour previous reply could not be parsed as JSON. Reply with the JSON object only — no prose before or after it — and keep "answer" under 900 characters.`,
      maxTokens: DECISION_MAX_TOKENS,
    });
    if (retry) {
      parsed = parseJsonObject(retry.text);
      model = retry.model;
    }
  }

  if (!parsed) {
    return {
      decision: insufficient("The reasoning step returned an unreadable response."),
      calls: [],
      model,
      malformed: "unparseable",
    };
  }

  const verdict = asVerdict(parsed.verdict);
  if (!verdict) {
    return {
      decision: insufficient("The reasoning step returned no usable verdict."),
      calls: [],
      model,
      malformed: "unknown_verdict",
    };
  }

  const evidenceIds = resolveCitations(input.ledger, parsed.evidenceIds);
  const reason = stripUnknownUrls(
    stripReasoning(String(parsed.reason ?? "")).slice(0, MAX_REASON_CHARS),
    input.ledger
  );

  const rawAnswer = typeof parsed.answer === "string" ? parsed.answer : null;
  const answer = rawAnswer ? stripUnknownUrls(stripReasoning(rawAnswer), input.ledger) : null;

  const decision: Decision = {
    verdict,
    evidenceIds,
    reason: reason || "No reason given.",
    confidence: clampConfidence(parsed.confidence, evidenceIds.length),
    action: null,
    answer: null,
  };

  const allowed = new Set(input.tools.map((t) => t.name));

  if (verdict === "investigate") {
    const calls = normaliseCalls(parsed.calls, allowed, input.remainingToolCalls);
    // Asking to investigate with nothing to run would spin the loop for a round
    // and change nothing, so it is treated as having reached the end instead.
    if (calls.length === 0) {
      return {
        decision: { ...decision, verdict: "insufficient_evidence" },
        calls: [],
        model,
        malformed: "investigate_without_calls",
      };
    }
    return { decision, calls, model };
  }

  if (verdict === "act") {
    const action = normaliseAction(parsed.action, allowed);
    if (!action) {
      return {
        decision: { ...decision, verdict: "insufficient_evidence", reason: "An action was proposed that is not an available tool." },
        calls: [],
        model,
        malformed: "unroutable_action",
      };
    }
    return { decision: { ...decision, action }, calls: [], model };
  }

  if (verdict === "conclude") {
    // A conclusion resting on nothing is not a conclusion. This is the rule that
    // turns "do not hallucinate" from an instruction into a property.
    if (evidenceIds.length === 0 || usableEvidence(input.ledger).length === 0) {
      return {
        decision: insufficient(
          "A conclusion was proposed without citing any observation that supports it."
        ),
        calls: [],
        model,
        malformed: "uncited_conclusion",
      };
    }
    return {
      decision: { ...decision, answer: answer || decision.reason },
      calls: [],
      model,
    };
  }

  return { decision, calls: [], model };
}

function normaliseCalls(
  raw: unknown,
  allowed: Set<string>,
  remaining: number
): { tool: string; args: Record<string, unknown> }[] {
  if (!Array.isArray(raw)) return [];

  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const tool = String((entry as { tool?: unknown }).tool ?? "");
    // A tool outside the routed set was not offered; running it anyway would make
    // routing advisory rather than a control.
    if (!allowed.has(tool)) continue;
    const args = (entry as { args?: unknown }).args;
    calls.push({ tool, args: args && typeof args === "object" ? (args as Record<string, unknown>) : {} });
  }

  return calls.slice(0, Math.max(0, remaining));
}

function normaliseAction(
  raw: unknown,
  allowed: Set<string>
): { tool: string; args: Record<string, unknown> } | null {
  if (!raw || typeof raw !== "object") return null;
  const tool = String((raw as { tool?: unknown }).tool ?? "");
  if (!allowed.has(tool)) return null;
  const args = (raw as { args?: unknown }).args;
  return { tool, args: args && typeof args === "object" ? (args as Record<string, unknown>) : {} };
}
