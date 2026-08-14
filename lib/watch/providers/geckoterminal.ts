import { emptyMarketData, num, type TokenMarketData } from "../types";
import { chunk, getJson, type FetchLike } from "../http";

/**
 * GeckoTerminal adapter.
 *
 * Public API, no key, 30 calls a minute for the whole process. Confirmed against
 * the live API: this chain's network slug is "robinhood" — checked by walking
 * /api/v2/networks rather than assumed from the chain's name, because a slug is
 * a provider's choice and not a property of the chain.
 *
 * Endpoints used:
 *   GET /networks/{net}/tokens/{addr}                 name, symbol, price, mcap, fdv, reserve
 *   GET /simple/networks/{net}/token_price/{addrs}    up to 30 tokens in one call
 *   GET /networks/{net}/tokens/{addr}/pools           pool detail and windowed price change
 *
 * What it does not serve for this chain: sub-24h price change on the token
 * endpoint. Those windows come from the pools endpoint, or from DexScreener.
 */

const BASE = "https://api.geckoterminal.com/api/v2";

/** Verified by enumerating /api/v2/networks, not inferred from the chain name. */
export const GT_NETWORK = "robinhood";

/** The API rejects a longer list outright: "maximum 30 addresses allowed". */
export const GT_MAX_BATCH = 30;

export type ProviderOptions = { fetchImpl?: FetchLike; timeoutMs?: number };

type GtTokenResponse = {
  data?: {
    attributes?: {
      address?: string;
      name?: string;
      symbol?: string;
      price_usd?: string;
      fdv_usd?: string;
      market_cap_usd?: string | null;
      total_reserve_in_usd?: string;
      volume_usd?: { h24?: string };
    };
  };
};

type GtPool = {
  attributes?: {
    address?: string;
    name?: string;
    base_token_price_usd?: string;
    fdv_usd?: string;
    market_cap_usd?: string | null;
    reserve_in_usd?: string;
    price_change_percentage?: Record<string, string | undefined>;
    volume_usd?: Record<string, string | undefined>;
    transactions?: Record<string, { buys?: number; sells?: number } | undefined>;
  };
  relationships?: {
    base_token?: { data?: { id?: string } };
    dex?: { data?: { id?: string } };
  };
};

/**
 * Is this pool's price the price of the token we asked about?
 *
 * GeckoTerminal quotes `base_token_price_usd` and its price-change windows for
 * the base side only. NVDA's deepest pool is "AI / NVDA", where NVDA is the
 * quote — reading that pool's 24h change would report AI's move under NVDA's
 * name. Identifiers arrive namespaced as "robinhood_0x…", so the network is
 * checked in the same test.
 */
export function poolIsBaseToken(pool: GtPool, tokenAddress: string): boolean {
  const id = pool.relationships?.base_token?.data?.id?.toLowerCase() ?? "";
  return id === `${GT_NETWORK}_${tokenAddress.toLowerCase()}`;
}

export function parseToken(json: GtTokenResponse | null, tokenAddress: string): TokenMarketData | null {
  const attributes = json?.data?.attributes;
  if (!attributes) return null;

  // A record with no price is an indexed token with no market — not a reading.
  const priceUsd = num(attributes.price_usd);
  if (priceUsd === null) return null;

  const data = emptyMarketData(tokenAddress, "geckoterminal");
  data.symbol = attributes.symbol ?? null;
  data.name = attributes.name ?? null;
  data.priceUsd = priceUsd;
  data.marketCap = num(attributes.market_cap_usd);
  data.fdv = num(attributes.fdv_usd);
  data.liquidity = num(attributes.total_reserve_in_usd);
  data.volume24h = num(attributes.volume_usd?.h24);

  return data;
}

/** Token identity and headline numbers. */
export async function fetchToken(
  tokenAddress: string,
  options: ProviderOptions = {}
): Promise<TokenMarketData | null> {
  const json = await getJson<GtTokenResponse>(
    "GECKOTERMINAL",
    `${BASE}/networks/${GT_NETWORK}/tokens/${tokenAddress}`,
    { ...options, subject: tokenAddress }
  );
  return parseToken(json, tokenAddress);
}

export function parsePools(json: { data?: GtPool[] } | null, tokenAddress: string): TokenMarketData | null {
  const pools = (json?.data ?? []).filter((p) => poolIsBaseToken(p, tokenAddress));
  if (pools.length === 0) return null;

  const best = pools.sort(
    (a, b) => (num(b.attributes?.reserve_in_usd) ?? 0) - (num(a.attributes?.reserve_in_usd) ?? 0)
  )[0];
  const attributes = best.attributes;
  if (!attributes) return null;

  const data = emptyMarketData(tokenAddress, "geckoterminal");
  data.priceUsd = num(attributes.base_token_price_usd);
  data.marketCap = num(attributes.market_cap_usd);
  data.fdv = num(attributes.fdv_usd);
  data.liquidity = num(attributes.reserve_in_usd);
  data.volume24h = num(attributes.volume_usd?.h24);
  data.priceChange5m = num(attributes.price_change_percentage?.m5);
  data.priceChange1h = num(attributes.price_change_percentage?.h1);
  data.priceChange6h = num(attributes.price_change_percentage?.h6);
  data.priceChange24h = num(attributes.price_change_percentage?.h24);
  data.buys = num(attributes.transactions?.h24?.buys);
  data.sells = num(attributes.transactions?.h24?.sells);
  data.pairAddress = attributes.address ?? null;
  data.dex = best.relationships?.dex?.data?.id ?? null;
  data.url = attributes.address
    ? `https://www.geckoterminal.com/${GT_NETWORK}/pools/${attributes.address}`
    : null;

  return data;
}

/**
 * Pool-level detail: the finer price-change windows and the pool link.
 *
 * Costs a second call, so it is used on the /watch and /watches paths where a
 * user is waiting, not on every monitoring cycle.
 */
export async function fetchPoolData(
  tokenAddress: string,
  options: ProviderOptions = {}
): Promise<TokenMarketData | null> {
  const json = await getJson<{ data?: GtPool[] }>(
    "GECKOTERMINAL",
    `${BASE}/networks/${GT_NETWORK}/tokens/${tokenAddress}/pools`,
    { ...options, subject: tokenAddress }
  );
  return parsePools(json, tokenAddress);
}

type GtSimplePrice = {
  data?: {
    attributes?: {
      token_prices?: Record<string, string>;
      market_cap_usd?: Record<string, string | null>;
      h24_volume_usd?: Record<string, string>;
      h24_price_change_percentage?: Record<string, string>;
      total_reserve_in_usd?: Record<string, string>;
    };
  };
};

export function parseSimplePrices(
  json: GtSimplePrice | null,
  addresses: string[]
): Map<string, TokenMarketData> {
  const out = new Map<string, TokenMarketData>();
  const attributes = json?.data?.attributes;
  if (!attributes) return out;

  for (const address of addresses) {
    // The API lower-cases every key in the response regardless of the request.
    const key = address.toLowerCase();
    const priceUsd = num(attributes.token_prices?.[key]);
    if (priceUsd === null) continue;

    const data = emptyMarketData(key, "geckoterminal");
    data.priceUsd = priceUsd;
    data.marketCap = num(attributes.market_cap_usd?.[key]);
    data.volume24h = num(attributes.h24_volume_usd?.[key]);
    data.priceChange24h = num(attributes.h24_price_change_percentage?.[key]);
    data.liquidity = num(attributes.total_reserve_in_usd?.[key]);
    out.set(key, data);
  }

  return out;
}

/**
 * Up to thirty tokens per call, which is the whole reason this endpoint is used
 * for monitoring instead of the richer per-token one: at 30 calls a minute, one
 * token per call would cap the entire product at thirty watched tokens.
 */
export async function fetchBatch(
  addresses: string[],
  options: ProviderOptions = {}
): Promise<Map<string, TokenMarketData>> {
  const out = new Map<string, TokenMarketData>();

  for (const group of chunk(addresses, GT_MAX_BATCH)) {
    const query = new URLSearchParams({
      include_market_cap: "true",
      include_24hr_vol: "true",
      include_24hr_price_change: "true",
      include_total_reserve_in_usd: "true",
    });
    const json = await getJson<GtSimplePrice>(
      "GECKOTERMINAL",
      `${BASE}/simple/networks/${GT_NETWORK}/token_price/${group.join(",")}?${query}`,
      { ...options, subject: `${group.length} tokens` }
    );

    for (const [key, value] of parseSimplePrices(json, group)) out.set(key, value);
  }

  return out;
}
