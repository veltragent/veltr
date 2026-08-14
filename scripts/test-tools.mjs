// Does the fast gateway support OpenAI-style tool calling?
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);

const tools = [
  {
    type: "function",
    function: {
      name: "get_price",
      description: "Live price for a stock ticker and its token on Robinhood Chain.",
      parameters: {
        type: "object",
        properties: { symbol: { type: "string", description: "Ticker, e.g. NVDA" } },
        required: ["symbol"],
      },
    },
  },
];

async function probe(label, url, key, model, extraHeaders = {}) {
  try {
    const res = await fetch(`${url}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, ...extraHeaders },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "What is NVDA trading at? Use the tool." }],
        tools,
        tool_choice: "auto",
        max_tokens: 300,
      }),
      signal: AbortSignal.timeout(90_000),
    });

    const text = await res.text();
    if (!res.ok) {
      console.log(`  ${label}: HTTP ${res.status} — ${text.slice(0, 160)}`);
      return;
    }

    const json = JSON.parse(text);
    const msg = json.choices?.[0]?.message;
    const calls = msg?.tool_calls;

    if (calls?.length) {
      console.log(`  ${label}: TOOL CALLING SUPPORTED`);
      for (const c of calls) {
        console.log(`     -> ${c.function?.name}(${c.function?.arguments})  id=${c.id}`);
      }
    } else {
      console.log(`  ${label}: no tool_calls returned. content: ${String(msg?.content).slice(0, 110)}`);
    }
  } catch (e) {
    console.log(`  ${label}: ${e.message}`);
  }
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36";

console.log("=== tool-calling support ===");
await probe("virtuals/gpt-54-mini", env.VELTR_VIRTUALS_BASE_URL, env.VELTR_VIRTUALS_API_KEY, "openai-gpt-54-mini");
await probe("virtuals/claude-sonnet-5", env.VELTR_VIRTUALS_BASE_URL, env.VELTR_VIRTUALS_API_KEY, "anthropic-claude-sonnet-5");
await probe("gorouter/claude-opus-5", env.VELTR_GOROUTER_BASE_URL, env.VELTR_GOROUTER_API_KEY, "claude-opus-5-thinking", { "User-Agent": UA });
