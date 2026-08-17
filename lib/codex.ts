import { cached } from "./cache";

/**
 * Codex (Defined) — the deepest on-chain source available for this chain.
 *
 * Chosen over DexScreener and GeckoTerminal for anything requiring aggregate or
 * flow data: Codex reports NVDA's liquidity as roughly $11.8M across every pool,
 * where DexScreener reports only the single deepest pool at about $1.4M. It also
 * carries trade counts, buy/sell splits and live swap events that neither of the
 * keyless sources expose.
 *
 * Plan ceiling, established by probe: the `holders` list endpoint returns
 * "Not authorized: please upgrade your plan". Holder *counts* are available;
 * the ranked list of individual holders is not.
 */

export const ROBINHOOD_NETWORK_ID = 4663;

const URL = process.env.CODEX_GRAPHQL_URL || "https://graph.codex.io/graphql";

type GqlResult<T> = { data?: T; errors?: { message: string }[] };

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T | null> {
  const key = process.env.CODEX_API_KEY;
  if (!key) return null;

  try {
    const res = await fetch(URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: key },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;

    const json = (await res.json()) as GqlResult<T>;
    if (json.errors?.length) {
      console.warn("[veltr] codex:", json.errors.map((e) => e.message).join("; ").slice(0, 200));
      return null;
    }
    return json.data ?? null;
  } catch (error) {
    console.warn("[veltr] codex request failed:", error);
    return null;
  }
}

export type CodexToken = {
  address: string;
  symbol: string;
  name: string;
  priceUsd: number | null;
  liquidityUsd: number | null;
  volume24Usd: number | null;
  marketCapUsd: number | null;
  holders: number | null;
  txns24: number | null;
  buys24: number | null;
  sells24: number | null;
  change24Pct: number | null;
};

type FilterResult = {
  filterTokens?: {
    count?: number;
    results?: {
      token?: { address?: string; symbol?: string; name?: string };
      priceUSD?: string;
      liquidity?: string;
      volume24?: string;
      marketCap?: string;
      holders?: number;
      txnCount24?: number;
      uniqueBuys24?: number;
      uniqueSells24?: number;
      change24?: string;
    }[];
  };
};

const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function shape(r: NonNullable<NonNullable<FilterResult["filterTokens"]>["results"]>[number]): CodexToken {
  return {
    address: r.token?.address ?? "",
    symbol: r.token?.symbol ?? "?",
    name: r.token?.name ?? "",
    priceUsd: num(r.priceUSD),
    liquidityUsd: num(r.liquidity),
    volume24Usd: num(r.volume24),
    marketCapUsd: num(r.marketCap),
    holders: r.holders ?? null,
    txns24: r.txnCount24 ?? null,
    buys24: r.uniqueBuys24 ?? null,
    sells24: r.uniqueSells24 ?? null,
    // Codex returns change as a ratio, not a percentage.
    change24Pct: num(r.change24) === null ? null : num(r.change24)! * 100,
  };
}

const TOKEN_FIELDS = `
  token { address name symbol }
  priceUSD
  liquidity
  volume24
  marketCap
  holders
  txnCount24
  uniqueBuys24
  uniqueSells24
  change24
`;

/** Full market detail for one token, aggregated across every pool. */
export async function codexToken(address: string): Promise<CodexToken | null> {
  return cached(
    `codex:token:${address.toLowerCase()}`,
    60_000,
    async () => {
      const data = await gql<FilterResult>(
        `query($net: Int!, $addr: String!) {
          filterTokens(filters: { network: [$net] }, phrase: $addr, limit: 1) {
            results { ${TOKEN_FIELDS} }
          }
        }`,
        { net: ROBINHOOD_NETWORK_ID, addr: address }
      );
      const first = data?.filterTokens?.results?.[0];
      return first ? shape(first) : null;
    },
    (v) => v !== null
  );
}

export type RankAttribute = "volume24" | "liquidity" | "marketCap" | "holders" | "txnCount24";

/**
 * Every token on the chain, ranked.
 *
 * Codex pages at ten results, so the full listing is assembled by walking
 * offsets rather than asking for a large limit — which silently returns ten.
 */
export async function codexTopTokens(
  attribute: RankAttribute = "volume24",
  limit = 50
): Promise<{ tokens: CodexToken[]; indexed: number }> {
  return cached(
    `codex:top:${attribute}:${limit}`,
    2 * 60_000,
    async () => {
      const tokens: CodexToken[] = [];
      let indexed = 0;

      for (let offset = 0; tokens.length < limit && offset < 200; offset += 10) {
        const data = await gql<FilterResult>(
          `query($net: Int!, $attr: TokenRankingAttribute!, $offset: Int!) {
            filterTokens(
              filters: { network: [$net] }
              rankings: { attribute: $attr, direction: DESC }
              limit: 10
              offset: $offset
            ) {
              count
              results { ${TOKEN_FIELDS} }
            }
          }`,
          { net: ROBINHOOD_NETWORK_ID, attr: attribute, offset }
        );

        const page = data?.filterTokens?.results ?? [];
        indexed = data?.filterTokens?.count ?? indexed;
        if (page.length === 0) break;
        tokens.push(...page.map(shape));
      }

      return { tokens: tokens.slice(0, limit), indexed };
    },
    (v) => v.tokens.length > 0
  );
}

export type CodexBar = { time: number; open: number; high: number; low: number; close: number };

/** OHLCV bars. `resolution` is in minutes, or "1D" / "1W". */
export async function codexBars(
  address: string,
  resolution = "60",
  hours = 72
): Promise<CodexBar[]> {
  return cached(
    `codex:bars:${address.toLowerCase()}:${resolution}:${hours}`,
    120_000,
    async () => {
      const to = Math.floor(Date.now() / 1000);
      const from = to - hours * 3600;

      type Bars = { getBars?: { o?: number[]; h?: number[]; l?: number[]; c?: number[]; t?: number[] } };
      const data = await gql<Bars>(
        `query($symbol: String!, $from: Int!, $to: Int!, $res: String!) {
          getBars(symbol: $symbol, from: $from, to: $to, resolution: $res, removeLeadingNullValues: true) {
            o h l c t
          }
        }`,
        { symbol: `${address}:${ROBINHOOD_NETWORK_ID}`, from, to, res: resolution }
      );

      const b = data?.getBars;
      if (!b?.t?.length) return [];

      return b.t
        .map((time, i) => ({
          time,
          open: b.o?.[i] ?? 0,
          high: b.h?.[i] ?? 0,
          low: b.l?.[i] ?? 0,
          close: b.c?.[i] ?? 0,
        }))
        .filter((bar) => bar.close > 0);
    },
    (v) => v.length > 0
  );
}

export type CodexSwap = {
  type: string;
  /** Unix seconds. */
  timestamp: number;
  /**
   * Size of the trade in US dollars.
   *
   * From `priceUsdTotal`. The neighbouring `token0SwapValueUsd` /
   * `token1SwapValueUsd` are *unit prices* rather than trade values — on an
   * NVDA/USDG pool they read $1.00 and $225.69 no matter how large the trade —
   * and reading them as a size is the bug this field replaced. Cross-checked
   * against `amountNonLiquidityToken × priceUsd` on live events, to the cent.
   */
  valueUsd: number | null;
  /** Token units moved, ignoring the stablecoin side. */
  units: number | null;
  /** Unit price at the moment of the trade. */
  priceUsd: number | null;
  maker: string | null;
  txHash: string | null;
  /**
   * Which side the maker took.
   *
   * Straight from `eventDisplayType`, which labels Buy/Sell explicitly — no
   * inference from amount signs, which would silently invert accumulation into
   * distribution on any pool whose token ordering differs.
   */
  side: "buy" | "sell" | null;
};

type EventItem = {
  eventType?: string;
  eventDisplayType?: string;
  timestamp?: number;
  maker?: string;
  transactionHash?: string;
  data?: {
    priceUsd?: string;
    priceUsdTotal?: string;
    amountNonLiquidityToken?: string;
  };
};

type EventsResult = { getTokenEvents?: { items?: EventItem[]; cursor?: string | null } };

const EVENT_FIELDS = `
  eventType
  eventDisplayType
  timestamp
  maker
  transactionHash
  data {
    ... on SwapEventData { priceUsd priceUsdTotal amountNonLiquidityToken }
  }
`;

function shapeSwap(e: EventItem): CodexSwap {
  const display = (e.eventDisplayType ?? "").toLowerCase();
  return {
    type: e.eventType ?? "Swap",
    timestamp: e.timestamp ?? 0,
    valueUsd: num(e.data?.priceUsdTotal),
    units: num(e.data?.amountNonLiquidityToken),
    priceUsd: num(e.data?.priceUsd),
    maker: e.maker ? e.maker.toLowerCase() : null,
    txHash: e.transactionHash ?? null,
    side: display === "buy" ? "buy" : display === "sell" ? "sell" : null,
  };
}

/** Recent swaps — the flow data no keyless source on this chain provides. */
export async function codexRecentSwaps(address: string, limit = 20): Promise<CodexSwap[]> {
  return cached(
    `codex:swaps:${address.toLowerCase()}:${limit}`,
    30_000,
    async () => {
      const data = await gql<EventsResult>(
        `query($net: Int!, $addr: String!, $limit: Int!) {
          getTokenEvents(query: { networkId: $net, address: $addr }, limit: $limit) {
            items { ${EVENT_FIELDS} }
          }
        }`,
        { net: ROBINHOOD_NETWORK_ID, addr: address, limit }
      );

      return (data?.getTokenEvents?.items ?? []).map(shapeSwap);
    },
    () => true
  );
}

/**
 * How many events one flow read may walk.
 *
 * Measured rather than chosen: on the busiest token here, 600 events covered
 * 2.6 hours. Paging back a week would be roughly four hundred requests against
 * an API whose quota is not published in any response header, for one token, on
 * a bot that watches many. Six pages is the point where the window is wide
 * enough to characterise current flow and still cheap enough to run often.
 *
 * The consequence is stated wherever it matters: this window is hours, not days,
 * so nothing built on it may claim to know a wallet's long-run performance.
 */
export const MAX_FLOW_PAGES = 6;
export const FLOW_PAGE_SIZE = 100;

export type FlowWindow = {
  swaps: CodexSwap[];
  /** Seconds actually covered — the honest span, not the one requested. */
  spanSec: number;
  /** True when paging stopped at the ceiling, so older trades exist unread. */
  truncated: boolean;
};

/**
 * A window of recent flow, walked back as far as the page budget allows.
 *
 * Returns the span it actually covered so callers can rate-normalise. Comparing
 * a raw count from a token with three trades an hour against one with three
 * hundred would otherwise make the quiet token look dormant and the busy one
 * look like an event, when both are simply themselves.
 */
export async function codexFlowWindow(
  address: string,
  options: { hours?: number; pages?: number } = {}
): Promise<FlowWindow> {
  const pages = Math.min(options.pages ?? MAX_FLOW_PAGES, MAX_FLOW_PAGES);
  const floor = options.hours ? Math.floor(Date.now() / 1000) - options.hours * 3600 : 0;

  return cached(
    `codex:flow:${address.toLowerCase()}:${pages}:${options.hours ?? 0}`,
    90_000,
    async () => {
      const swaps: CodexSwap[] = [];
      let cursor: string | null = null;
      let truncated = false;

      for (let page = 0; page < pages; page++) {
        const data: EventsResult | null = await gql<EventsResult>(
          `query($net: Int!, $addr: String!, $limit: Int!, $cursor: String) {
            getTokenEvents(query: { networkId: $net, address: $addr }, limit: $limit, cursor: $cursor) {
              items { ${EVENT_FIELDS} }
              cursor
            }
          }`,
          { net: ROBINHOOD_NETWORK_ID, addr: address, limit: FLOW_PAGE_SIZE, cursor }
        );

        const items = data?.getTokenEvents?.items ?? [];
        if (items.length === 0) break;

        swaps.push(...items.map(shapeSwap));

        // Reached far enough back; older pages are not worth the request.
        if (floor && (items.at(-1)?.timestamp ?? 0) < floor) break;

        cursor = data?.getTokenEvents?.cursor ?? null;
        if (!cursor) break;
        if (page === pages - 1) truncated = true;
      }

      const times = swaps.map((s) => s.timestamp).filter((t) => t > 0);
      const spanSec = times.length > 1 ? Math.max(...times) - Math.min(...times) : 0;

      return { swaps, spanSec, truncated };
    },
    (v) => v.swaps.length > 0
  );
}

/**
 * One wallet's trades in one token.
 *
 * The `maker` filter was verified to actually filter — checked against the
 * makers on the returned events rather than against the absence of a GraphQL
 * error, because an accepted-but-ignored argument would have made every
 * per-wallet claim in this product fiction.
 */
export async function codexWalletTrades(
  tokenAddress: string,
  maker: string,
  limit = 100
): Promise<CodexSwap[]> {
  return cached(
    `codex:maker:${tokenAddress.toLowerCase()}:${maker.toLowerCase()}:${limit}`,
    120_000,
    async () => {
      const data = await gql<EventsResult>(
        `query($net: Int!, $addr: String!, $maker: String!, $limit: Int!) {
          getTokenEvents(query: { networkId: $net, address: $addr, maker: $maker }, limit: $limit) {
            items { ${EVENT_FIELDS} }
          }
        }`,
        { net: ROBINHOOD_NETWORK_ID, addr: tokenAddress, maker: maker.toLowerCase(), limit }
      );
      return (data?.getTokenEvents?.items ?? []).map(shapeSwap);
    },
    () => true
  );
}
