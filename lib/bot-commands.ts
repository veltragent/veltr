import { buildRadarSnapshot } from "./tokens";
import { readPremium, fetchDexQuote, fetchPrimaryPool, fetchCandles, fetchGlobalMarket, type Candle } from "./market";
import { fetchStockQuote, fetchCompanyProfile, fetchMarketStatus, fetchRecommendations } from "./stocks";
import { fetchTickerNews } from "./news";
import { fetchAnnouncedSplits, matchSplitsToTokens } from "./splits-calendar";

/**
 * Command surface for the Telegram bot.
 *
 * Every command resolves against the same data layer the website uses, so the
 * bot and the site can never disagree about a number.
 */

const money = (v: number | null | undefined, dp = 2) =>
  v === null || v === undefined || !Number.isFinite(v) ? "—" : `$${v.toFixed(dp)}`;

const compact = (v: number | null | undefined) => {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (Math.abs(v) >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (Math.abs(v) >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
};

const pct = (v: number | null | undefined, dp = 2) =>
  v === null || v === undefined || !Number.isFinite(v)
    ? "—"
    : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(dp)}%`;

/** Telegram hard-limits a message to 4096 characters. */
export const clamp = (text: string, limit = 3900) =>
  text.length <= limit ? text : `${text.slice(0, limit - 20)}\n…(truncated)`;

/* ------------------------------------------------------------- Charting */

const BLOCKS = "▁▂▃▄▅▆▇█";

/**
 * Sparkline in block characters.
 *
 * Telegram cannot render SVG and generating a PNG would mean shipping a
 * rasteriser for one feature. Block glyphs give a readable shape in a plain
 * text message, which is what a terminal wants anyway.
 */
export function sparkline(values: number[], width = 48): string {
  if (values.length < 2) return "";

  // Downsample by bucket average so a long series still fits the line.
  const step = values.length / width;
  const sampled: number[] = [];
  for (let i = 0; i < width; i++) {
    const from = Math.floor(i * step);
    const to = Math.max(from + 1, Math.floor((i + 1) * step));
    const slice = values.slice(from, to);
    sampled.push(slice.reduce((a, b) => a + b, 0) / slice.length);
  }

  const min = Math.min(...sampled);
  const max = Math.max(...sampled);
  const range = max - min;

  return sampled
    .map((v) => {
      if (range === 0) return BLOCKS[3];
      const idx = Math.round(((v - min) / range) * (BLOCKS.length - 1));
      return BLOCKS[Math.max(0, Math.min(BLOCKS.length - 1, idx))];
    })
    .join("");
}

function chartBlock(candles: Candle[], symbol: string): string {
  if (candles.length < 2) return "No price history available.";

  const closes = candles.map((c) => c.close);
  const first = closes[0];
  const last = closes[closes.length - 1];
  const change = first > 0 ? (last / first - 1) * 100 : 0;
  const high = Math.max(...candles.map((c) => c.high));
  const low = Math.min(...candles.map((c) => c.low));

  const hours = candles.length;
  return [
    `${symbol} · last ${hours}h`,
    "",
    `\`${sparkline(closes)}\``,
    "",
    `high  ${money(high)}`,
    `low   ${money(low)}`,
    `last  ${money(last)}   ${pct(change)}`,
  ].join("\n");
}

/* ------------------------------------------------------------- Commands */

async function resolveToken(symbol: string) {
  const snapshot = await buildRadarSnapshot();
  return snapshot.tokens.find((t) => t.symbol.toUpperCase() === symbol.toUpperCase()) ?? null;
}

export async function cmdPrice(symbol: string): Promise<string> {
  const [token, stock, profile, status] = await Promise.all([
    resolveToken(symbol),
    fetchStockQuote(symbol),
    fetchCompanyProfile(symbol),
    fetchMarketStatus(),
  ]);

  if (!token && !stock) return `No data for ${symbol}. Try a ticker like NVDA or AAPL.`;

  const lines = [`${symbol}${profile?.name ? ` — ${profile.name}` : ""}`, ""];

  if (stock) {
    lines.push(
      `Exchange   ${money(stock.price)}  ${pct(stock.changePct)}`,
      `Day range  ${money(stock.low)} – ${money(stock.high)}`,
      `Prev close ${money(stock.previousClose)}`
    );
  }

  if (token) {
    const premium = await readPremium(symbol, token.address);
    lines.push(
      "",
      `On-chain   ${money(premium.tokenPriceUsd)}`,
      `Premium    ${pct(premium.premiumPct, 3)}`,
      `Liquidity  ${compact(premium.liquidityUsd)}`,
      `Volume 24h ${compact(premium.volume24hUsd)}`
    );
    if (token.multiplier !== 1) {
      lines.push("", `uiMultiplier ${token.multiplier.toFixed(8)} — raw balances misreport by ${pct((token.multiplier - 1) * 100, 4)}`);
    }
  } else {
    lines.push("", "Not tokenised on Robinhood Chain.");
  }

  if (status) {
    lines.push(
      "",
      status.isOpen
        ? "US market open — both prices live."
        : "US market closed — exchange price is the last close, so the premium is drift, not a spread."
    );
  }

  return lines.join("\n");
}

export async function cmdPremium(limit = 12): Promise<string> {
  const snapshot = await buildRadarSnapshot();
  const tokens = [...snapshot.tokens].sort((a, b) => b.holders - a.holders).slice(0, limit);

  // readPremium already carries the symbol, so it is not re-specified here.
  const rows = await Promise.all(tokens.map((t) => readPremium(t.symbol, t.address)));

  const priced = rows.filter((r) => r.premiumPct !== null);
  priced.sort((a, b) => Math.abs(b.premiumPct!) - Math.abs(a.premiumPct!));

  const avg = priced.length ? priced.reduce((s, r) => s + r.premiumPct!, 0) / priced.length : null;

  const body = priced
    .map((r) => `${r.symbol.padEnd(7)}${money(r.tokenPriceUsd).padStart(10)}${money(r.equityPriceUsd).padStart(10)}${pct(r.premiumPct, 3).padStart(10)}`)
    .join("\n");

  return [
    "Premium to underlying",
    "",
    `\`\`\`\n${"sym".padEnd(7)}${"onchain".padStart(10)}${"stock".padStart(10)}${"prem".padStart(10)}\n${body}\n\`\`\``,
    "",
    `Average ${pct(avg, 3)} across ${priced.length} tokens.`,
    priced[0]?.marketOpen
      ? "Market open — live spread."
      : "Market closed — drift since the bell, not a tradeable spread.",
  ].join("\n");
}

/**
 * Renders candles as a PNG URL via QuickChart.
 *
 * Telegram cannot render SVG, and bundling a rasteriser to draw one chart would
 * be heavier than the feature. QuickChart takes a chart spec in the query string
 * and returns an image that Telegram fetches itself — no key, no upload.
 */
export function chartImageUrl(candles: Candle[], symbol: string): string | null {
  if (candles.length < 2) return null;

  const points = candles.map((c) => ({
    x: new Date(c.time * 1000).toISOString(),
    y: Number(c.close.toFixed(6)),
  }));

  const config = {
    type: "line",
    data: {
      datasets: [
        {
          label: `${symbol} / USD`,
          data: points,
          borderColor: "#1f1a14",
          backgroundColor: "rgba(31,26,20,0.08)",
          borderWidth: 2,
          pointRadius: 0,
          fill: true,
          tension: 0.15,
        },
      ],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        xAxes: [{ type: "time", time: { unit: "hour" }, gridLines: { display: false }, ticks: { fontColor: "#8b7c68", maxTicksLimit: 6 } }],
        yAxes: [{ gridLines: { color: "#e3d7c1" }, ticks: { fontColor: "#8b7c68" } }],
      },
    },
  };

  const params = new URLSearchParams({
    c: JSON.stringify(config),
    w: "800",
    h: "400",
    bkg: "#fdfbf5",
    devicePixelRatio: "2",
  });
  return `https://quickchart.io/chart?${params.toString()}`;
}

export type ChartResult = { caption: string; imageUrl: string | null };

export async function cmdChart(symbol: string): Promise<ChartResult> {
  const token = await resolveToken(symbol);
  if (!token) return { caption: `${symbol} is not tokenised on Robinhood Chain.`, imageUrl: null };

  const pool = await fetchPrimaryPool(token.address);
  if (!pool) return { caption: `No liquidity pool found for ${symbol}.`, imageUrl: null };

  const candles = await fetchCandles(pool, "hour", 72);
  if (candles.length < 2) {
    return { caption: `No price history available for ${symbol}.`, imageUrl: null };
  }

  return { caption: chartBlock(candles, symbol), imageUrl: chartImageUrl(candles, symbol) };
}

export async function cmdNews(symbol: string): Promise<string> {
  const token = await resolveToken(symbol);
  const articles = await fetchTickerNews(symbol, token?.name, 6);

  if (articles.length === 0) return `No recent news found for ${symbol}.`;

  return [
    `${symbol} — latest`,
    "",
    ...articles.map((a, i) => {
      const when = a.publishedAt ? new Date(a.publishedAt * 1000).toISOString().slice(0, 10) : "";
      return `${i + 1}. ${a.headline}\n   ${a.source}${when ? ` · ${when}` : ""}\n   ${a.url}`;
    }),
  ].join("\n\n");
}

export async function cmdMarket(): Promise<string> {
  const [snapshot, global, status, quote] = await Promise.all([
    buildRadarSnapshot(),
    fetchGlobalMarket(),
    fetchMarketStatus(),
    fetchDexQuote("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168").catch(() => null),
  ]);

  const drifted = snapshot.tokens.filter((t) => t.severity === "drifted").length;
  const scheduled = snapshot.tokens.filter((t) => t.severity === "scheduled").length;

  const lines = [
    "Market overview",
    "",
    `US equities   ${status?.isOpen ? "open" : "closed"}${status?.holiday ? ` (${status.holiday})` : ""}`,
  ];

  if (global) {
    lines.push(
      `Crypto mcap   ${compact(global.totalMarketCapUsd)}  ${pct(global.change24hPct)}`,
      `BTC dominance ${global.btcDominance.toFixed(1)}%`
    );
  }
  if (quote) lines.push(`USDG          ${money(quote.priceUsd, 4)}`);

  lines.push(
    "",
    `Stock tokens  ${snapshot.tokens.length}`,
    `Misreporting  ${drifted}`,
    `Actions queued ${scheduled}`
  );

  return lines.join("\n");
}

export async function cmdSplits(): Promise<string> {
  const [snapshot, splits] = await Promise.all([buildRadarSnapshot(), fetchAnnouncedSplits()]);
  const matched = matchSplitsToTokens(
    splits,
    snapshot.tokens.map((t) => ({ symbol: t.symbol, address: t.address }))
  );

  const upcoming = splits.filter((s) => (s.daysUntil ?? -1) >= 0);

  if (matched.length === 0) {
    return [
      "Announced splits",
      "",
      `${upcoming.length} splits scheduled across US markets.`,
      "None affect a ticker that exists as a token on Robinhood Chain.",
      "",
      "Splits are the only corporate action that costs liquidity providers materially — a 4:1 takes 20% of pooled value. You will be alerted here if one lands on a tokenised name.",
    ].join("\n");
  }

  return [
    "Announced splits affecting tokenised names",
    "",
    ...matched.map(
      (m) =>
        `${m.symbol}  ${m.ratio}  in ${m.daysUntil} days (${m.executionDate})\n   LP loss if still pooled: ${(m.lpLossFraction * 100).toFixed(2)}%`
    ),
  ].join("\n\n");
}

export async function cmdToken(symbol: string): Promise<string> {
  const token = await resolveToken(symbol);
  if (!token) return `${symbol} is not tokenised on Robinhood Chain.`;

  const [recommendations, premium] = await Promise.all([
    fetchRecommendations(symbol).catch(() => []),
    readPremium(symbol, token.address),
  ]);

  const r = recommendations[0];

  return [
    `${token.symbol} — ${token.name}`,
    "",
    `Contract     ${token.address}`,
    `Holders      ${token.holders.toLocaleString()}`,
    `uiMultiplier ${token.multiplier.toFixed(8)}`,
    `Status       ${token.severity}`,
    "",
    `On-chain     ${money(premium.tokenPriceUsd)}`,
    `Exchange     ${money(premium.equityPriceUsd)}`,
    `Premium      ${pct(premium.premiumPct, 3)}`,
    `Liquidity    ${compact(premium.liquidityUsd)}`,
    r ? `\nAnalysts     ${r.strongBuy} strong buy · ${r.buy} buy · ${r.hold} hold · ${r.sell} sell` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function cmdChain(): Promise<string> {
  const { codexTopTokens } = await import("./codex");
  const snapshot = await buildRadarSnapshot().catch(() => null);
  const stockSymbols = new Set((snapshot?.tokens ?? []).map((t) => t.symbol.toUpperCase()));

  const { tokens, indexed } = await codexTopTokens("volume24", 12);
  if (!tokens.length) return "The on-chain index is not responding right now.";

  const rows = tokens.map((t) => {
    const tag = stockSymbols.has(t.symbol.toUpperCase()) ? "*" : " ";
    return `${tag}${t.symbol.padEnd(9)}${compact(t.volume24Usd).padStart(9)}${compact(t.liquidityUsd).padStart(9)}`;
  });

  const stockCount = tokens.filter((t) => stockSymbols.has(t.symbol.toUpperCase())).length;

  const header = `${"sym".padEnd(10)}${"vol24".padStart(9)}${"liq".padStart(9)}`;
  const table = ["```", header, ...rows, "```"].join("\n");

  return [
    "Every token on the chain, by 24h volume",
    "",
    table,
    "",
    `* = tokenised stock. Only ${stockCount} of the top ${tokens.length} are.`,
    indexed ? `Codex indexes ${indexed}+ tokens on this chain.` : "",
    "",
    "Volume far above liquidity means a thin pool traded repeatedly, not depth.",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function cmdFlow(symbol: string): Promise<string> {
  const { codexRecentSwaps, codexToken } = await import("./codex");
  const token = await resolveToken(symbol);
  if (!token) return `${symbol} is not tokenised on Robinhood Chain.`;

  const [detail, swaps] = await Promise.all([
    codexToken(token.address),
    codexRecentSwaps(token.address, 20),
  ]);

  const sized = swaps
    .filter((s) => s.valueUsd !== null && s.valueUsd > 0)
    .map((s) => s.valueUsd!)
    .sort((a, b) => a - b);
  const median = sized.length ? sized[Math.floor(sized.length / 2)] : null;
  const largest = sized.length ? sized[sized.length - 1] : null;

  const buys = swaps.filter((s) => s.side === "buy").length;
  const sells = swaps.filter((s) => s.side === "sell").length;

  return [
    `${symbol} — flow`,
    "",
    detail
      ? [
          `Aggregate liquidity  ${compact(detail.liquidityUsd)}`,
          `Volume 24h           ${compact(detail.volume24Usd)}`,
          `Transactions 24h     ${detail.txns24 ?? "?"}`,
          `Buys / sells         ${detail.buys24 ?? "?"} / ${detail.sells24 ?? "?"}`,
          `Holders              ${detail.holders?.toLocaleString() ?? "?"}`,
        ].join("\n")
      : "Aggregate metrics unavailable.",
    "",
    `Recent trades        ${swaps.length}${buys + sells > 0 ? `  (${buys} buy / ${sells} sell)` : ""}`,
    median !== null ? `Median trade size    ${money(median)}` : "",
    largest !== null ? `Largest              ${money(largest)}` : "",
    "",
    "Liquidity here is aggregated across every pool, so it exceeds any single-pool figure.",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function cmdDelegation(): Promise<string> {
  const { DELEGATES, DEFENSIVE_POLICY, verifyDelegateDeployed } = await import("./autonomous");
  const deployed = await Promise.all(DELEGATES.map(verifyDelegateDeployed));
  const scoped = deployed.filter((d) => d.deployed && d.scopedPermissions);

  return [
    "Autonomous tier — how it would work",
    "",
    "LIVE on mainnet, and proven by execution rather than configuration.",
    "The session key has withdrawn liquidity from a real position through redeemDelegations. The owner signed nothing.",
    "",
    `Delegate implementations deployed on this chain: ${deployed.filter((d) => d.deployed).length}`,
    `Of those, with scoped session keys: ${scoped.length}`,
    "",
    "Chosen: MetaMask stateless delegator.",
    "Probing showed ZeroDev Kernel has an initialize() function, leaving a window between delegation and initialisation in which anyone could seize the account. The stateless one has no such window.",
    "",
    "What a session key could ever do:",
    ...DEFENSIVE_POLICY.allowedActions.map((a) => `  ${a.selector} — ${a.reason}`),
    "",
    "What it could never do:",
    ...DEFENSIVE_POLICY.invariants.map((i) => `  ${i}`),
    "",
    DEFENSIVE_POLICY.worstCaseIfCompromised,
  ].join("\n");
}

/**
 * What an address holds, in tokenised shares.
 *
 * Reads `balanceOfUI` rather than `balanceOf`, which is the whole point: after a
 * split the raw balance misstates the holding by exactly the size of the
 * corporate action, and reporting that number is the failure this product
 * exists to warn people about.
 *
 * No profit or loss is shown. Nothing on chain records what anyone paid, and an
 * entry price inferred from transfers would be a guess presented as a fact.
 */
export async function cmdPortfolio(address: string): Promise<string> {
  const { isAddress } = await import("viem");
  const target = address.trim();

  if (!isAddress(target)) {
    return "Send an address: /portfolio 0x…\n\nI read the tokenised-share balances it holds, valued at both the token price and the price of the actual shares.";
  }

  const { readPortfolio } = await import("./portfolio");
  const { usd, signedPct, shortAddress } = await import("./format");
  const portfolio = await readPortfolio(target);

  if (portfolio.holdings.length === 0) {
    return [
      `${shortAddress(target)} holds no stock tokens.`,
      "",
      `Checked all ${portfolio.tokensChecked} on the chain.`,
    ].join("\n");
  }

  const lines = portfolio.holdings.map((h) => {
    const premium = h.premiumPct === null ? "" : `  ${signedPct(h.premiumPct, 2)} vs share`;
    return [
      `${h.symbol.padEnd(7)}${usd(h.valueUsd).padStart(12)}${premium}`,
      `  ${h.units.toLocaleString(undefined, { maximumFractionDigits: 4 })} @ ${usd(h.priceUsd)}${h.actionPending ? "   ⚠ action queued" : ""}`,
    ].join("\n");
  });

  const tail: string[] = ["", `Total${usd(portfolio.totalValueUsd).padStart(14)}`];

  if (portfolio.totalAtSharePriceUsd !== null) {
    const gap = portfolio.totalValueUsd - portfolio.totalAtSharePriceUsd;
    tail.push(
      `At share prices${usd(portfolio.totalAtSharePriceUsd).padStart(4)}`,
      "",
      gap >= 0
        ? `You are paying ${usd(gap)} above what these shares cost.`
        : `You are holding ${usd(Math.abs(gap))} below what these shares cost.`
    );
  } else if (portfolio.premiumIsStale) {
    // Saying nothing is better than quoting a gap against last night's close.
    tail.push("", "Equity market is shut — no premium, the reference would be a stale close.");
  }

  return [`${shortAddress(target)}`, "", ...lines, ...tail].join("\n");
}

export async function cmdPositions(): Promise<string> {
  const key = process.env.VELTR_DELEGATOR_PRIVATE_KEY;
  if (!key) return "No delegating account is configured.";

  const { privateKeyToAccount } = await import("viem/accounts");
  const { readPosition } = await import("./keeper");
  const owner = privateKeyToAccount(key as `0x${string}`).address;

  const res = await fetch(
    `https://robinhoodchain.blockscout.com/api/v2/addresses/${owner}/nft/collections?type=ERC-721`
  ).catch(() => null);
  if (!res?.ok) return "Could not read positions right now.";

  const collections = ((await res.json()).items ?? []) as {
    token?: { address_hash?: string };
    token_instances?: { id: string }[];
  }[];

  const posm = "0x73991a25c818bf1f1128deaab1492d45638de0d3";
  const ids = collections
    .filter((c) => (c.token?.address_hash ?? "").toLowerCase() === posm)
    .flatMap((c) => c.token_instances ?? [])
    .map((i) => i.id)
    .slice(0, 10);

  if (!ids.length) {
    return [
      "No Uniswap V3 positions held by the delegating account.",
      "",
      `Account: ${owner}`,
      "",
      "Nothing for the autonomous tier to defend right now.",
    ].join("\n");
  }

  const rows: string[] = [];
  for (const id of ids) {
    const p = await readPosition(BigInt(id));
    if (!p) continue;
    rows.push(
      `#${id}  liquidity ${p.liquidity.toString()}${p.liquidity === 0n ? "  (withdrawn)" : ""}`
    );
    if (p.owed0 > 0n || p.owed1 > 0n) rows.push(`      uncollected: ${p.owed0} / ${p.owed1}`);
  }

  return [
    "Positions the agent can defend",
    "",
    `Account ${owner}`,
    "",
    ...rows,
    "",
    "Ask me to act on one:",
    "  simulate exiting position <id>",
    "  exit position <id>",
    "  collect position <id>",
  ].join("\n");
}

/* -------------------------------------------------------- Intelligence */

/**
 * The intelligence commands.
 *
 * Each is a thin shell over lib/intel — the reading, scoring and wording all
 * live there so the same result can be served to the AI agent, the watch engine
 * and the daily brief without any of them re-deriving it.
 */

export async function cmdScan(query: string): Promise<string> {
  const { deepScan } = await import("./intel/scan");
  const { renderScan } = await import("./intel/format");

  const scan = await deepScan(query);
  if (!scan) return `${query} is not a token I can find on this chain. Try a ticker like NVDA, or a contract address.`;
  return renderScan(scan);
}

export async function cmdWhy(query: string): Promise<string> {
  const { explainMove } = await import("./intel/why");
  const { renderWhy } = await import("./intel/format");

  const report = await explainMove(query);
  if (!report) return `${query} is not a token I can find on this chain.`;
  return renderWhy(report);
}

export async function cmdPulse(): Promise<string> {
  const { readPulse } = await import("./intel/pulse");
  const { renderPulse } = await import("./intel/format");
  return renderPulse(await readPulse());
}

export async function cmdSmart(query: string): Promise<string> {
  const { readSmartMoney } = await import("./intel/smart-money");
  const { renderSmartMoney } = await import("./intel/format");

  const token = await resolveToken(query);
  const address = token?.address ?? (/^0x[a-fA-F0-9]{40}$/.test(query) ? query : null);
  if (!address) return `${query} is not a token I can find on this chain.`;

  return renderSmartMoney(await readSmartMoney(address, token?.symbol ?? null));
}

export async function cmdWallet(address: string): Promise<string> {
  const { isAddress } = await import("viem");
  if (!isAddress(address.trim())) {
    return "Send an address: /wallet 0x…\n\nI read its age, activity, holdings and what it has been trading.";
  }

  const { readWalletIntel } = await import("./intel/wallet");
  const { renderWallet } = await import("./intel/format");
  return renderWallet(await readWalletIntel(address.trim()));
}

export async function cmdRelated(query: string): Promise<string> {
  const { relatedTokens } = await import("./intel/relationships");
  const { renderRelationship } = await import("./intel/format");
  const { codexTopTokens } = await import("./codex");

  const token = await resolveToken(query);
  const address = token?.address ?? (/^0x[a-fA-F0-9]{40}$/.test(query) ? query : null);
  if (!address) return `${query} is not a token I can find on this chain.`;

  const { tokens } = await codexTopTokens("volume24", 12);
  const overlaps = await relatedTokens(
    { address, symbol: token?.symbol ?? null },
    tokens.map((t) => ({ address: t.address, symbol: t.symbol }))
  );

  if (overlaps.length === 0) {
    return [
      `No wallet overlap found for ${token?.symbol ?? query}.`,
      "",
      "Checked the most active tokens on the chain over the readable window. Either nothing is being traded by the same addresses, or the window was too quiet to tell.",
    ].join("\n");
  }

  return overlaps.slice(0, 2).map(renderRelationship).join("\n\n———\n\n");
}

/**
 * Signal delivery preferences.
 *
 * Reads and writes the same per-user settings record /settings already owns, so
 * there is one settings store rather than two. Off by default — a signal is an
 * unsolicited push, and switching a new class of those on for existing users
 * would be the wrong way to ship it.
 */
export async function cmdSignals(userId: string, argument: string): Promise<string> {
  const { getSettings, updateSettings } = await import("./watch/store");
  const { preferencesFrom, updatePreference, signalsEnabled } = await import("./intel/preferences");
  const { SIGNAL_KINDS } = await import("./intel/signals");

  const settings = await getSettings(userId);
  const arg = argument.trim();

  if (arg) {
    const [word, ...rest] = arg.split(/\s+/);
    const value = rest.join(" ");
    const field =
      word.toLowerCase() === "on" || word.toLowerCase() === "off"
        ? "signalsEnabled"
        : word.toLowerCase() === "confidence"
          ? "signalMinConfidence"
          : word.toLowerCase() === "cooldown"
            ? "signalCooldownSec"
            : word.toLowerCase() === "types"
              ? "signalKinds"
              : null;

    if (!field) {
      return [
        "Usage:",
        "  /signals on           start receiving signals",
        "  /signals off          stop",
        "  /signals confidence 70",
        "  /signals cooldown 6h",
        `  /signals types smart_money volume_spike   (or "all")`,
      ].join("\n");
    }

    const raw = field === "signalsEnabled" ? word : value;
    const result = updatePreference(field, raw);
    if (!result.ok) return result.error;

    await updateSettings(userId, result.patch as Partial<typeof settings>);
    return `Updated. ${await cmdSignals(userId, "")}`;
  }

  const prefs = preferencesFrom(settings);
  const on = signalsEnabled(settings);

  return [
    "VELTR SIGNALS",
    "",
    `Status      ${on ? "on" : "off"}`,
    on ? `Confidence  at least ${prefs.minConfidence}%` : "",
    on ? `Cooldown    ${Math.round(prefs.cooldownSec / 60)}m per signal per token` : "",
    on ? `Types       ${prefs.kinds.length ? prefs.kinds.join(", ") : "all"}` : "",
    "",
    on
      ? "Signals fire on the tokens you already watch. They are separate from your price thresholds — a signal is a pattern, not a level."
      : "Turn on with /signals on. Signals fire on tokens you already watch, reporting patterns rather than levels: wallet accumulation, volume regime changes, liquidity moves, whale prints.",
    "",
    `Types: ${SIGNAL_KINDS.join(", ")}`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * Chain-wide alert opt-out.
 *
 * Writes to the subscription record that /start already creates, so this is a
 * preference on the existing registry rather than a second one. Deliberately
 * does not touch personal watch alerts, signal preferences or the daily brief —
 * a user silencing chain-wide news has not asked to stop hearing about the token
 * they explicitly put on a watchlist.
 */
export async function cmdAlerts(userId: string, argument: string): Promise<string> {
  const { mutateState, readState } = await import("./store");
  const arg = argument.trim().toLowerCase();

  const describe = async () => {
    const state = await readState();
    const mine = state.subscriptions.find((s) => s.destination === userId);
    if (!mine) return "You are not subscribed. Send /start first.";

    const on = mine.globalAlerts !== false;
    return [
      "VELTR ALERTS",
      "",
      `Chain-wide alerts  ${on ? "ON" : "OFF"}`,
      "",
      on
        ? "You will hear from Veltr when something genuinely unusual happens on Robinhood Chain — smart-money accumulation, a volume or liquidity event, a whale print, or a security finding."
        : "Chain-wide alerts are off. Your token watches and their alerts are unaffected.",
      "",
      "These are rare by design: high confidence only, one token at a time, with a cooling-off period so the same event is never sent twice.",
      "",
      on ? "/alerts off to stop." : "/alerts on to resume.",
      "",
      "Separate from /watch (your own tokens) and /signals (per-token patterns).",
    ].join("\n");
  };

  if (arg === "on" || arg === "off") {
    const enabled = arg === "on";
    const found = await mutateState((state) => {
      const exists = state.subscriptions.some((s) => s.destination === userId);
      if (!exists) return { state, result: false };

      return {
        state: {
          ...state,
          subscriptions: state.subscriptions.map((s) =>
            s.destination === userId
              ? // Re-enabling also clears an unreachable mark: they are plainly reachable.
                { ...s, globalAlerts: enabled, undeliverableSince: enabled ? null : s.undeliverableSince }
              : s
          ),
        },
        result: true,
      };
    });

    if (!found) return "You are not subscribed. Send /start first.";
    return `${enabled ? "Chain-wide alerts on." : "Chain-wide alerts off."}\n\n${await describe()}`;
  }

  if (arg && arg !== "status") {
    return "Usage: /alerts on, /alerts off, or /alerts status";
  }

  return describe();
}

/* --------------------------------------------------------------- Router */

export const BOT_HELP = `Veltr — market terminal for Robinhood Chain.

INTELLIGENCE
/scan SYM       full read — price, depth, holders, flow, and
                six scores with the confidence behind each
/why SYM        what is moving it, separating what is measured
                from what is only consistent with the data
/pulse          the whole chain: momentum, movers, anomalies
/smart SYM      wallets accumulating or distributing right now
/wallet 0x…     an address: age, holdings, concentration, flow
/related SYM    tokens being traded by the same wallets
/signals        automatic alerts when a pattern appears on a
                token you watch — on, off, and your thresholds
/alerts         chain-wide alerts from Veltr, on by default —
                /alerts off to stop, /alerts status to check

MARKET
/price SYM      exchange price, on-chain price, premium
/premium        premium table across tokenised stocks
/chart SYM      price chart image from the deepest pool
/token SYM      multiplier, holders, liquidity, analysts
/news SYM       company headlines and SEC filings
/market         global crypto, chain state, session
/splits         announced splits that hit tokenised names

CHAIN
/chain          every token on the chain by volume
/flow SYM       live swap flow and trade sizes
/portfolio 0x…  tokenised shares an address holds, valued at
                both the token price and the real share price
/delegation     how the autonomous tier works

MISSIONS
/mission …      give me an objective, not steps. I decide what
                to observe, act only with your approval, and
                verify before reporting
/missions       your missions and anything awaiting approval
/every 1h …     run one on a schedule; silent unless figures move
/schedules      your recurring missions
/unschedule 1   stop one

CHANGE TRACKING
/track vercel/next.js   a repository — tells you when a commit lands
/track https://…        a page — tells you when the words change
/tracks                 what you are tracking
/untrack <target>       stop

TOKEN WATCH
/watch 0x…      monitor a token for price, MC, liquidity
                and volume moves — any contract on this chain
/watches        your watchlist, live
/unwatch 0x…    stop watching that token
/settings       thresholds, interval, cooldown, sources
/settings reset back to defaults

ALERTS
/watch 0x…      a wallet address instead scopes corporate-action
                alerts to the tokens that wallet holds
/unwatch        back to chain-wide alerts
/status         what Veltr is seeing right now
/cancel         abandon the request currently running
/stop           unsubscribe

FILES
Send me any text file — code, markdown, HTML, CSV, JSON —
and I will read it. Then ask for anything:
  explain what this does
  clean it up and send it back
  turn this into an HTML page
  find the bug
I write the file and send it back as a real document.

ASK ANYTHING
Just type a question. I can search the live web, read any
URL, analyse a GitHub repository, pull global crypto data,
and act — send a chart, change your alert scope, write a
file, or defend a liquidity position on-chain.

Try:
  why is NVDA above its stock price?
  show me the AAPL chart
  what is actually trading on this chain?
  is Robinhood planning more tokenised assets?`;

/**
 * First contact. Identical for everyone.
 *
 * Static on purpose. The previous version pulled live chain state and inserted
 * the reader's name, which meant the most important message the bot ever sends
 * varied per person, took fifteen seconds to assemble, and had a fallback that
 * said something different again when the read failed.
 *
 * It leads with the problem rather than the feature list, because a new reader
 * does not yet know why any of the features would matter. Then what it does,
 * then — the part that separates this from every other bot with a language model
 * behind it — why its numbers can be trusted.
 */
export const INTRODUCTION = `Veltr Agent — an autonomous analyst for Robinhood Chain.

I read the chain directly, watch whatever you point me at, and act only with your approval. Not a command menu with a language model attached: I work out which of my tools a question needs, call several at once, and do the thing rather than telling you which command to type.

WHY THIS EXISTS

Robinhood Chain trades US equities as tokens, 24 hours a day, while the exchanges behind them are shut most of the week.

Those tokens never rebase. When a company splits its stock or pays a dividend, the chain moves a hidden multiplier — and your balance stays exactly the number it always was.

So your wallet shows one figure and you own another. No wallet, tracker or tax export reports the gap, because they all read balanceOf, and balanceOf stopped being the truth.

The median warning before one of these lands, measured across every action this chain has recorded, is about ten minutes. Nobody watches a screen for that.

WHAT I DO

Ask me anything, in plain language.
   why is NVDA trading above its stock price?
   what is actually trading on this chain?
   read vercel/next.js and explain the architecture

Watch a token — any token, a tokenised stock or a memecoin.
   /watch 0x…       price, market cap, liquidity, volume
   /settings        your thresholds, your intervals, your sources
An alert fires once per move, not once per poll. Cross +10% and keep climbing and you hear from me exactly once.

Track what changes.
   /track vercel/next.js      when a commit lands
   /track https://…           when the words on a page change
Silence unless something actually changed. Clocks and timestamps do not count as change.

Give me an objective, not a list of steps.
   /mission investigate why the premium went negative
I work out what to observe, gather it, reason over it, and ask before doing anything consequential.

Send me a file — code, markdown, CSV, HTML. I read it, and I can send one back.

WHY THE NUMBERS ARE WORTH ANYTHING

Every figure comes from a tool call. I have no path to inventing a price — if a source is down I tell you it is down rather than estimating.

A conclusion has to cite the observation behind it. One that cannot is thrown away, and you get "the evidence is not sufficient" instead of a confident guess.

I do not report an action as done until a second, independent read confirms it. If I say a file was sent, a file was sent.

Anything consequential asks you first. Every time, with no override.

ALERTS ARE ON

Important Robinhood Chain alerts are enabled by default — smart-money accumulation, unusual volume or liquidity, whale prints, security findings. They are rare on purpose: high confidence only, with a cooling-off period so nothing repeats.

   /alerts off   stop them
   /alerts       check the setting

START HERE

   /scan NVDA    the full read on one token
   /pulse        the whole chain right now
   /market       what the whole market looks like now
   /price NVDA   one name, both prices, the gap between them
   /watch 0x…    monitor a token
   /help         everything I can do

I hold no funds and cannot move your assets. Informational only — not investment, tax or legal advice. Stock tokens on this chain are debt securities, not equity: holders receive no shareholder rights.`;

export type CommandResult =
  | { text: string; imageUrl?: string | null; handled: true }
  | { handled: false };

/**
 * Resolves a slash command. Anything unrecognised falls through to the agent,
 * so the bot answers plain questions rather than rejecting them.
 */
export async function runCommand(raw: string, userId?: string): Promise<CommandResult> {
  const text = raw.trim();
  if (!text.startsWith("/")) return { handled: false };

  const [rawCmd, ...rest] = text.split(/\s+/);
  const cmd = rawCmd.toLowerCase().split("@")[0];
  const arg = rest.join(" ").trim().toUpperCase();

  const needsSymbol = (name: string) => `Usage: ${name} SYMBOL\nExample: ${name} NVDA`;

  try {
    switch (cmd) {
      case "/help":
        return { text: BOT_HELP, handled: true };
      case "/price":
        return { text: arg ? await cmdPrice(arg) : needsSymbol("/price"), handled: true };
      case "/chart": {
        if (!arg) return { text: needsSymbol("/chart"), handled: true };
        const chart = await cmdChart(arg);
        return { text: chart.caption, imageUrl: chart.imageUrl, handled: true };
      }
      case "/news":
        return { text: arg ? await cmdNews(arg) : needsSymbol("/news"), handled: true };
      case "/token":
        return { text: arg ? await cmdToken(arg) : needsSymbol("/token"), handled: true };
      case "/premium":
        return { text: await cmdPremium(), handled: true };
      case "/market":
        return { text: await cmdMarket(), handled: true };
      case "/splits":
        return { text: await cmdSplits(), handled: true };
      case "/chain":
        return { text: await cmdChain(), handled: true };
      case "/flow":
        return { text: arg ? await cmdFlow(arg) : needsSymbol("/flow"), handled: true };
      case "/delegation":
        return { text: await cmdDelegation(), handled: true };
      case "/positions":
        return { text: await cmdPositions(), handled: true };
      case "/portfolio":
        return { text: await cmdPortfolio(arg ?? ""), handled: true };
      case "/scan":
        return { text: arg ? await cmdScan(arg) : needsSymbol("/scan"), handled: true };
      case "/why":
        return { text: arg ? await cmdWhy(arg) : needsSymbol("/why"), handled: true };
      case "/pulse":
        return { text: await cmdPulse(), handled: true };
      case "/smart":
        return { text: arg ? await cmdSmart(arg) : needsSymbol("/smart"), handled: true };
      case "/related":
        return { text: arg ? await cmdRelated(arg) : needsSymbol("/related"), handled: true };
      case "/wallet":
        // Addresses are case-sensitive in display; `arg` has been upper-cased.
        return { text: await cmdWallet(rest.join(" ").trim()), handled: true };
      case "/alerts":
        return {
          text: userId
            ? await cmdAlerts(userId, rest.join(" ").trim())
            : "Alert preferences are per-user — send this from a chat.",
          handled: true,
        };
      case "/signals":
        // Preferences are per-user, so without a chat id there is nothing to read.
        return {
          text: userId
            ? await cmdSignals(userId, rest.join(" ").trim())
            : "Signal preferences are per-user — send this from a chat.",
          handled: true,
        };
      default:
        return { handled: false };
    }
  } catch (error) {
    console.error(`[veltr] command ${cmd} failed:`, error);
    return { text: "That lookup failed. The data source may be rate-limiting — try again shortly.", handled: true };
  }
}
