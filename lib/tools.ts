import { isAddress, type Address } from "viem";
import { buildRadarSnapshot } from "./tokens";
import { readPremium, fetchPrimaryPool, fetchCandles, fetchGlobalMarket } from "./market";
import { fetchStockQuote, fetchCompanyProfile, fetchMarketStatus, fetchRecommendations } from "./stocks";
import { fetchTickerNews, fetchFilings } from "./news";
import { fetchAnnouncedSplits, matchSplitsToTokens } from "./splits-calendar";
import { fetchCorporateActions } from "./events";
import { readHolderBalances } from "./chain";
import { findLpPositions } from "./lp-positions";
import { chartImageUrl } from "./bot-commands";
import { readState, writeState } from "./store";
import { sendPhoto } from "./notify";
import { EXTENDED_TOOLS } from "./tools-extended";

/**
 * Tools the agent may call.
 *
 * Two categories, deliberately separated:
 *
 *  - READ tools return live data. They cannot change anything, so the model may
 *    call them freely and in any order.
 *  - ACT tools change something the caller owns: what appears in their chat, or
 *    which wallet their alerts are scoped to. Every one is reversible, affects
 *    only the caller, and never touches funds.
 *
 * Nothing here can move an asset. Execution against a wallet stays behind the
 * EIP-7702 session key, which the model has no access to.
 */

export type ToolContext = {
  /** Telegram chat the request came from, when there is one. */
  chatId?: string | null;
};

type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;

export type ToolSpec = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: ToolHandler;
  /** Act tools are reported back to the user so an action is never silent. */
  acts?: boolean;
};

const str = (v: unknown): string => String(v ?? "").trim();
const sym = (v: unknown): string => str(v).toUpperCase();

async function findToken(symbol: string) {
  const snapshot = await buildRadarSnapshot();
  return snapshot.tokens.find((t) => t.symbol.toUpperCase() === symbol.toUpperCase()) ?? null;
}

export const TOOLS: ToolSpec[] = [
  {
    name: "get_price",
    description:
      "Live price for a ticker: the exchange price of the underlying equity, the on-chain token price, and the premium between them. Use for any question about what something costs or how far a token has dislocated.",
    parameters: {
      type: "object",
      properties: { symbol: { type: "string", description: "Ticker, e.g. NVDA" } },
      required: ["symbol"],
    },
    async handler(args) {
      const symbol = sym(args.symbol);
      const [token, quote, profile, status] = await Promise.all([
        findToken(symbol),
        fetchStockQuote(symbol),
        fetchCompanyProfile(symbol),
        fetchMarketStatus(),
      ]);

      if (!token && !quote) return { error: `No data for ${symbol}.` };

      const premium = token ? await readPremium(symbol, token.address) : null;

      return {
        symbol,
        company: profile?.name ?? null,
        exchangePrice: quote?.price ?? null,
        exchangeChangePct: quote?.changePct ?? null,
        previousClose: quote?.previousClose ?? null,
        onChainPrice: premium?.tokenPriceUsd ?? null,
        premiumPct: premium?.premiumPct ?? null,
        liquidityUsd: premium?.liquidityUsd ?? null,
        volume24hUsd: premium?.volume24hUsd ?? null,
        tokenised: Boolean(token),
        marketOpen: status?.isOpen ?? null,
        note: status?.isOpen
          ? "Both prices are live."
          : "Equity market closed — the exchange price is a stale close, so the premium is drift, not a tradeable spread.",
      };
    },
  },

  {
    name: "get_token",
    description:
      "On-chain state of a stock token: ERC-8056 multiplier, whether raw balances misreport exposure, holder count, contract address, and any scheduled corporate action.",
    parameters: {
      type: "object",
      properties: { symbol: { type: "string" } },
      required: ["symbol"],
    },
    async handler(args) {
      const symbol = sym(args.symbol);
      const token = await findToken(symbol);
      if (!token) return { error: `${symbol} is not tokenised on Robinhood Chain.` };

      return {
        symbol: token.symbol,
        name: token.name,
        address: token.address,
        holders: token.holders,
        uiMultiplier: token.multiplier,
        reportingErrorPct: token.reportingErrorPct,
        status: token.severity,
        pendingMultiplier: token.pendingMultiplier,
        hoursUntilEffective: token.hoursUntilEffective,
        explanation:
          token.multiplier === 1
            ? "Multiplier is 1.0, so raw balance equals true exposure."
            : `Multiplier is ${token.multiplier}, so any interface reading balanceOf understates exposure by ${token.reportingErrorPct.toFixed(4)}%.`,
      };
    },
  },

  {
    name: "search_tokens",
    description:
      "List or filter the stock tokens on Robinhood Chain. Use to answer questions about which tokens exist, which are misreporting, or which have the most holders.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional text to match against symbol or name" },
        status: {
          type: "string",
          enum: ["all", "drifted", "scheduled", "clear"],
          description: "Filter by multiplier state",
        },
        limit: { type: "number" },
      },
    },
    async handler(args) {
      const snapshot = await buildRadarSnapshot();
      const query = str(args.query).toLowerCase();
      const status = str(args.status) || "all";
      const limit = Math.min(Number(args.limit) || 20, 50);

      const matched = snapshot.tokens
        .filter((t) => (status === "all" ? true : t.severity === status))
        .filter((t) =>
          query ? t.symbol.toLowerCase().includes(query) || t.name.toLowerCase().includes(query) : true
        )
        .sort((a, b) => b.holders - a.holders)
        .slice(0, limit)
        .map((t) => ({
          symbol: t.symbol,
          name: t.name,
          holders: t.holders,
          uiMultiplier: t.multiplier,
          status: t.severity,
        }));

      return { total: snapshot.tokens.length, matched: matched.length, tokens: matched };
    },
  },

  {
    name: "get_news",
    description:
      "Recent company headlines and SEC 8-K filings for a ticker. Use when asked why something moved, or what is happening with a company.",
    parameters: {
      type: "object",
      properties: { symbol: { type: "string" } },
      required: ["symbol"],
    },
    async handler(args) {
      const symbol = sym(args.symbol);
      const token = await findToken(symbol);
      const [articles, filings] = await Promise.all([
        fetchTickerNews(symbol, token?.name, 8),
        fetchFilings(symbol, 4),
      ]);
      return {
        symbol,
        articles: articles.map((a) => ({
          headline: a.headline,
          source: a.source,
          url: a.url,
          publishedAt: a.publishedAt ? new Date(a.publishedAt * 1000).toISOString() : null,
        })),
        filings: filings.map((f) => ({ title: f.headline, url: f.url })),
      };
    },
  },

  {
    name: "get_market",
    description:
      "Overall market state: US equity session, global crypto market cap and dominance, and how many stock tokens are currently misreporting or have actions queued.",
    parameters: { type: "object", properties: {} },
    async handler() {
      const [snapshot, global, status] = await Promise.all([
        buildRadarSnapshot(),
        fetchGlobalMarket(),
        fetchMarketStatus(),
      ]);
      return {
        equityMarket: status ? { open: status.isOpen, session: status.session, holiday: status.holiday } : null,
        globalCrypto: global,
        chain: {
          stockTokens: snapshot.tokens.length,
          misreporting: snapshot.tokens.filter((t) => t.severity === "drifted").length,
          actionsQueued: snapshot.tokens.filter((t) => t.severity === "scheduled").length,
        },
      };
    },
  },

  {
    name: "compare_premiums",
    description:
      "Premium to underlying across the most-held stock tokens. Use to find the widest dislocations or to answer 'which token is most mispriced'.",
    parameters: {
      type: "object",
      properties: { limit: { type: "number", description: "How many tokens, default 10, max 20" } },
    },
    async handler(args) {
      const limit = Math.min(Number(args.limit) || 10, 20);
      const snapshot = await buildRadarSnapshot();
      const tokens = [...snapshot.tokens].sort((a, b) => b.holders - a.holders).slice(0, limit);
      const rows = await Promise.all(tokens.map((t) => readPremium(t.symbol, t.address)));

      const priced = rows.filter((r) => r.premiumPct !== null);
      priced.sort((a, b) => Math.abs(b.premiumPct!) - Math.abs(a.premiumPct!));

      return {
        marketOpen: rows[0]?.marketOpen ?? null,
        averagePremiumPct:
          priced.length > 0 ? priced.reduce((s, r) => s + r.premiumPct!, 0) / priced.length : null,
        tokens: priced.map((r) => ({
          symbol: r.symbol,
          onChain: r.tokenPriceUsd,
          exchange: r.equityPriceUsd,
          premiumPct: r.premiumPct,
          liquidityUsd: r.liquidityUsd,
        })),
      };
    },
  },

  {
    name: "get_wallet_exposure",
    description:
      "Audit an address: which stock tokens it holds, and the gap between the raw balance a wallet displays and true ERC-8056 exposure. Also returns liquidity positions exposed to a split.",
    parameters: {
      type: "object",
      properties: { address: { type: "string", description: "0x… EVM address" } },
      required: ["address"],
    },
    async handler(args) {
      const address = str(args.address);
      if (!isAddress(address)) return { error: "Not a valid EVM address." };

      const snapshot = await buildRadarSnapshot();
      const balances = await readHolderBalances(
        address as Address,
        snapshot.tokens.map((t) => t.address)
      );

      const held = balances
        .map((b, i) => ({ token: snapshot.tokens[i], ...b }))
        .filter((b) => b.raw > 0n)
        .map((b) => {
          const raw = Number(b.raw) / 1e18;
          const effective = b.effective > 0n ? Number(b.effective) / 1e18 : raw * b.token.multiplier;
          return {
            symbol: b.token.symbol,
            rawBalance: raw,
            trueExposure: effective,
            unreported: effective - raw,
            valueUsd: b.token.priceUsd ? effective * b.token.priceUsd : null,
          };
        })
        .sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));

      const lp = await findLpPositions(
        address as Address,
        new Map(snapshot.tokens.map((t) => [t.address.toLowerCase(), t.symbol]))
      ).catch(() => []);

      return {
        address,
        positions: held.slice(0, 25),
        positionCount: held.length,
        portfolioUsd: held.reduce((s, p) => s + (p.valueUsd ?? 0), 0),
        misreportedCount: held.filter((p) => Math.abs(p.unreported) > 1e-12).length,
        liquidityPositions: lp.map((p) => ({
          version: p.version,
          tokenId: p.tokenId,
          stockSymbol: p.stockSymbol,
          lossIfFourToOneSplit: `${(p.splitLossFraction * 100).toFixed(2)}%`,
        })),
      };
    },
  },

  {
    name: "get_corporate_actions",
    description:
      "History of corporate actions applied on-chain (splits and distributions), including how long before taking effect each was committed. Optionally filtered to one ticker.",
    parameters: {
      type: "object",
      properties: { symbol: { type: "string", description: "Optional ticker filter" } },
    },
    async handler(args) {
      const snapshot = await buildRadarSnapshot();
      const actions = await fetchCorporateActions(
        snapshot.tokens.map((t) => ({ address: t.address, symbol: t.symbol }))
      );
      const symbol = sym(args.symbol);
      const filtered = symbol ? actions.filter((a) => a.symbol?.toUpperCase() === symbol) : actions;

      return {
        count: filtered.length,
        actions: filtered.slice(0, 15).map((a) => ({
          symbol: a.symbol,
          kind: a.kind,
          from: a.oldMultiplier,
          to: a.newMultiplier,
          changePct: a.deltaPct,
          effectiveAt: new Date(a.effectiveAt * 1000).toISOString(),
          warningWindowHours: Number(a.leadTimeHours.toFixed(2)),
        })),
      };
    },
  },

  {
    name: "get_announced_splits",
    description:
      "Splits announced in US markets and whether any land on a ticker that exists as a token here. Splits are the only corporate action that materially harms liquidity providers.",
    parameters: { type: "object", properties: {} },
    async handler() {
      const [snapshot, splits] = await Promise.all([buildRadarSnapshot(), fetchAnnouncedSplits()]);
      const matched = matchSplitsToTokens(
        splits,
        snapshot.tokens.map((t) => ({ symbol: t.symbol, address: t.address }))
      );
      return {
        announcedTotal: splits.filter((s) => (s.daysUntil ?? -1) >= 0).length,
        affectingTokens: matched.map((m) => ({
          symbol: m.symbol,
          ratio: m.ratio,
          executionDate: m.executionDate,
          daysUntil: m.daysUntil,
          lpLossIfStillPooled: `${(m.lpLossFraction * 100).toFixed(2)}%`,
        })),
      };
    },
  },

  {
    name: "get_analyst_view",
    description: "Analyst ratings distribution for a ticker.",
    parameters: {
      type: "object",
      properties: { symbol: { type: "string" } },
      required: ["symbol"],
    },
    async handler(args) {
      const symbol = sym(args.symbol);
      const recs = await fetchRecommendations(symbol);
      if (recs.length === 0) return { error: `No analyst coverage found for ${symbol}.` };
      // `latest` already carries `period`, so spreading it is enough.
      return { symbol, ...recs[0] };
    },
  },

  /* ------------------------------------------------------------- ACT tools */

  {
    name: "send_chart",
    description:
      "Send a price chart image of a token to the user's chat. Call this when the user asks to see or be shown a chart, rather than describing the price in words.",
    acts: true,
    parameters: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        hours: { type: "number", description: "How many hours of history, default 72, max 168" },
      },
      required: ["symbol"],
    },
    async handler(args, ctx) {
      if (!ctx.chatId) return { error: "No chat to send an image to in this context." };

      const symbol = sym(args.symbol);
      const hours = Math.min(Math.max(Number(args.hours) || 72, 12), 168);

      const token = await findToken(symbol);
      if (!token) return { error: `${symbol} is not tokenised on Robinhood Chain.` };

      const pool = await fetchPrimaryPool(token.address);
      if (!pool) return { error: `No pool found for ${symbol}.` };

      const candles = await fetchCandles(pool, "hour", hours);
      const url = chartImageUrl(candles, symbol);
      if (!url) return { error: `No price history available for ${symbol}.` };

      const last = candles[candles.length - 1].close;
      const first = candles[0].close;
      const changePct = first > 0 ? (last / first - 1) * 100 : 0;

      const sent = await sendPhoto(
        ctx.chatId,
        url,
        `${symbol} · last ${candles.length}h · $${last.toFixed(2)} (${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%)`
      );

      return sent
        ? { sent: true, symbol, hours: candles.length, lastPrice: last, changePct }
        : { error: "The image could not be delivered." };
    },
  },

  {
    name: "set_alert_scope",
    description:
      "Scope the user's alerts to a wallet, so they are only notified about tokens that address actually holds and each alert is rewritten in terms of their own position. Pass address as null to return to chain-wide alerts.",
    acts: true,
    parameters: {
      type: "object",
      properties: {
        address: { type: ["string", "null"], description: "0x… address, or null for chain-wide" },
      },
      required: ["address"],
    },
    async handler(args, ctx) {
      if (!ctx.chatId) return { error: "No subscription to modify in this context." };

      const raw = args.address === null ? null : str(args.address);
      if (raw !== null && !isAddress(raw)) return { error: "Not a valid EVM address." };

      const state = await readState();
      const subscription = state.subscriptions.find((s) => s.destination === ctx.chatId);
      if (!subscription) return { error: "Not subscribed. The user should send /start first." };

      const updated = state.subscriptions.map((s) =>
        s.destination === ctx.chatId ? { ...s, address: raw } : s
      );
      await writeState({ ...state, subscriptions: updated });

      return raw
        ? { scope: raw, message: `Alerts now scoped to ${raw}.` }
        : { scope: "chain-wide", message: "Alerts now cover all stock tokens on the chain." };
    },
  },

  {
    name: "get_alert_status",
    description: "What the user is currently subscribed to and what Veltr last observed on-chain.",
    parameters: { type: "object", properties: {} },
    async handler(_args, ctx) {
      const state = await readState();
      const subscription = ctx.chatId
        ? state.subscriptions.find((s) => s.destination === ctx.chatId)
        : null;

      return {
        subscribed: Boolean(subscription),
        scope: subscription?.address ?? "chain-wide",
        tokensTracked: Object.keys(state.lastMultiplier).length,
        actionsQueued: Object.values(state.lastPending).filter((v) => v !== null).length,
        lastCheckedAt: state.lastRunAt,
      };
    },
  },
];

// Extended tools live in their own module so the core set stays readable; they
// are merged here so callers see one registry.
const ALL_TOOLS: ToolSpec[] = [...TOOLS, ...EXTENDED_TOOLS];

const BY_NAME = new Map(ALL_TOOLS.map((t) => [t.name, t]));

/** OpenAI-compatible tool schema for the request payload. */
export function toolSchemas() {
  return ALL_TOOLS.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export type ToolInvocation = { name: string; args: Record<string, unknown>; acted: boolean; result: unknown };

/** Runs one tool call, converting any failure into data the model can reason about. */
export async function invokeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolInvocation> {
  const spec = BY_NAME.get(name);
  if (!spec) return { name, args, acted: false, result: { error: `Unknown tool: ${name}` } };

  try {
    const result = await spec.handler(args, ctx);
    return { name, args, acted: Boolean(spec.acts), result };
  } catch (error) {
    console.error(`[veltr] tool ${name} failed:`, error);
    return {
      name,
      args,
      acted: false,
      result: { error: error instanceof Error ? error.message : "Tool execution failed." },
    };
  }
}
