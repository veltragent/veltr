import { isAddress } from "viem";
import { getJson } from "./watch/http";
import { DS_CHAIN_ID, parsePairs, selectPair, type DsPair } from "./watch/providers/dexscreener";
import { fetchTokenMarketData } from "./watch/aggregate";
import { buildRadarSnapshot } from "./tokens";
import type { TokenMarketData } from "./watch/types";

/**
 * Resolving a token from what a person actually typed.
 *
 * The gap this closes: the agent could look up any *tokenised stock* by ticker
 * and any token at all by address, but had no way to answer "what is the AI
 * token doing" — a real token on this chain with a million dollars of
 * liquidity — because it is not an equity.
 *
 * The reason this is its own module rather than three lines calling a search
 * endpoint is that symbols on this chain are not unique, and the collision is
 * not hypothetical. Searching "NVDA" returns two tokens:
 *
 *   0xd0601CE…  NVIDIA • Robinhood Token   $225.67    $1.40M liquidity
 *   0xDeCF74…   NVDA                       $0.00000034   $31K liquidity
 *
 * The second is not the tokenised stock. A lookup that ranked by relevance, or
 * simply took the first result, would quote it — and every downstream number,
 * premium and chart would be about the wrong asset. So the ERC-8056 registry is
 * always consulted first, and anything found only through a DEX search is
 * returned flagged as unverified.
 */

const DS_SEARCH = "https://api.dexscreener.com/latest/dex/search";

export type TokenKind =
  /** Implements ERC-8056 and is in the on-chain stock registry. Authoritative. */
  | "stock-token"
  /** Trades on this chain, but its symbol is claimed by whoever deployed it. */
  | "dex-token";

export type Candidate = {
  address: string;
  symbol: string | null;
  name: string | null;
  liquidityUsd: number | null;
  priceUsd: number | null;
};

export type TokenIdentity = {
  address: string;
  symbol: string | null;
  name: string | null;
  kind: TokenKind;
  /** True only when the address came from the ERC-8056 registry. */
  verified: boolean;
  market: TokenMarketData | null;
  /** Other tokens answering to the same symbol, deepest first. */
  alternates: Candidate[];
  /** Set whenever the answer needs a caveat the caller must pass on. */
  warning: string | null;
};

function toCandidate(pair: DsPair): Candidate {
  return {
    address: pair.baseToken?.address ?? "",
    symbol: pair.baseToken?.symbol ?? null,
    name: pair.baseToken?.name ?? null,
    liquidityUsd: pair.liquidity?.usd ?? null,
    priceUsd: Number(pair.priceUsd) || null,
  };
}

/**
 * Ranks search hits for a typed query.
 *
 * Deepest liquidity wins among equally good name matches, because liquidity is
 * the one property a copycat cannot cheaply fake. An exact symbol match is
 * preferred over a partial one, so searching "AI" does not return "AIXBT".
 */
export function rankCandidates(pairs: DsPair[], query: string): Candidate[] {
  const wanted = query.trim().toLowerCase();

  const onChain = pairs.filter((p) => p.chainId === DS_CHAIN_ID && p.baseToken?.address);

  // One entry per token: a token with six pools is one candidate, at its
  // deepest pool.
  const byAddress = new Map<string, DsPair>();
  for (const pair of onChain) {
    const address = pair.baseToken!.address!.toLowerCase();
    const existing = byAddress.get(address);
    if (!existing || (pair.liquidity?.usd ?? 0) > (existing.liquidity?.usd ?? 0)) {
      byAddress.set(address, pair);
    }
  }

  /**
   * Match quality as tiers, not as a sum.
   *
   * Scoring these additively let a weak name match outrank liquidity: searching
   * "AI" returned "Open AI" at $302K over "Artificial Inu" at $921K, purely
   * because the former's name also contains the query. Both are exact symbol
   * matches, and among equals the only signal worth anything is the one a
   * copycat cannot cheaply fake — depth. So the tier decides rank, and liquidity
   * decides everything within a tier.
   */
  const tierOf = (symbol: string, name: string): number => {
    if (symbol === wanted) return 0;
    if (name === wanted) return 1;
    if (symbol.startsWith(wanted)) return 2;
    if (name.includes(wanted)) return 3;
    return -1;
  };

  return [...byAddress.values()]
    .map((pair) => ({
      pair,
      tier: tierOf(
        (pair.baseToken?.symbol ?? "").toLowerCase(),
        (pair.baseToken?.name ?? "").toLowerCase()
      ),
    }))
    .filter((entry) => entry.tier >= 0)
    .sort((a, b) => a.tier - b.tier || (b.pair.liquidity?.usd ?? 0) - (a.pair.liquidity?.usd ?? 0))
    .map((entry) => toCandidate(entry.pair));
}

async function searchPairs(query: string): Promise<DsPair[]> {
  const json = await getJson<{ pairs?: DsPair[] }>(
    "DEXSCREENER",
    `${DS_SEARCH}?q=${encodeURIComponent(query)}`,
    { subject: query }
  );
  return json?.pairs ?? [];
}

/** The ERC-8056 registry, as a symbol and address index. */
async function stockIndex() {
  const snapshot = await buildRadarSnapshot().catch(() => null);
  const tokens = snapshot?.tokens ?? [];
  return {
    bySymbol: new Map(tokens.map((t) => [t.symbol.toUpperCase(), t])),
    byAddress: new Map(tokens.map((t) => [t.address.toLowerCase(), t])),
  };
}

/**
 * Resolves a symbol, a name or an address to one token.
 *
 * Registry first, always. A ticker that names a tokenised stock resolves to that
 * stock even when a copycat has deeper search relevance, and the copycat is
 * reported as an alternate rather than hidden — someone asking about NVDA should
 * learn that a second NVDA exists, not be quietly handed either one.
 */
export async function lookupToken(query: string): Promise<TokenIdentity | null> {
  const raw = query.trim();
  if (!raw) return null;

  const index = await stockIndex();

  /* ------------------------------------------------------ By address */

  if (isAddress(raw)) {
    const known = index.byAddress.get(raw.toLowerCase());
    const market = await fetchTokenMarketData(raw, { deep: true }).catch(() => null);

    if (!known && !market) return null;

    // An address whose symbol belongs to a registry token, but which is not that
    // token, is the impersonation case seen from the other direction.
    const symbol = known?.symbol ?? market?.symbol ?? null;
    const collides = symbol ? index.bySymbol.get(symbol.toUpperCase()) : undefined;

    return {
      address: raw,
      symbol,
      name: known?.name ?? market?.name ?? null,
      kind: known ? "stock-token" : "dex-token",
      verified: Boolean(known),
      market,
      alternates: [],
      warning: known
        ? null
        : collides
          ? `This address is NOT the tokenised ${collides.symbol}. The real one is ${collides.address}. Symbols are not unique on this chain.`
          : "Not in the ERC-8056 stock registry — an ordinary token on this chain, whose symbol is chosen by whoever deployed it.",
    };
  }

  /* ------------------------------------------------- By symbol or name */

  const registryHit = index.bySymbol.get(raw.toUpperCase());
  const pairs = await searchPairs(raw).catch(() => [] as DsPair[]);
  const ranked = rankCandidates(pairs, raw);

  if (registryHit) {
    const market = await fetchTokenMarketData(registryHit.address, { deep: true }).catch(() => null);

    // Anything else answering to this ticker is an impostor by definition: the
    // registry holds exactly one token per symbol.
    const impostors = ranked.filter(
      (c) => c.address.toLowerCase() !== registryHit.address.toLowerCase()
    );

    return {
      address: registryHit.address,
      symbol: registryHit.symbol,
      name: registryHit.name,
      kind: "stock-token",
      verified: true,
      market,
      alternates: impostors,
      warning:
        impostors.length > 0
          ? `${impostors.length} other token${impostors.length === 1 ? "" : "s"} on this chain also use the symbol ${registryHit.symbol}. The figures above are the tokenised stock at ${registryHit.address}; the others are unrelated.`
          : null,
    };
  }

  const best = ranked[0];
  if (!best?.address) return null;

  const market = await fetchTokenMarketData(best.address, { deep: true }).catch(() => null);

  return {
    address: best.address,
    symbol: best.symbol,
    name: best.name,
    kind: "dex-token",
    verified: false,
    market,
    alternates: ranked.slice(1, 5),
    warning:
      "Not a tokenised stock. Its symbol is chosen by whoever deployed it and is not unique — this is the deepest-liquidity match, not an authoritative one. Confirm the address before acting on it.",
  };
}

/** Direct pair lookup for an address, used when only market data is wanted. */
export async function marketForAddress(address: string): Promise<TokenMarketData | null> {
  const pairs = await searchPairs(address).catch(() => [] as DsPair[]);
  const pair = selectPair(pairs, address);
  return pair ? parsePairs(pairs, address) : fetchTokenMarketData(address);
}
