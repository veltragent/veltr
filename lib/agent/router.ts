/**
 * Tool routing.
 *
 * The registry holds around thirty tools. Offering all of them on every round
 * costs tokens on every call, and — more expensively — degrades the choice: a
 * model given thirty options picks worse than one given six, and picks
 * something irrelevant often enough to waste a whole round on it.
 *
 * Routing is deterministic and costs nothing. Using a model call to decide which
 * tools to offer a model call is a round-trip spent on a decision that keyword
 * signals make correctly, and it would be one more thing that can fail.
 */

/** What each tool is for. A tool with no tags is never routed by signal. */
const TOOL_TAGS: Record<string, string[]> = {
  // Market and chain reads
  token_lookup: ["market", "price", "token", "crypto", "chain", "discovery"],
  get_price: ["market", "price"],
  get_token: ["market", "chain", "token"],
  search_tokens: ["market", "discovery"],
  get_market: ["market", "macro"],
  compare_premiums: ["market", "price"],
  get_analyst_view: ["market", "equity"],
  get_onchain_detail: ["chain", "market", "liquidity"],
  list_chain_tokens: ["chain", "discovery"],
  get_recent_trades: ["chain", "flow", "liquidity"],
  get_global_crypto: ["macro", "crypto"],
  get_crypto_asset: ["crypto", "price"],
  get_corporate_actions: ["chain", "corporate"],
  get_announced_splits: ["corporate", "equity"],

  // Wallet
  get_wallet_exposure: ["wallet"],
  list_owned_positions: ["wallet", "position"],
  get_delegation_status: ["wallet", "position"],

  // Research
  web_search: ["web", "news"],
  deep_search: ["web", "research"],
  read_url: ["web", "page"],
  get_news: ["news", "equity"],

  // Code
  repo_map: ["code", "repo", "discovery", "search"],
  github_repo: ["code", "repo"],
  github_files: ["code", "repo"],
  github_read_file: ["code", "repo"],
  github_search_code: ["code", "search"],
  read_attached_file: ["code", "file"],

  // Actions
  send_chart: ["action", "chart"],
  set_alert_scope: ["action", "alerts"],
  create_file: ["action", "file"],
  write_code: ["action", "file", "code"],
  defend_position: ["action", "position"],
  get_alert_status: ["alerts"],
};

/** Objective wording → the capabilities it implies. */
const SIGNALS: [RegExp, string[]][] = [
  [/\b(price|harga|worth|cost|quote|premium|mispric|dislocat)/i, ["price", "market"]],
  [/\b(volume|liquidity|likuiditas|pool|swap|trade|flow|depth)/i, ["liquidity", "flow", "chain"]],
  [/\b(market ?cap|mcap|fdv|macro|crypto|bitcoin|btc|eth|ethereum)/i, ["crypto", "macro", "price"]],
  [/\b(why|kenapa|mengapa|explain|investigate|investigasi|caus|driver|moving|move|reason)/i, ["news", "web", "price"]],
  [/\b(news|berita|headline|announce|filing|sec|report)/i, ["news", "web"]],
  [/\b(search|find|cari|latest|recent|research|riset|source|sumber)/i, ["web", "research"]],
  [/\b(split|dividend|corporate action|multiplier|rebase)/i, ["corporate", "chain"]],
  [/\b(wallet|address|holding|exposure|portfolio|balance|posisi|position)/i, ["wallet", "position"]],
  [/\b(alert|notify|notifikasi|watch|pantau|subscribe|monitor)/i, ["alerts", "market"]],
  [/\b(repo|repository|github|codebase|commit|pull request)/i, ["repo", "code", "search"]],
  [/\b(code|coding|refactor|test|build|production[- ]?ready|bug|lint)/i, ["code", "file"]],
  [/\b(chart|grafik|graph|candle)/i, ["chart", "price"]],
  [/\b(write|generate|buat|produce|draft|file|report|document|html|csv|markdown)/i, ["file"]],
  [/\b(token|ticker|stock|saham|equity|share)/i, ["market", "token", "equity"]],
  [/\bhttps?:\/\//i, ["page", "web"]],
  [/\b(chain|on-?chain|robinhood)/i, ["chain", "discovery"]],
];

/**
 * Always offered.
 *
 * Not because every objective needs them, but because an agent with no orienting
 * read at all cannot tell whether its other observations are anomalous. These
 * are the cheapest reads available.
 */
const ALWAYS = ["get_market"];

/** How many tools reach the model in one round. */
export const MAX_ROUTED_TOOLS = 8;

export type RoutableTool = {
  name: string;
  description: string;
  /** JSON-schema parameters, so the model names arguments correctly. */
  parameters?: Record<string, unknown>;
};

export type Routed = {
  tools: RoutableTool[];
  /** Capabilities the objective was read as needing. Surfaced for observability. */
  tags: string[];
};

export function signalsFor(objective: string): string[] {
  const tags = new Set<string>();
  for (const [pattern, implied] of SIGNALS) {
    if (pattern.test(objective)) for (const tag of implied) tags.add(tag);
  }
  return [...tags];
}

/**
 * Selects the tools worth offering for this objective.
 *
 * Scored rather than filtered: a tool matching two of the objective's signals
 * should outrank one matching a single signal, and an objective whose wording
 * matches nothing must still get a usable set rather than an empty one.
 */
export function routeTools(
  objective: string,
  available: RoutableTool[],
  options: { limit?: number; exclude?: string[] } = {}
): Routed {
  const limit = options.limit ?? MAX_ROUTED_TOOLS;
  const excluded = new Set(options.exclude ?? []);
  const tags = signalsFor(objective);
  const wanted = new Set(tags);

  const scored = available
    .filter((tool) => !excluded.has(tool.name))
    .map((tool) => {
      const toolTags = TOOL_TAGS[tool.name] ?? [];
      let score = toolTags.reduce((sum, tag) => sum + (wanted.has(tag) ? 1 : 0), 0);

      // A tool named outright in the objective is what the user asked for.
      if (objective.toLowerCase().includes(tool.name)) score += 5;
      if (ALWAYS.includes(tool.name)) score += 0.5;

      // An untagged tool is unclassified, not irrelevant — it stays reachable,
      // below everything that matched, so a newly added tool is never invisible.
      if (toolTags.length === 0) score += 0.1;

      return { tool, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));

  return { tools: scored.slice(0, limit).map((entry) => entry.tool), tags };
}

/** The live registry, as routable descriptions. Lazy so tests need no viem. */
export async function availableTools(): Promise<RoutableTool[]> {
  const { toolSchemas } = await import("../tools");
  return toolSchemas().map((schema) => ({
    name: schema.function.name,
    description: schema.function.description,
    parameters: schema.function.parameters,
  }));
}

/**
 * Renders a tool's signature for the prompt.
 *
 * The parameter names have to be here. Given only a description, a model guesses
 * argument names from the prose — asking for `{ticker: "NVDA"}` when the tool
 * takes `symbol` — and the call fails in a way that reads like missing data
 * rather than a malformed request. Observed on a live run: two of five calls
 * wasted that way before this was added.
 */
export function signatureOf(tool: RoutableTool): string {
  const schema = tool.parameters as
    | { properties?: Record<string, { type?: unknown; enum?: unknown[] }>; required?: string[] }
    | undefined;

  const properties = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);

  const args = Object.entries(properties).map(([name, spec]) => {
    const type = Array.isArray(spec?.enum)
      ? spec.enum.map((v) => JSON.stringify(v)).join("|")
      : String(spec?.type ?? "string");
    return `${name}${required.has(name) ? "" : "?"}: ${type}`;
  });

  return `${tool.name}(${args.join(", ")})`;
}
