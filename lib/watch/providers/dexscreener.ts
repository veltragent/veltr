import { emptyMarketData, num, type TokenMarketData } from "../types";
import { chunk, getJson, type FetchLike } from "../http";

/**
 * DexScreener adapter.
 *
 * Plain HTTP against the documented endpoints — no SDK, no key. Verified against
 * the live API for this chain: `chainId` is the string "robinhood", and the
 * token endpoints carry price, both capitalisation figures, liquidity, volume,
 * per-window price change and trade counts in one response, which makes this the
 * primary source for everything except OHLCV.
 *
 * Endpoints used (both documented at docs.dexscreener.com, 300 req/min):
 *   GET /token-pairs/v1/{chainId}/{tokenAddress}   one token, every pair
 *   GET /tokens/v1/{chainId}/{addresses}           up to 30 tokens, best pair each
 */

const BASE = "https://api.dexscreener.com";

/** DexScreener's identifier for Robinhood Chain, confirmed against the live API. */
export const DS_CHAIN_ID = "robinhood";

/** The endpoint truncates silently past this, so batches are cut here first. */
export const DS_MAX_BATCH = 30;

export type DsPair = {
  chainId?: string;
  dexId?: string;
  url?: string;
  pairAddress?: string;
  labels?: string[];
  baseToken?: { address?: string; name?: string; symbol?: string };
  quoteToken?: { address?: string; name?: string; symbol?: string };
  priceNative?: string;
  priceUsd?: string;
  txns?: Record<string, { buys?: number; sells?: number } | undefined>;
  volume?: Record<string, number | undefined>;
  priceChange?: Record<string, number | undefined>;
  liquidity?: { usd?: number; base?: number; quote?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
};

/**
 * Picks the pair that actually describes this token, on this chain.
 *
 * Two filters, both load-bearing. The chain filter is what keeps an identical
 * contract address on Base or Ethereum from being read as a Robinhood token. The
 * base-token filter is what keeps orientation straight: in an "AI / NVDA" pool
 * NVDA is the quote, and that pair's price and price-change describe AI.
 *
 * Among the survivors the deepest pool wins — a thin pool's last trade is noise,
 * and alerting on noise is worse than not alerting.
 */
export function selectPair(pairs: DsPair[], tokenAddress: string): DsPair | null {
  const target = tokenAddress.toLowerCase();

  const eligible = pairs.filter(
    (p) => p.chainId === DS_CHAIN_ID && p.baseToken?.address?.toLowerCase() === target
  );
  if (eligible.length === 0) return null;

  return eligible.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
}

/** Normalises one pair into the internal model. Every absent field stays null. */
export function toMarketData(pair: DsPair, tokenAddress: string): TokenMarketData {
  const data = emptyMarketData(tokenAddress, "dexscreener");

  data.symbol = pair.baseToken?.symbol ?? null;
  data.name = pair.baseToken?.name ?? null;
  data.price = num(pair.priceNative);
  data.priceUsd = num(pair.priceUsd);
  data.marketCap = num(pair.marketCap);
  data.fdv = num(pair.fdv);
  data.liquidity = num(pair.liquidity?.usd);
  data.volume24h = num(pair.volume?.h24);
  data.priceChange5m = num(pair.priceChange?.m5);
  data.priceChange1h = num(pair.priceChange?.h1);
  data.priceChange6h = num(pair.priceChange?.h6);
  data.priceChange24h = num(pair.priceChange?.h24);
  data.buys = num(pair.txns?.h24?.buys);
  data.sells = num(pair.txns?.h24?.sells);
  data.pairAddress = pair.pairAddress ?? null;
  data.dex = pair.dexId ?? null;
  data.url = pair.url ?? null;

  return data;
}

export function parsePairs(pairs: DsPair[] | null, tokenAddress: string): TokenMarketData | null {
  if (!pairs || pairs.length === 0) return null;
  const pair = selectPair(pairs, tokenAddress);
  return pair ? toMarketData(pair, tokenAddress) : null;
}

export type ProviderOptions = { fetchImpl?: FetchLike; timeoutMs?: number };

/** One token, every pair it trades in. */
export async function fetchToken(
  tokenAddress: string,
  options: ProviderOptions = {}
): Promise<TokenMarketData | null> {
  const json = await getJson<DsPair[]>(
    "DEXSCREENER",
    `${BASE}/token-pairs/v1/${DS_CHAIN_ID}/${tokenAddress}`,
    { ...options, subject: tokenAddress }
  );
  // The endpoint answers with a bare array; anything else is a shape change.
  return parsePairs(Array.isArray(json) ? json : null, tokenAddress);
}

/**
 * Many tokens in one request.
 *
 * This is what makes a hundred users watching the same twenty tokens cost a
 * handful of calls a minute instead of two thousand. Addresses are deduplicated
 * by the caller; batching happens here because the cap is the provider's.
 */
export async function fetchBatch(
  addresses: string[],
  options: ProviderOptions = {}
): Promise<Map<string, TokenMarketData>> {
  const out = new Map<string, TokenMarketData>();

  for (const group of chunk(addresses, DS_MAX_BATCH)) {
    const json = await getJson<DsPair[]>(
      "DEXSCREENER",
      `${BASE}/tokens/v1/${DS_CHAIN_ID}/${group.join(",")}`,
      { ...options, subject: `${group.length} tokens` }
    );
    if (!Array.isArray(json)) continue;

    for (const address of group) {
      const parsed = parsePairs(json, address);
      if (parsed) out.set(address.toLowerCase(), parsed);
    }
  }

  return out;
}
