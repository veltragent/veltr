import { cached } from "./cache";
import { fetchMarketStatus } from "./stocks";

/**
 * Market data layer.
 *
 * Four keyless sources, each used for the one thing it is best at:
 *
 *  - DexScreener    on-chain price, liquidity, 24h volume and trade counts
 *  - GeckoTerminal  OHLCV candles (the chart source) and pool discovery
 *  - Yahoo Finance  the price of the actual underlying equity
 *  - CoinGecko      global crypto market context
 *
 * The reason all four are here is the number they produce together: a tokenised
 * stock trades continuously while its underlying market is shut. The gap
 * between the on-chain price and the real one is the premium, and it is the
 * figure no explorer or tracker on this chain reports.
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const GT = "https://api.geckoterminal.com/api/v2/networks/robinhood";
const DS = "https://api.dexscreener.com/latest/dex";
const CG = "https://api.coingecko.com/api/v3";
const YF = "https://query1.finance.yahoo.com/v8/finance/chart";

async function getJson<T>(url: string, timeoutMs = 15_000): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ DEX */

export type DexQuote = {
  /** Price from the deepest pool — the venue least moved by one trade. */
  priceUsd: number;
  /** Summed across every pool this token is the base of. */
  liquidityUsd: number;
  /** Summed the same way. */
  volume24hUsd: number;
  priceChange24h: number | null;
  buys24h: number;
  sells24h: number;
  /** The deepest pool, for a chart or a link that needs one venue. */
  pairAddress: string;
  quoteSymbol: string;
  dex: string;
  /** How many pools the totals are drawn from. */
  poolCount: number;
  /** What the deepest one holds, so the spread across venues stays visible. */
  deepestLiquidityUsd: number;
};

type DsPair = {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; symbol: string };
  quoteToken: { symbol: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  priceChange?: { h24?: number };
  txns?: { h24?: { buys?: number; sells?: number } };
};

/**
 * Turns the pools a token trades in into one reading.
 *
 * Price comes from the deepest pool: a thin pool's price is noise, so the quote
 * is taken from whichever venue has the liquidity to defend it.
 *
 * Liquidity and volume are sums, because they belong to the token rather than
 * to one venue. They used to be read off the deepest pair alone — right for a
 * price, wrong for a total. NVDA trades in twenty-seven pools here: the deepest
 * holds $1.38M of $2.58M and did $415k of the $4.00M traded in a day, so those
 * two figures were reported at 53% and 10% of the truth.
 *
 * Callers must pass base-side pairs only. DexScreener also returns pools where
 * the token is the *quote* side, and their `priceUsd` is some other token's —
 * for NVDA that is three pools which would have added $888k of somebody else's
 * money to the liquidity.
 */
export function quoteFromPairsForTests(pairs: DsPair[]): DexQuote | null {
  return quoteFromPairs(pairs);
}

function quoteFromPairs(pairs: DsPair[]): DexQuote | null {
  if (pairs.length === 0) return null;

  const best = [...pairs].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
  const price = Number(best.priceUsd);
  if (!Number.isFinite(price) || price <= 0) return null;

  const sum = (pick: (p: DsPair) => number | undefined | null) =>
    pairs.reduce((total, p) => total + (Number(pick(p)) || 0), 0);

  return {
    priceUsd: price,
    liquidityUsd: sum((p) => p.liquidity?.usd),
    volume24hUsd: sum((p) => p.volume?.h24),
    priceChange24h: best.priceChange?.h24 ?? null,
    buys24h: sum((p) => p.txns?.h24?.buys),
    sells24h: sum((p) => p.txns?.h24?.sells),
    // The deepest pool, for anything that needs one venue: the chart, the link.
    pairAddress: best.pairAddress,
    quoteSymbol: best.quoteToken?.symbol ?? "?",
    dex: best.dexId ?? "?",
    poolCount: pairs.length,
    deepestLiquidityUsd: best.liquidity?.usd ?? 0,
  };
}

export async function fetchDexQuote(tokenAddress: string): Promise<DexQuote | null> {
  return cached(
    `dex:${tokenAddress.toLowerCase()}`,
    60_000,
    async () => {
      const json = await getJson<{ pairs?: DsPair[] }>(`${DS}/tokens/${tokenAddress}`);
      const pairs = (json?.pairs ?? []).filter(
        (p) =>
          p.chainId === "robinhood" &&
          p.baseToken?.address?.toLowerCase() === tokenAddress.toLowerCase()
      );
      return quoteFromPairs(pairs);
    },
    (v) => v !== null
  );
}

/**
 * The same reading, for every token on the chain.
 *
 * One request per token, not a batch, and that is deliberate. DexScreener does
 * accept thirty addresses in a single call — but it caps the *response* at
 * thirty pairs regardless. Asking for thirty tokens came back covering
 * seventeen of them, each with a truncated pool list, which is worse than
 * making more requests: the totals would have looked complete and been short,
 * with nothing in the response to say so.
 *
 * Six at a time. Ninety-five tokens against a keyless public endpoint, held
 * under its documented ceiling by the per-token cache above rather than by
 * luck, and bounded so a snapshot rebuild cannot open ninety-five sockets.
 */
export async function fetchDexQuotes(addresses: string[]): Promise<Map<string, DexQuote>> {
  const out = new Map<string, DexQuote>();
  if (addresses.length === 0) return out;

  const CONCURRENCY = 6;
  let cursor = 0;

  const workers = Array.from({ length: Math.min(CONCURRENCY, addresses.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= addresses.length) return;
      const address = addresses[i];
      const quote = await fetchDexQuote(address).catch(() => null);
      if (quote) out.set(address.toLowerCase(), quote);
    }
  });

  await Promise.all(workers);
  return out;
}

/* --------------------------------------------------------------- Charts */

export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };
export type Timeframe = "hour" | "day" | "minute";

/** OHLCV straight from GeckoTerminal — the only keyless candle source for this chain. */
export async function fetchCandles(
  poolAddress: string,
  timeframe: Timeframe = "hour",
  limit = 168
): Promise<Candle[]> {
  return cached(
    `ohlcv:${poolAddress}:${timeframe}:${limit}`,
    120_000,
    async () => {
      const json = await getJson<{ data?: { attributes?: { ohlcv_list?: number[][] } } }>(
        `${GT}/pools/${poolAddress}/ohlcv/${timeframe}?aggregate=1&limit=${limit}`
      );
      const list = json?.data?.attributes?.ohlcv_list ?? [];
      return list
        .map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume }))
        .sort((a, b) => a.time - b.time);
    },
    (v) => v.length > 0
  );
}

/**
 * The deepest pool in which this token is the BASE currency.
 *
 * Orientation is not cosmetic: GeckoTerminal's OHLCV returns the base token's
 * price. NVDA's deepest pools are "AI / NVDA" and "USDG / NVDA", where NVDA is
 * the quote — charting either of those plots the price of AI or USDG (about
 * $1), not NVDA (about $225). Only a pool like "NVDA / USDG" yields NVDA candles.
 */
export async function fetchPrimaryPool(tokenAddress: string): Promise<string | null> {
  return cached(
    `pool:${tokenAddress.toLowerCase()}`,
    10 * 60_000,
    async () => {
      const target = tokenAddress.toLowerCase();

      type GtPool = {
        attributes?: { address?: string; reserve_in_usd?: string };
        relationships?: { base_token?: { data?: { id?: string } } };
      };

      const json = await getJson<{ data?: GtPool[] }>(`${GT}/tokens/${tokenAddress}/pools`);
      const pools = json?.data ?? [];

      const baseIsTarget = pools.filter((p) =>
        (p.relationships?.base_token?.data?.id ?? "").toLowerCase().endsWith(target)
      );

      const best = baseIsTarget.sort(
        (a, b) => Number(b.attributes?.reserve_in_usd ?? 0) - Number(a.attributes?.reserve_in_usd ?? 0)
      )[0];

      if (best?.attributes?.address) return best.attributes.address;

      // No correctly-oriented pool on GeckoTerminal; DexScreener already filters
      // by base token, so its pair is a safe second choice.
      const quote = await fetchDexQuote(tokenAddress);
      return quote?.pairAddress ?? null;
    },
    (v) => v !== null
  );
}

/* --------------------------------------------------- Underlying equity */

export type EquityQuote = {
  symbol: string;
  price: number;
  previousClose: number;
  changePct: number;
  currency: string;
  exchangeTimezone: string;
  marketState: string | null;
  asOf: number;
};

/**
 * The real stock. Yahoo's chart endpoint is public and unauthenticated, which is
 * why it is used here rather than a keyed provider — but it is unofficial, so
 * every consumer must tolerate it returning nothing.
 */
export async function fetchEquityQuote(symbol: string): Promise<EquityQuote | null> {
  return cached(
    `equity:${symbol}`,
    60_000,
    async () => {
      type Yf = {
        chart?: {
          result?: {
            meta?: {
              symbol?: string;
              regularMarketPrice?: number;
              chartPreviousClose?: number;
              previousClose?: number;
              currency?: string;
              exchangeTimezoneName?: string;
              marketState?: string;
              regularMarketTime?: number;
            };
          }[];
        };
      };

      const json = await getJson<Yf>(`${YF}/${encodeURIComponent(symbol)}?range=1d&interval=1h`);
      const meta = json?.chart?.result?.[0]?.meta;
      const price = meta?.regularMarketPrice;
      const prev = meta?.chartPreviousClose ?? meta?.previousClose;
      if (!Number.isFinite(price) || !Number.isFinite(prev)) return null;

      return {
        symbol: meta?.symbol ?? symbol,
        price: price as number,
        previousClose: prev as number,
        changePct: ((price as number) / (prev as number) - 1) * 100,
        currency: meta?.currency ?? "USD",
        exchangeTimezone: meta?.exchangeTimezoneName ?? "America/New_York",
        marketState: meta?.marketState ?? null,
        asOf: meta?.regularMarketTime ?? Math.floor(Date.now() / 1000),
      };
    },
    (v) => v !== null
  );
}

/* ------------------------------------------------------------- Premium */

export type PremiumReading = {
  symbol: string;
  tokenPriceUsd: number | null;
  equityPriceUsd: number | null;
  /** Percent the token trades above (+) or below (−) its underlying. */
  premiumPct: number | null;
  liquidityUsd: number;
  volume24hUsd: number;
  marketOpen: boolean;
  /** Stale means the equity market is shut, so the reference price is a close. */
  referenceIsStale: boolean;
};

/**
 * Fallback session clock: US equities trade 09:30–16:00 ET on weekdays.
 *
 * Used only when Finnhub is unreachable. It does not know the exchange holiday
 * calendar, so it will report "open" on Thanksgiving — which is exactly why
 * `resolveMarketOpen` prefers the authoritative feed.
 */
export function isUsMarketOpen(now = new Date()): boolean {
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const minutes = et.getHours() * 60 + et.getMinutes();
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

/** Authoritative session state where available, local clock otherwise. */
export async function resolveMarketOpen(): Promise<boolean> {
  const status = await fetchMarketStatus().catch(() => null);
  return status?.isOpen ?? isUsMarketOpen();
}

export async function readPremium(symbol: string, tokenAddress: string): Promise<PremiumReading> {
  const [dex, equity, open] = await Promise.all([
    fetchDexQuote(tokenAddress),
    fetchEquityQuote(symbol),
    resolveMarketOpen(),
  ]);
  const tokenPrice = dex?.priceUsd ?? null;
  const equityPrice = equity?.price ?? null;

  return {
    symbol,
    tokenPriceUsd: tokenPrice,
    equityPriceUsd: equityPrice,
    premiumPct:
      tokenPrice !== null && equityPrice !== null && equityPrice > 0
        ? (tokenPrice / equityPrice - 1) * 100
        : null,
    liquidityUsd: dex?.liquidityUsd ?? 0,
    volume24hUsd: dex?.volume24hUsd ?? 0,
    marketOpen: open,
    referenceIsStale: !open,
  };
}

/* ------------------------------------------------------- Global market */

export type GlobalMarket = {
  totalMarketCapUsd: number;
  change24hPct: number;
  btcDominance: number;
  ethDominance: number;
  volume24hUsd: number;
};

export async function fetchGlobalMarket(): Promise<GlobalMarket | null> {
  return cached(
    "cg:global",
    5 * 60_000,
    async () => {
      type Cg = {
        data?: {
          total_market_cap?: { usd?: number };
          total_volume?: { usd?: number };
          market_cap_change_percentage_24h_usd?: number;
          market_cap_percentage?: { btc?: number; eth?: number };
        };
      };
      const json = await getJson<Cg>(`${CG}/global`);
      const d = json?.data;
      if (!d?.total_market_cap?.usd) return null;

      return {
        totalMarketCapUsd: d.total_market_cap.usd,
        change24hPct: d.market_cap_change_percentage_24h_usd ?? 0,
        btcDominance: d.market_cap_percentage?.btc ?? 0,
        ethDominance: d.market_cap_percentage?.eth ?? 0,
        volume24hUsd: d.total_volume?.usd ?? 0,
      };
    },
    (v) => v !== null
  );
}

/** Chain-wide DEX activity, for the market header. */
export async function fetchChainPools(limit = 20) {
  return cached(
    "gt:pools",
    3 * 60_000,
    async () => {
      type Gt = {
        data?: {
          attributes?: {
            name?: string;
            address?: string;
            reserve_in_usd?: string;
            volume_usd?: { h24?: string };
            base_token_price_usd?: string;
          };
        }[];
      };
      const json = await getJson<Gt>(`${GT}/pools?page=1`);
      return (json?.data ?? []).slice(0, limit).map((p) => ({
        name: p.attributes?.name ?? "?",
        address: p.attributes?.address ?? "",
        liquidityUsd: Number(p.attributes?.reserve_in_usd ?? 0),
        volume24hUsd: Number(p.attributes?.volume_usd?.h24 ?? 0),
        priceUsd: Number(p.attributes?.base_token_price_usd ?? 0),
      }));
    },
    (v) => v.length > 0
  );
}
