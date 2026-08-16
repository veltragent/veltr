import type { MarketSource, TokenMarketData } from "./types";
import type { WatchSettings } from "./types";
import { DEFAULT_SETTINGS } from "./settings";
import * as dexscreener from "./providers/dexscreener";
import * as geckoterminal from "./providers/geckoterminal";
import type { FetchLike } from "./http";

/**
 * Multi-source aggregation.
 *
 * No single provider is trusted for the whole picture. Each field is taken from
 * whichever source is actually authoritative for it, and a source that fails
 * simply contributes nothing rather than failing the read.
 */

export const CHAIN = "robinhood";
/** Robinhood Chain mainnet. Any pair a provider cannot place on this chain is discarded. */
export const CHAIN_ID = 4663;

/**
 * Which source wins each field, most trusted first.
 *
 * DexScreener leads on everything derived from a pool: it reports the specific
 * pair, so its price, liquidity and volume describe one venue that can be linked
 * to and verified. GeckoTerminal's liquidity is the sum across every pool and its
 * volume is chain-wide for the token — larger numbers describing a different
 * thing, useful when DexScreener has nothing but wrong to mix in silently.
 */
/*
 * Premium is absent on purpose. It is not reported by any pool provider — it is
 * computed against an equity quote after the merge — so giving it a source list
 * here would claim a provenance it does not have.
 */
const PRIORITY: Record<
  keyof Omit<TokenMarketData, "address" | "source" | "updatedAt" | "premiumPct" | "premiumIsStale" | "equityPriceUsd">,
  MarketSource[]
> = {
  symbol: ["dexscreener", "geckoterminal", "onchain"],
  name: ["dexscreener", "geckoterminal", "onchain"],
  price: ["dexscreener", "geckoterminal"],
  priceUsd: ["dexscreener", "geckoterminal"],
  marketCap: ["dexscreener", "geckoterminal"],
  fdv: ["dexscreener", "geckoterminal"],
  liquidity: ["dexscreener", "geckoterminal"],
  volume24h: ["dexscreener", "geckoterminal"],
  priceChange5m: ["dexscreener", "geckoterminal"],
  priceChange1h: ["dexscreener", "geckoterminal"],
  priceChange6h: ["dexscreener", "geckoterminal"],
  priceChange24h: ["dexscreener", "geckoterminal"],
  buys: ["dexscreener", "geckoterminal"],
  sells: ["dexscreener", "geckoterminal"],
  pairAddress: ["dexscreener", "geckoterminal"],
  dex: ["dexscreener", "geckoterminal"],
  url: ["dexscreener", "geckoterminal"],
};

type Field = keyof typeof PRIORITY;

/**
 * Merges readings into one record.
 *
 * A field is filled by the first source in its priority order that actually has
 * a value — absence never overwrites presence, and a later source never
 * downgrades a field to null. `source` lists only the providers that contributed
 * something, so the alert can honestly say where its numbers came from.
 */
export function mergeMarketData(readings: (TokenMarketData | null)[]): TokenMarketData | null {
  const present = readings.filter((r): r is TokenMarketData => r !== null);
  if (present.length === 0) return null;

  // A source can contribute more than one reading — GeckoTerminal's token
  // endpoint carries identity and capitalisation while its pools endpoint carries
  // the price windows and the chart link. Keeping only the first would silently
  // discard the second, so all of them are held in call order and consulted in
  // turn.
  const bySource = new Map<MarketSource, TokenMarketData[]>();
  for (const reading of present) {
    for (const source of reading.source) {
      const existing = bySource.get(source);
      if (existing) existing.push(reading);
      else bySource.set(source, [reading]);
    }
  }

  const merged: TokenMarketData = {
    ...present[0],
    source: [],
    updatedAt: new Date().toISOString(),
  };

  const contributed = new Set<MarketSource>();

  for (const field of Object.keys(PRIORITY) as Field[]) {
    let value: TokenMarketData[Field] = null;
    outer: for (const source of PRIORITY[field]) {
      for (const reading of bySource.get(source) ?? []) {
        const candidate = reading[field];
        if (candidate !== null && candidate !== undefined) {
          value = candidate;
          contributed.add(source);
          break outer;
        }
      }
    }
    // The cast is safe: PRIORITY is keyed by the nullable fields only, so every
    // target accepts null.
    (merged[field] as TokenMarketData[Field]) = value;
  }

  merged.source = present
    .flatMap((r) => r.source)
    .filter((s, i, all) => contributed.has(s) && all.indexOf(s) === i);

  return merged;
}

export type AggregateOptions = {
  settings?: Pick<WatchSettings, "useDexScreener" | "useGeckoTerminal">;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** Adds GeckoTerminal's pool call: finer price windows and a chart link. */
  deep?: boolean;
};

/**
 * Full lookup for a single token — the /watch path.
 *
 * Both providers are asked in parallel and neither is allowed to fail the other:
 * if DexScreener is down the reading is built from GeckoTerminal, and the
 * reverse. Only when every enabled source returns nothing is the token treated as
 * absent from this chain's markets.
 */
export async function fetchTokenMarketData(
  tokenAddress: string,
  options: AggregateOptions = {}
): Promise<TokenMarketData | null> {
  const settings = options.settings ?? DEFAULT_SETTINGS;
  const providerOptions = { fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs };

  const jobs: Promise<TokenMarketData | null>[] = [];

  if (settings.useDexScreener) {
    jobs.push(dexscreener.fetchToken(tokenAddress, providerOptions).catch(() => null));
  }
  if (settings.useGeckoTerminal) {
    jobs.push(geckoterminal.fetchToken(tokenAddress, providerOptions).catch(() => null));
    if (options.deep) {
      jobs.push(geckoterminal.fetchPoolData(tokenAddress, providerOptions).catch(() => null));
    }
  }

  const readings = await Promise.all(jobs);
  const merged = mergeMarketData(readings);

  console.log(
    `[veltr][MARKET_DATA] token=${tokenAddress} sources=${merged?.source.join("+") || "none"} price=${
      merged?.priceUsd ?? "null"
    }`
  );

  return merged;
}

/** Readings kept apart by provider, so each user's source preference can be applied. */
export type SourceReadings = {
  dexscreener: Map<string, TokenMarketData>;
  geckoterminal: Map<string, TokenMarketData>;
};

/**
 * One batched call per provider, covering every address asked for.
 *
 * This is the monitoring path. A hundred users watching the same token produce
 * one address here, and thirty addresses produce one call per provider — which
 * is what keeps a 30-second interval inside a 30-call-per-minute budget.
 *
 * The readings are returned unmerged because merging is a per-user decision: two
 * people watching the same token may have different sources enabled, and both
 * are entitled to the batch that was already paid for.
 */
export async function fetchSourceReadings(
  addresses: string[],
  options: AggregateOptions = {}
): Promise<SourceReadings> {
  const unique = [...new Set(addresses.map((a) => a.toLowerCase()))];
  const empty: SourceReadings = { dexscreener: new Map(), geckoterminal: new Map() };
  if (unique.length === 0) return empty;

  const settings = options.settings ?? DEFAULT_SETTINGS;
  const providerOptions = { fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs };

  const [ds, gt] = await Promise.all([
    settings.useDexScreener
      ? dexscreener.fetchBatch(unique, providerOptions).catch(() => new Map<string, TokenMarketData>())
      : Promise.resolve(new Map<string, TokenMarketData>()),
    settings.useGeckoTerminal
      ? geckoterminal.fetchBatch(unique, providerOptions).catch(() => new Map<string, TokenMarketData>())
      : Promise.resolve(new Map<string, TokenMarketData>()),
  ]);

  console.log(
    `[veltr][MARKET_DATA] batch tokens=${unique.length} dexscreener=${ds.size} geckoterminal=${gt.size}`
  );

  return { dexscreener: ds, geckoterminal: gt };
}

/** Merges the batch for one address under one user's source preferences. */
export function readingFor(
  readings: SourceReadings,
  address: string,
  settings: Pick<WatchSettings, "useDexScreener" | "useGeckoTerminal">
): TokenMarketData | null {
  const key = address.toLowerCase();
  return mergeMarketData([
    settings.useDexScreener ? readings.dexscreener.get(key) ?? null : null,
    settings.useGeckoTerminal ? readings.geckoterminal.get(key) ?? null : null,
  ]);
}

/** Merged readings for many tokens under one set of preferences. */
export async function fetchManyTokenMarketData(
  addresses: string[],
  options: AggregateOptions = {}
): Promise<Map<string, TokenMarketData>> {
  const settings = options.settings ?? DEFAULT_SETTINGS;
  const readings = await fetchSourceReadings(addresses, options);

  const out = new Map<string, TokenMarketData>();
  for (const address of new Set(addresses.map((a) => a.toLowerCase()))) {
    const merged = readingFor(readings, address, settings);
    if (merged) out.set(address, merged);
  }
  return out;
}
