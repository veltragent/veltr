/**
 * Provider layer.
 *
 * The agent core talks to this interface and never to a gateway, an SDK or a
 * model name. Two reasons, and the second is the one that matters: swapping
 * providers must not touch the loop, and the loop must be testable without a
 * network or an API key — a decision engine that can only be exercised against a
 * live model is a decision engine whose edge cases are never tested.
 *
 * The concrete adapter wraps lib/llm.ts, which already handles gateway fallback,
 * so no provider logic is duplicated here.
 */

export type ReasonerRequest = {
  system: string;
  user: string;
  maxTokens?: number;
};

export type ReasonerReply = { text: string; model: string } | null;

export type Reasoner = {
  name: string;
  think(request: ReasonerRequest): Promise<ReasonerReply>;
};

/** The production reasoner. Imported lazily so tests never load the gateway stack. */
export function llmReasoner(tier: "fast" | "deep" = "fast"): Reasoner {
  return {
    name: `llm:${tier}`,
    async think({ system, user, maxTokens = 900 }) {
      const { complete } = await import("../llm");
      const result = await complete(tier, system, user, maxTokens);
      return result ? { text: result.text, model: result.model } : null;
    },
  };
}

/* ---------------------------------------------------------- JSON output */

/**
 * Reasoning the user must never see.
 *
 * Models emit deliberation in these wrappers, and it is exactly the material
 * that reads as authoritative while being unverified. It is removed before
 * anything is parsed, so it cannot reach a `reason` field and travel out to the
 * user from there.
 */
const THINKING_BLOCK = /<(thinking|thought|scratchpad|reasoning)>[\s\S]*?<\/\1>/gi;

export function stripReasoning(text: string): string {
  return text.replace(THINKING_BLOCK, "").trim();
}

/**
 * Extracts the JSON object from a model reply.
 *
 * Models wrap JSON in code fences, prefix it with "Here is the result:", or
 * append a closing remark. All three produce a parse failure that looks like a
 * provider outage unless it is handled here — so the object is located by
 * brace matching rather than by hoping the whole reply is valid JSON.
 *
 * Returns null rather than throwing: a malformed reply is a condition the loop
 * handles by retrying or concluding, not an exception.
 */
export function parseJsonObject(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  const text = stripReasoning(String(raw));

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = [fenced?.[1], text].filter((c): c is string => Boolean(c));

  for (const candidate of candidates) {
    const direct = tryParse(candidate.trim());
    if (direct) return direct;

    const extracted = extractBalancedObject(candidate);
    if (extracted) {
      const parsed = tryParse(extracted);
      if (parsed) return parsed;
    }
  }

  return null;
}

function tryParse(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Finds the first complete JSON object by counting braces.
 *
 * A regex cannot do this correctly — braces nest, and a brace inside a string
 * literal is not a brace — so the scan tracks string state and escapes.
 */
function extractBalancedObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return null;
}
