/**
 * LLM access via OpenAI-compatible gateways.
 *
 * Two tiers, deliberately separated by cost:
 *
 *  - `fast`  cheap model on the interactive path (/api/agent). This endpoint is
 *            public, so it must never reach an expensive model by default.
 *  - `deep`  Claude, reserved for low-frequency high-value output such as the
 *            daily brief. The Gorouter gateway prepends a ~7k-token system
 *            prompt to every call, so each request costs roughly $0.11 in input
 *            alone — affordable once a day, ruinous per page view.
 */
/**
 * `code` runs on a separate Gorouter account from `deep` on purpose. Both bill
 * the same ~6.9k-token overhead per call, so a burst of file generation on a
 * shared account would quietly consume the credit the daily brief depends on.
 * Separate accounts mean one workload cannot starve the other.
 */
import { announceOnce, recordSpend, spendAllows, usageFrom } from "./spend";

export type Tier = "fast" | "deep" | "code";

type Gateway = {
  name: string;
  baseUrl: string;
  apiKey: string | undefined;
  model: string;
  /** Gorouter sits behind Cloudflare and rejects non-browser user agents. */
  browserUA?: boolean;
};

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function gateways(tier: Tier): Gateway[] {
  /**
   * Sonnet 5 leads because tool-calling quality is what this agent lives on:
   * it decides which tools to call and in what order, and a weaker model makes
   * that decision badly. Probing showed claude-haiku-4-5 has no providers on
   * this gateway, so gpt-56-sol is the fallback rather than the mini tier.
   */
  const virtuals: Gateway = {
    name: "virtuals/claude-sonnet-5",
    baseUrl: process.env.VELTR_VIRTUALS_BASE_URL || "https://compute.virtuals.io/v1",
    apiKey: process.env.VELTR_VIRTUALS_API_KEY,
    model: process.env.VELTR_FAST_MODEL || "anthropic-claude-sonnet-5",
  };

  const virtualsFallback: Gateway = {
    name: "virtuals/gpt-56-sol",
    baseUrl: process.env.VELTR_VIRTUALS_BASE_URL || "https://compute.virtuals.io/v1",
    apiKey: process.env.VELTR_VIRTUALS_API_KEY,
    model: "openai-gpt-56-sol",
  };

  const gorouter: Gateway = {
    name: "gorouter/claude-opus-5",
    baseUrl: process.env.VELTR_GOROUTER_BASE_URL || "https://gorouter.app/v1",
    apiKey: process.env.VELTR_GOROUTER_API_KEY,
    model: "claude-opus-5-thinking",
    browserUA: true,
  };

  const groq: Gateway | null = process.env.GROQ_API_KEY
    ? {
        name: "groq/llama-3.3-70b",
        baseUrl: "https://api.groq.com/openai/v1",
        apiKey: process.env.GROQ_API_KEY,
        model: "llama-3.3-70b-versatile",
      }
    : null;

  const gorouterCode: Gateway = {
    name: "gorouter-code/claude-opus-5",
    baseUrl: process.env.VELTR_GOROUTER_BASE_URL || "https://gorouter.app/v1",
    apiKey: process.env.VELTR_GOROUTER_CODE_API_KEY,
    model: "claude-opus-5-thinking",
    browserUA: true,
  };

  const virtualsCode: Gateway = {
    name: "virtuals/opus-5-fast",
    baseUrl: process.env.VELTR_VIRTUALS_BASE_URL || "https://compute.virtuals.io/v1",
    apiKey: process.env.VELTR_VIRTUALS_API_KEY,
    model: "anthropic-claude-opus-5-fast",
  };

  const chain =
    tier === "code"
      ? // Measured on the same file-writing task: opus-5-fast on Virtuals took
        // 9.1s and produced valid, longer output; Gorouter's opus-5-thinking
        // took 18.3s. The gap is the gateway, not the model — Gorouter prepends
        // ~8.9k prompt tokens that must be processed before the request is even
        // read. Gorouter stays as fallback because its credit is worth having
        // when Virtuals is unavailable.
        [virtualsCode, gorouterCode, gorouter]
      : tier === "deep"
        ? [gorouter, virtuals, virtualsFallback]
        : [virtuals, virtualsFallback, groq, gorouter];

  return chain.filter((g): g is Gateway => g !== null && Boolean(g.apiKey));
}

export type LlmResult =
  | {
      text: string;
      model: string;
      /**
       * The model hit its token ceiling and the output stops mid-content.
       * Callers writing files must check this: a truncated HTML document is
       * still delivered as a file and still opens, which is why the failure is
       * expensive — it looks correct until someone uses it.
       */
      truncated: boolean;
    }
  | null;

async function callGateway(
  gateway: Gateway,
  system: string,
  user: string,
  maxTokens: number
): Promise<LlmResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${gateway.apiKey}`,
  };
  if (gateway.browserUA) headers["User-Agent"] = BROWSER_UA;

  const res = await fetch(`${gateway.baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: gateway.model,
      temperature: 0.2,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
    // Scaled to the output budget: a 16k-token file takes far longer than a
    // 700-token answer, and a fixed timeout would abort the long generation
    // just before it finished — spending the call and delivering nothing.
    signal: AbortSignal.timeout(Math.max(60_000, maxTokens * 15)),
  });

  if (!res.ok) {
    throw new Error(`${gateway.name} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  const json = await res.json();
  const choice = json.choices?.[0];
  const text: string = choice?.message?.content ?? "";

  // Metered before the empty-content check: a call that returned nothing usable
  // was still paid for, and a meter that only counts successes is a meter that
  // undercounts exactly when something is going wrong.
  void recordSpend(usageFrom(json, system.length + user.length, text.length)).catch(() => {});

  if (!text.trim()) throw new Error(`${gateway.name} returned empty content`);

  const reason = choice?.finish_reason ?? choice?.native_finish_reason;
  return {
    text: text.trim(),
    model: gateway.name,
    truncated: reason === "length" || reason === "max_tokens",
  };
}

/**
 * The daily ceiling, checked at the one door every model call goes through.
 *
 * Returning null rather than throwing: every caller already handles a null as
 * "no gateway answered", so a ceiling degrades the product the same way an
 * outage does instead of surfacing as a crash.
 */
async function overCeiling(): Promise<boolean> {
  const verdict = await spendAllows("interactive");
  if (verdict.allowed) return false;

  console.warn(`[veltr][SPEND] refusing — ${verdict.tokens} tokens today, ceiling ${verdict.ceiling}`);
  void announceOnce(
    "hard",
    [
      "🛑 Veltr has stopped calling the model.",
      "",
      `The daily ceiling is spent: ${verdict.tokens.toLocaleString()} tokens against a limit of ${verdict.ceiling.toLocaleString()}.`,
      "",
      "Everything else still works — prices, watches and alerts do not use the model. Answers and missions resume at midnight UTC, or raise VELTR_DAILY_TOKEN_HARD.",
    ].join("\n")
  ).catch(() => {});
  return true;
}

/** Tries each configured gateway in order; returns null if all fail or none exist. */
export async function complete(
  tier: Tier,
  system: string,
  user: string,
  maxTokens = 700
): Promise<LlmResult> {
  if (await overCeiling()) return null;

  for (const gateway of gateways(tier)) {
    try {
      return await callGateway(gateway, system, user, maxTokens);
    } catch (error) {
      console.warn(`[veltr] ${gateway.name} failed:`, error instanceof Error ? error.message : error);
    }
  }
  return null;
}

/* ------------------------------------------------------- Tool calling */

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
};

export type ToolTurn = {
  message: ChatMessage;
  model: string;
};

/**
 * One turn of a tool-calling conversation.
 *
 * Returns the assistant message verbatim — including any `tool_calls` — so the
 * caller can execute the tools and feed results back. The message is echoed
 * unchanged into the next request because providers validate that every
 * `tool_call_id` they issued is answered.
 */
export async function chatWithTools(
  tier: Tier,
  messages: ChatMessage[],
  tools: unknown[],
  maxTokens = 900
): Promise<ToolTurn | null> {
  for (const gateway of gateways(tier)) {
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${gateway.apiKey}`,
      };
      if (gateway.browserUA) headers["User-Agent"] = BROWSER_UA;

      const res = await fetch(`${gateway.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: gateway.model,
          temperature: 0.2,
          max_tokens: maxTokens,
          messages,
          tools,
          tool_choice: "auto",
        }),
        signal: AbortSignal.timeout(90_000),
      });

      if (!res.ok) {
        throw new Error(`${gateway.name} ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }

      const json = await res.json();
      const message = json.choices?.[0]?.message;

      void recordSpend(
        usageFrom(json, JSON.stringify(messages).length, JSON.stringify(message ?? "").length)
      ).catch(() => {});

      if (!message) throw new Error(`${gateway.name} returned no message`);

      return { message, model: gateway.name };
    } catch (error) {
      console.warn(`[veltr] ${gateway.name} tool turn failed:`, error instanceof Error ? error.message : error);
    }
  }
  return null;
}

export function configuredProviders(): string[] {
  return [...new Set([...gateways("fast"), ...gateways("deep")].map((g) => g.name))];
}
