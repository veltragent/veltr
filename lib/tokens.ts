import type { Address } from "viem";
import { fetchErc20Tokens, type BlockscoutToken } from "./blockscout";
import { probeErc8056, readMultiplierState, WAD } from "./chain";
import { cached } from "./cache";
import { fetchDexQuotes, type DexQuote } from "./market";

/**
 * `scheduled` — a corporate action is queued on-chain and has not landed yet.
 * `drifted`   — the multiplier has already moved, so every integrator reading
 *               plain `balanceOf` is currently reporting the wrong exposure.
 * `clear`     — multiplier is exactly 1.0 and nothing is queued.
 */
export type Severity = "scheduled" | "drifted" | "clear";

export type StockToken = {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  iconUrl: string | null;
  holders: number;
  priceUsd: number | null;
  volume24h: number | null;
  marketCap: number | null;
  /** Summed across every pool this token is the base of. */
  liquidityUsd: number | null;
  poolCount: number;
  /** Which of the two the figures above came from, so the page can say. */
  priceSource: "dex" | "blockscout";

  multiplier: number;
  pendingMultiplier: number | null;
  effectiveAt: number | null;

  severity: Severity;
  /** Percent by which a raw `balanceOf` misstates true exposure right now. */
  reportingErrorPct: number;
  /** Percent move the queued action will apply to effective exposure. */
  actionDeltaPct: number | null;
  hoursUntilEffective: number | null;
  riskScore: number;
};

export type RadarSnapshot = {
  tokens: StockToken[];
  stats: {
    tracked: number;
    scheduled: number;
    drifted: number;
    holdersExposed: number;
    notionalAtRisk: number;
    largestErrorPct: number;
    largestErrorSymbol: string | null;
  };
  blockNumber: string | null;
  generatedAt: string;
};

const num = (v: string | null | undefined): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const DISCOVERY_TTL = 30 * 60_000;

/**
 * The set of ERC-8056 contracts on the chain, established by on-chain probe.
 *
 * Deliberately not filtered by name or icon first: CRWD, the token carrying the
 * largest multiplier on the chain, serves its logo from CoinGecko rather than
 * Robinhood's CDN and would be dropped by any such heuristic.
 */
async function discoverStockTokens(): Promise<Map<string, bigint>> {
  return cached(
    "erc8056-set",
    DISCOVERY_TTL,
    async () => {
      const erc20s = await fetchErc20Tokens();
      const addresses = erc20s.map((t) => t.address_hash);

      let found = await probeErc8056(addresses);

      // The probe is ~600 contract calls in one pass; a throttled provider can
      // return nothing at all. Retry once through the unmetered public endpoint
      // before accepting an empty answer.
      if (found.length === 0 && addresses.length > 0) {
        console.warn("[veltr] ERC-8056 probe returned nothing; retrying via public RPC");
        found = await probeErc8056(addresses, { usePublicFallback: true });
      }

      return new Map(found.map((f) => [f.address.toLowerCase(), f.uiMultiplier]));
    },
    // An empty set means the probe failed, not that the chain has no stock
    // tokens. Never let that become the cached answer.
    (set) => set.size > 0
  );
}

function classify(multiplier: number, pending: number | null, effectiveAt: number | null) {
  const reportingErrorPct = (multiplier - 1) * 100;

  const hasPending = pending !== null && Math.abs(pending - multiplier) > 1e-12;
  const actionDeltaPct = hasPending ? (pending / multiplier - 1) * 100 : null;
  const hoursUntilEffective =
    hasPending && effectiveAt ? (effectiveAt * 1000 - Date.now()) / 3_600_000 : null;

  let severity: Severity = "clear";
  if (hasPending) severity = "scheduled";
  else if (Math.abs(reportingErrorPct) > 1e-9) severity = "drifted";

  // Queued actions always outrank drift; within a tier, magnitude decides.
  const riskScore = hasPending
    ? 1000 + Math.abs(actionDeltaPct ?? 0)
    : Math.abs(reportingErrorPct);

  return { severity, reportingErrorPct, actionDeltaPct, hoursUntilEffective, riskScore };
}

/**
 * How long a snapshot is reused.
 *
 * Short, because the multiplier state it carries is the product's early-warning
 * signal. The watcher does not use the cache at all, so this bounds only how
 * stale a *read* can be, not how quickly a corporate action is detected.
 */
const SNAPSHOT_TTL = 30_000;

/**
 * Builds the radar snapshot: discover stock tokens from Blockscout, then read
 * the ERC-8056 multiplier triple for all of them in a single multicall.
 *
 * Discovery is interface-based rather than registry-based — a token that answers
 * `uiMultiplier()` is a stock token — so the set stays correct as Robinhood
 * lists new symbols without us hardcoding an address list.
 *
 * `fresh` bypasses the cache. Only the watcher passes it: everything else is a
 * read that can tolerate a few seconds of age, and the multicall behind this is
 * 285 contract calls.
 */
export async function buildRadarSnapshot(options: { fresh?: boolean } = {}): Promise<RadarSnapshot> {
  if (options.fresh) return computeRadarSnapshot();

  return cached(
    "radar-snapshot",
    SNAPSHOT_TTL,
    computeRadarSnapshot,
    // An empty snapshot is a failed read, not an empty chain. Caching it would
    // serve nothing to every caller for the whole TTL, with no error anywhere.
    (snapshot) => snapshot.tokens.length > 0
  );
}

/**
 * Price, liquidity, volume and market cap for one token.
 *
 * Blockscout publishes all four as precomputed fields and every one of them was
 * being trusted verbatim. Checked against the pools they claim to describe, they
 * do not hold up: for NVDA it reported $1.22M of 24h volume against $4.00M
 * actually traded, and a market cap of $3.887M that disagrees with its own
 * supply times its own price ($4.013M). Across tokens the error ran +7.8%,
 * +3.2%, −20.7%, −9.6%, and CRWD came back as a market cap of zero while
 * holding supply.
 *
 * So the figures are derived here instead, from data this process fetched:
 * price and the pool totals from DexScreener, supply from the chain.
 *
 * Market cap uses `totalSupplyUI`. The raw supply is wrong by exactly the
 * multiplier after a corporate action — the same misreporting this product
 * exists to warn people about, which makes it the one place it must not appear.
 *
 * Blockscout is still the fallback where there is no pool at all: a token with
 * no liquidity has no DEX price, and a stale figure is better than an empty
 * column as long as nothing else is derived from it.
 */
function priced(
  t: BlockscoutToken,
  state: { totalSupplyUI: bigint | null } | undefined,
  quote: DexQuote | null
): Pick<StockToken, "priceUsd" | "volume24h" | "marketCap" | "liquidityUsd" | "poolCount" | "priceSource"> {
  const decimals = Number(t.decimals ?? 18);
  const supplyUI =
    state?.totalSupplyUI != null ? Number(state.totalSupplyUI) / 10 ** decimals : null;

  if (!quote) {
    /**
     * No indexed pool at all — thirty-eight of the ninety-five.
     *
     * Blockscout's price is then the only one there is, and it holds up:
     * sampled against the shares themselves it lands within a few percent,
     * which is what a tokenised stock should do. Its *market cap* still does
     * not, so that is computed here from the same supply and the same price
     * rather than taken from a field that disagrees with both.
     *
     * Liquidity stays null. No pool is indexed, so there is no figure to give,
     * and a zero would read as "none" rather than "not known".
     */
    const price = num(t.exchange_rate);
    return {
      priceUsd: price,
      volume24h: num(t.volume_24h),
      marketCap: supplyUI !== null && price !== null ? supplyUI * price : null,
      liquidityUsd: null,
      poolCount: 0,
      priceSource: "blockscout",
    };
  }

  return {
    priceUsd: quote.priceUsd,
    volume24h: quote.volume24hUsd,
    liquidityUsd: quote.liquidityUsd,
    poolCount: quote.poolCount,
    // Null rather than a guess when the supply could not be read: a market cap
    // is a product of two numbers and inventing either one is worse than a dash.
    marketCap: supplyUI !== null ? supplyUI * quote.priceUsd : null,
    priceSource: "dex",
  };
}

async function computeRadarSnapshot(): Promise<RadarSnapshot> {
  const [erc20s, stockSet] = await Promise.all([fetchErc20Tokens(), discoverStockTokens()]);

  const candidates = erc20s.filter((t) => stockSet.has(t.address_hash.toLowerCase()));
  const addresses = candidates.map((t) => t.address_hash);

  // One multicall for the chain state, four batched requests for the pools.
  const [states, quotes] = await Promise.all([
    readMultiplierState(addresses),
    fetchDexQuotes(addresses).catch(() => new Map()),
  ]);
  const stateByAddress = new Map(states.map((s) => [s.address.toLowerCase(), s]));

  const tokens: StockToken[] = [];

  for (const t of candidates) {
    const state = stateByAddress.get(t.address_hash.toLowerCase());
    // No multiplier means it does not implement ERC-8056 — not a stock token.
    if (!state?.uiMultiplier) continue;

    const multiplier = Number(state.uiMultiplier) / Number(WAD);
    const pendingRaw = state.newUIMultiplier;
    const pendingMultiplier = pendingRaw !== null ? Number(pendingRaw) / Number(WAD) : null;
    const effectiveAt = state.effectiveAt ? Number(state.effectiveAt) : null;

    const c = classify(multiplier, pendingMultiplier, effectiveAt);

    tokens.push({
      address: t.address_hash,
      symbol: t.symbol,
      name: t.name?.replace(/\s*•\s*Robinhood Token$/i, "").trim() || t.symbol,
      decimals: Number(t.decimals ?? 18),
      iconUrl: t.icon_url,
      holders: Number(t.holders_count ?? 0),
      ...priced(t, state, quotes.get(t.address_hash.toLowerCase()) ?? null),
      multiplier,
      pendingMultiplier,
      effectiveAt,
      ...c,
    });
  }

  tokens.sort((a, b) => b.riskScore - a.riskScore || b.holders - a.holders);

  const drifted = tokens.filter((t) => t.severity === "drifted");
  const scheduled = tokens.filter((t) => t.severity === "scheduled");
  const affected = [...drifted, ...scheduled];

  const worst = affected.reduce<StockToken | null>(
    (acc, t) => (!acc || Math.abs(t.reportingErrorPct) > Math.abs(acc.reportingErrorPct) ? t : acc),
    null
  );

  return {
    tokens,
    stats: {
      tracked: tokens.length,
      scheduled: scheduled.length,
      drifted: drifted.length,
      holdersExposed: affected.reduce((sum, t) => sum + t.holders, 0),
      notionalAtRisk: affected.reduce((sum, t) => sum + (t.marketCap ?? 0), 0),
      largestErrorPct: worst ? Math.abs(worst.reportingErrorPct) : 0,
      largestErrorSymbol: worst?.symbol ?? null,
    },
    blockNumber: null,
    generatedAt: new Date().toISOString(),
  };
}
