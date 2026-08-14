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
  timestamp: number;
  valueUsd: number | null;
  maker: string | null;
  txHash: string | null;
};

/** Recent swaps — the flow data no keyless source on this chain provides. */
export async function codexRecentSwaps(address: string, limit = 20): Promise<CodexSwap[]> {
  return cached(
    `codex:swaps:${address.toLowerCase()}:${limit}`,
    30_000,
    async () => {
      type Events = {
        getTokenEvents?: {
          items?: {
            eventType?: string;
            timestamp?: number;
            maker?: string;
            transactionHash?: string;
            token0SwapValueUsd?: string;
            token1SwapValueUsd?: string;
          }[];
        };
      };

      const data = await gql<Events>(
        `query($net: Int!, $addr: String!, $limit: Int!) {
          getTokenEvents(query: { networkId: $net, address: $addr }, limit: $limit) {
            items { eventType timestamp maker transactionHash token0SwapValueUsd token1SwapValueUsd }
          }
        }`,
        { net: ROBINHOOD_NETWORK_ID, addr: address, limit }
      );

      return (data?.getTokenEvents?.items ?? []).map((e) => ({
        type: e.eventType ?? "Swap",
        timestamp: e.timestamp ?? 0,
        valueUsd: num(e.token0SwapValueUsd) ?? num(e.token1SwapValueUsd),
        maker: e.maker ?? null,
        txHash: e.transactionHash ?? null,
      }));
    },
    () => true
  );
}
