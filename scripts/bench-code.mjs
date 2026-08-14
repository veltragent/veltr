// Which model writes a real file fastest, and is the output still correct?
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36";

const SYSTEM = `You produce files. Output ONLY the file's contents — no explanation, no fences.`;
const TASK = `A self-contained HTML page: a dark dashboard showing three metric cards (Revenue, Users, Uptime) with inline CSS. No external links.`;

async function bench(label, url, key, model, extraHeaders = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${url}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, ...extraHeaders },
      body: JSON.stringify({
        model,
        max_tokens: 4000,
        temperature: 0.2,
        messages: [{ role: "system", content: SYSTEM }, { role: "user", content: TASK }],
      }),
      signal: AbortSignal.timeout(180_000),
    });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    if (!res.ok) { console.log(`  ${label.padEnd(30)} HTTP ${res.status} after ${elapsed}s`); return; }

    const j = await res.json();
    const text = j.choices?.[0]?.message?.content ?? "";
    const valid = /<!DOCTYPE html>/i.test(text) && /<\/html>/i.test(text);
    const fenced = /^```/.test(text.trim());

    console.log(
      `  ${label.padEnd(30)} ${String(elapsed + "s").padStart(7)}  ${String(text.length).padStart(5)} chars  ` +
      `valid=${valid ? "yes" : "NO "}  fenced=${fenced ? "YES" : "no"}  prompt_tokens=${j.usage?.prompt_tokens ?? "?"}`
    );
  } catch (e) {
    console.log(`  ${label.padEnd(30)} ${((Date.now() - t0) / 1000).toFixed(1)}s — ${e.message.slice(0, 50)}`);
  }
}

console.log("Writing the same HTML page with each candidate:\n");

await bench("gorouter opus-5-thinking", env.VELTR_GOROUTER_BASE_URL, env.VELTR_GOROUTER_CODE_API_KEY, "claude-opus-5-thinking", { "User-Agent": UA });
await bench("gorouter opus-5", env.VELTR_GOROUTER_BASE_URL, env.VELTR_GOROUTER_CODE_API_KEY, "claude-opus-5", { "User-Agent": UA });
await bench("virtuals sonnet-5", env.VELTR_VIRTUALS_BASE_URL, env.VELTR_VIRTUALS_API_KEY, "anthropic-claude-sonnet-5");
await bench("virtuals opus-5-fast", env.VELTR_VIRTUALS_BASE_URL, env.VELTR_VIRTUALS_API_KEY, "anthropic-claude-opus-5-fast");
await bench("virtuals gpt-56-sol", env.VELTR_VIRTUALS_BASE_URL, env.VELTR_VIRTUALS_API_KEY, "openai-gpt-56-sol");
