import { fetchWalletCounters, fetchWalletFirstSeen, fetchWalletTransfers } from "../blockscout";
import { codexWalletTrades } from "../codex";
import { readPortfolio } from "../portfolio";
import { blend, confidencePct, ramp, type Score } from "./score";

/**
 * What can be established about one address.
 *
 * The limits here are the honest ones, and they are worth stating plainly
 * because this is the feature most likely to be quietly faked:
 *
 *  - There is no cost basis on chain. A wallet's purchase price exists only if
 *    the buy is visible in a trade feed; tokens that arrived by transfer have no
 *    price at all. So realised profit is computed ONLY over trades actually seen,
 *    and is labelled as covering that subset — never presented as the wallet's
 *    P&L.
 *  - Win rate over months is not obtainable. The event feed is shallow, and a
 *    rate computed from a handful of visible round-trips would be a number with
 *    a percent sign and no meaning.
 *  - An address is not a person. Several may belong to one desk and one may be a
 *    router serving thousands. Nothing here claims identity, and the wording
 *    stays on behaviour.
 *
 * Everything that survives those limits is genuinely useful: age, activity,
 * what the wallet holds, how concentrated it is, and what it has been trading.
 */

export type Holding = {
  symbol: string;
  address: string;
  units: number;
  valueUsd: number | null;
  premiumPct: number | null;
};

export type TokenActivity = {
  token: string;
  symbol: string | null;
  transfers: number;
  firstSeen: number;
  lastSeen: number;
};

export type RealisedLeg = {
  symbol: string | null;
  token: string;
  buyUsd: number;
  sellUsd: number;
  /** Only meaningful when both sides are present in the visible window. */
  netUsd: number;
  trades: number;
};

export type WalletIntel = {
  address: string;
  /** Unix seconds, or null when the address has never received anything. */
  firstSeen: number | null;
  ageDays: number | null;
  transactions: number | null;
  tokenTransfers: number | null;

  holdings: Holding[];
  totalValueUsd: number | null;
  /** Share of the portfolio in its single largest position. */
  concentrationPct: number | null;
  distinctTokens: number;

  /** Tokens touched in the readable transfer history, most active first. */
  activity: TokenActivity[];
  /** Median gap between consecutive transfers, in hours. */
  medianGapHours: number | null;
  transfersPerDay: number | null;

  /** Realised flow over trades that were actually visible. Never the full P&L. */
  realised: RealisedLeg[];
  realisedNetUsd: number | null;
  realisedCoverage: string;

  score: Score;
  confidence: number;
  /** Named gaps, so a thin read is never mistaken for a thorough one. */
  unavailable: string[];
  generatedAt: string;
};

function medianOf(values: number[]): number | null {
  const clean = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!clean.length) return null;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
}

/**
 * Reads and scores one address.
 *
 * `deepTokens` bounds the expensive half: per-token trade lookups are the only
 * way to see buy and sell prices, and doing it for every token a wallet has ever
 * touched would be dozens of calls. The largest few positions are where the
 * answer actually is.
 */
export async function readWalletIntel(address: string, deepTokens = 3): Promise<WalletIntel> {
  const unavailable: string[] = [];

  const [counters, firstSeen, transfers, portfolio] = await Promise.all([
    fetchWalletCounters(address).catch(() => ({ transactions: null, tokenTransfers: null })),
    fetchWalletFirstSeen(address).catch(() => null),
    fetchWalletTransfers(address, 2).catch(() => []),
    readPortfolio(address).catch(() => null),
  ]);

  if (!portfolio) unavailable.push("token holdings");
  if (!transfers.length) unavailable.push("transfer history");
  if (firstSeen === null) unavailable.push("wallet age (no inbound transactions found)");

  const now = Math.floor(Date.now() / 1000);
  const ageDays = firstSeen ? (now - firstSeen) / 86400 : null;

  const holdings: Holding[] = (portfolio?.holdings ?? []).map((h) => ({
    symbol: h.symbol,
    address: h.address.toLowerCase(),
    units: h.units,
    valueUsd: h.valueUsd,
    premiumPct: h.premiumPct,
  }));

  const totalValueUsd = portfolio?.totalValueUsd ?? null;
  const largest = holdings.reduce((max, h) => Math.max(max, h.valueUsd ?? 0), 0);
  const concentrationPct = totalValueUsd && totalValueUsd > 0 ? (largest / totalValueUsd) * 100 : null;

  /* ---- Activity from the transfer history. */
  const byToken = new Map<string, TokenActivity>();
  for (const t of transfers) {
    const existing = byToken.get(t.token) ?? {
      token: t.token,
      symbol: t.symbol,
      transfers: 0,
      firstSeen: t.timestamp,
      lastSeen: t.timestamp,
    };
    existing.transfers++;
    existing.firstSeen = Math.min(existing.firstSeen, t.timestamp);
    existing.lastSeen = Math.max(existing.lastSeen, t.timestamp);
    byToken.set(t.token, existing);
  }
  const activity = [...byToken.values()].sort((a, b) => b.transfers - a.transfers).slice(0, 8);

  const times = transfers.map((t) => t.timestamp).sort((a, b) => b - a);
  const gaps = times.slice(1).map((t, i) => (times[i] - t) / 3600);
  const medianGapHours = medianOf(gaps);

  const span = times.length > 1 ? (times[0] - times[times.length - 1]) / 86400 : null;
  const transfersPerDay = span && span > 0 ? transfers.length / span : null;

  /*
   * ---- Realised flow, over the trades that were actually visible.
   *
   * This is buy dollars against sell dollars in the same token, from the trade
   * feed. It is not profit: a wallet that bought before the window and sold
   * inside it shows as pure sell, and one still holding shows as pure buy. The
   * coverage string travels with the number so it cannot be quoted alone.
   */
  const targets = holdings
    .slice()
    .sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0))
    .slice(0, deepTokens);

  const legs = await Promise.all(
    targets.map(async (h): Promise<RealisedLeg | null> => {
      const trades = await codexWalletTrades(h.address, address, 100).catch(() => []);
      if (!trades.length) return null;

      const buyUsd = trades.filter((t) => t.side === "buy").reduce((s, t) => s + (t.valueUsd ?? 0), 0);
      const sellUsd = trades.filter((t) => t.side === "sell").reduce((s, t) => s + (t.valueUsd ?? 0), 0);
      if (buyUsd === 0 && sellUsd === 0) return null;

      return { symbol: h.symbol, token: h.address, buyUsd, sellUsd, netUsd: sellUsd - buyUsd, trades: trades.length };
    })
  );

  const realised = legs.filter((l): l is RealisedLeg => l !== null);
  const realisedNetUsd = realised.length ? realised.reduce((s, l) => s + l.netUsd, 0) : null;

  if (realised.length === 0) {
    unavailable.push("visible trades for the largest holdings");
  }

  /*
   * ---- The score.
   *
   * Reads how established and how active an address is — not how good it is at
   * trading, which the data does not support. Named plainly for that reason.
   */
  const score = blend([
    { label: "age", score: ageDays === null ? null : ramp(ageDays, 0, 120), weight: 2 },
    {
      label: "activity",
      score: counters.transactions === null ? null : ramp(Math.log10(Math.max(counters.transactions, 1)), 0, 4),
      weight: 2,
    },
    {
      label: "portfolio",
      score: totalValueUsd === null ? null : ramp(Math.log10(Math.max(totalValueUsd, 1)), 2, 6),
      weight: 2,
    },
    // Spread across several positions scores above everything in one.
    { label: "diversification", score: concentrationPct === null ? null : ramp(concentrationPct, 100, 25), weight: 1 },
  ]);

  return {
    address: address.toLowerCase(),
    firstSeen,
    ageDays,
    transactions: counters.transactions,
    tokenTransfers: counters.tokenTransfers,
    holdings,
    totalValueUsd,
    concentrationPct,
    distinctTokens: holdings.length,
    activity,
    medianGapHours,
    transfersPerDay,
    realised,
    realisedNetUsd,
    realisedCoverage:
      realised.length > 0
        ? `Covers only trades visible in the feed for the ${realised.length} largest holding(s). Tokens received by transfer have no on-chain purchase price, so this is not the wallet's profit and loss.`
        : "No priced trades were visible, so no realised figure is shown. Nothing on chain records what an address paid.",
    score,
    confidence: confidencePct(score.confidence),
    unavailable,
    generatedAt: new Date().toISOString(),
  };
}

/** Evidence block for the model. */
export function walletEvidence(w: WalletIntel): string {
  const m = (v: number | null) => (v === null ? "unavailable" : `$${Math.round(v).toLocaleString()}`);

  return [
    `WALLET ${w.address}`,
    `age=${w.ageDays === null ? "unavailable" : `${w.ageDays.toFixed(1)}d`} transactions=${w.transactions ?? "unavailable"} tokenTransfers=${w.tokenTransfers ?? "unavailable"}`,
    `portfolioValue=${m(w.totalValueUsd)} distinctTokens=${w.distinctTokens} largestPositionShare=${w.concentrationPct === null ? "unavailable" : `${w.concentrationPct.toFixed(0)}%`}`,
    `transfersPerDay=${w.transfersPerDay?.toFixed(1) ?? "unavailable"} medianGapHours=${w.medianGapHours?.toFixed(1) ?? "unavailable"}`,
    `walletScore=${w.score.value ?? "n/a"} confidence=${w.confidence}%  (score reflects how established and active the address is — NOT trading skill)`,
    "",
    w.holdings.length
      ? `HOLDINGS\n${w.holdings.slice(0, 8).map((h) => `  ${h.symbol} ${h.units.toFixed(4)} ${m(h.valueUsd)}`).join("\n")}`
      : "HOLDINGS none",
    "",
    w.realised.length
      ? `VISIBLE TRADE FLOW\n${w.realised.map((r) => `  ${r.symbol ?? r.token} buys=${m(r.buyUsd)} sells=${m(r.sellUsd)} net=${m(r.netUsd)} trades=${r.trades}`).join("\n")}`
      : "VISIBLE TRADE FLOW none",
    `COVERAGE: ${w.realisedCoverage}`,
    "",
    w.unavailable.length ? `UNAVAILABLE: ${w.unavailable.join("; ")}` : "All sources answered.",
  ].join("\n");
}
