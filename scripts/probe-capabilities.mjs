// Establishes what each credential can actually do, and where it stops.
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);

const line = (label, detail) => console.log(`  ${String(label).padEnd(26)} ${detail}`);

/* ------------------------------------------------------------- CoinGecko */
console.log("\n=== CoinGecko (keyed) ===");
for (const [host, header] of [
  ["https://pro-api.coingecko.com/api/v3", "x-cg-pro-api-key"],
  ["https://api.coingecko.com/api/v3", "x-cg-demo-api-key"],
]) {
  try {
    const res = await fetch(`${host}/ping`, { headers: { [header]: env.COINGECKO_API_KEY } });
    line(host.includes("pro") ? "pro endpoint" : "demo endpoint", `HTTP ${res.status} ${(await res.text()).slice(0, 60)}`);
  } catch (e) { line("error", e.message); }
}
try {
  const res = await fetch("https://api.coingecko.com/api/v3/key", {
    headers: { "x-cg-demo-api-key": env.COINGECKO_API_KEY },
  });
  line("plan / usage", (await res.text()).slice(0, 220));
} catch (e) { line("plan", e.message); }

/* ---------------------------------------------------------------- Codex */
console.log("\n=== Codex (Defined) GraphQL ===");
async function codex(query, variables = {}) {
  const res = await fetch(env.CODEX_GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: env.CODEX_API_KEY },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(40_000),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
try {
  const r = await codex(`{ getNetworks { name id } }`);
  const nets = r.body?.data?.getNetworks ?? [];
  line("auth", `HTTP ${r.status}`);
  line("networks visible", nets.length);
  const rh = nets.filter((n) => /robin|hood/i.test(n.name) || n.id === 4663);
  line("Robinhood Chain", rh.length ? `id=${rh[0].id} name=${rh[0].name}` : "NOT SUPPORTED");
  if (r.body?.errors) line("errors", JSON.stringify(r.body.errors).slice(0, 200));
} catch (e) { line("error", e.message); }

/* --------------------------------------------------------------- Tavily */
console.log("\n=== Tavily ===");
try {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.TAVILY_API_KEY}` },
    body: JSON.stringify({ query: "Robinhood Chain tokenized stocks", max_results: 3, search_depth: "advanced", include_answer: true }),
    signal: AbortSignal.timeout(45_000),
  });
  const j = await res.json();
  line("status", `HTTP ${res.status}`);
  line("results", (j.results ?? []).length);
  line("answer synthesis", j.answer ? `yes (${String(j.answer).length} chars)` : "no");
  if (j.results?.[0]) line("sample", String(j.results[0].title).slice(0, 70));
  if (j.detail || j.error) line("note", JSON.stringify(j.detail ?? j.error).slice(0, 150));
} catch (e) { line("error", e.message); }

/* ------------------------------------------------------------------ Exa */
console.log("\n=== Exa ===");
try {
  const res = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": env.EXA_API_KEY },
    body: JSON.stringify({ query: "Robinhood Chain tokenized equities analysis", numResults: 3, type: "auto", contents: { text: { maxCharacters: 400 } } }),
    signal: AbortSignal.timeout(45_000),
  });
  const j = await res.json();
  line("status", `HTTP ${res.status}`);
  line("results", (j.results ?? []).length);
  line("full text", j.results?.[0]?.text ? "yes" : "no");
  if (j.results?.[0]) line("sample", String(j.results[0].title).slice(0, 70));
  if (j.error) line("note", JSON.stringify(j.error).slice(0, 150));
} catch (e) { line("error", e.message); }

/* ------------------------------------------------------------ Firecrawl */
console.log("\n=== Firecrawl ===");
try {
  const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.FIRECRAWL_API_KEY}` },
    body: JSON.stringify({ url: "https://docs.robinhood.com/chain/stock-tokens/", formats: ["markdown"] }),
    signal: AbortSignal.timeout(60_000),
  });
  const j = await res.json();
  line("v2 scrape", `HTTP ${res.status} success=${j.success}`);
  line("markdown chars", j.data?.markdown ? j.data.markdown.length : 0);
  if (j.error) line("note", String(j.error).slice(0, 150));
} catch (e) { line("error", e.message); }

/* ----------------------------------------------------------------- Jina */
console.log("\n=== Jina ===");
try {
  const res = await fetch("https://r.jina.ai/https://docs.robinhood.com/chain/stock-tokens/", {
    headers: { Authorization: `Bearer ${env.JINA_API_KEY}` },
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  line("reader", `HTTP ${res.status}, ${text.length} chars`);
} catch (e) { line("reader error", e.message); }
try {
  const res = await fetch("https://api.jina.ai/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.JINA_API_KEY}` },
    body: JSON.stringify({ model: "jina-embeddings-v3", input: ["test"] }),
    signal: AbortSignal.timeout(40_000),
  });
  const j = await res.json();
  line("embeddings", `HTTP ${res.status} dims=${j.data?.[0]?.embedding?.length ?? "n/a"}`);
} catch (e) { line("embeddings error", e.message); }

/* --------------------------------------------------------------- GitHub */
console.log("\n=== GitHub ===");
try {
  const h = { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "veltr" };
  const me = await fetch("https://api.github.com/user", { headers: h });
  const meJson = await me.json();
  line("auth", `HTTP ${me.status} login=${meJson.login ?? "-"}`);
  line("rate limit", `${me.headers.get("x-ratelimit-remaining")}/${me.headers.get("x-ratelimit-limit")}`);
  line("scopes", me.headers.get("x-oauth-scopes") ?? "(fine-grained token)");
  const repo = await fetch("https://api.github.com/repos/Uniswap/v4-core", { headers: h });
  const rj = await repo.json();
  line("public repo read", `HTTP ${repo.status} stars=${rj.stargazers_count ?? "-"}`);
  const search = await fetch("https://api.github.com/search/code?q=uiMultiplier+in:file&per_page=3", { headers: h });
  line("code search", `HTTP ${search.status} total=${(await search.json()).total_count ?? "-"}`);
} catch (e) { line("error", e.message); }

/* ------------------------------------------------- Virtuals model tiers */
console.log("\n=== Virtuals models (upgrade candidates) ===");
for (const model of ["anthropic-claude-haiku-4-5", "anthropic-claude-sonnet-5", "openai-gpt-56-sol", "openai-gpt-54-mini"]) {
  try {
    const res = await fetch(`${env.VELTR_VIRTUALS_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.VELTR_VIRTUALS_API_KEY}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with exactly: OK" }],
        tools: [{ type: "function", function: { name: "noop", description: "does nothing", parameters: { type: "object", properties: {} } } }],
        max_tokens: 50,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const j = await res.json();
    const ok = res.ok && j.choices?.[0]?.message;
    line(model, ok ? `OK (tools accepted)` : `HTTP ${res.status} ${JSON.stringify(j).slice(0, 90)}`);
  } catch (e) { line(model, e.message.slice(0, 80)); }
}
