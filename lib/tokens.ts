import type { Address } from "viem";
import { fetchErc20Tokens } from "./blockscout";
import { probeErc8056, readMultiplierState, WAD } from "./chain";
import { cached } from "./cache";

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

async function computeRadarSnapshot(): Promise<RadarSnapshot> {
  const [erc20s, stockSet] = await Promise.all([fetchErc20Tokens(), discoverStockTokens()]);

  const candidates = erc20s.filter((t) => stockSet.has(t.address_hash.toLowerCase()));
  const addresses = candidates.map((t) => t.address_hash);

  const states = await readMultiplierState(addresses);
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
      priceUsd: num(t.exchange_rate),
      volume24h: num(t.volume_24h),
      marketCap: num(t.circulating_market_cap),
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
