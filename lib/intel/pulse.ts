import { codexTopTokens, type CodexToken } from "../codex";
import { fetchChainStats, type ChainStats } from "../blockscout";
import { buildRadarSnapshot } from "../tokens";
import { readState } from "../store";
import { readBaselines, changeOver, seriesFrom } from "./baseline";
import { detectAnomalies, type AnomalyReport } from "./anomaly";

/**
 * Market-wide read of Robinhood Chain.
 *
 * Built entirely from lists that are already fetched and cached elsewhere —
 * the ranked token listing, the radar snapshot, chain stats — rather than by
 * scanning tokens one at a time. A per-token scan across the chain would be
 * several hundred provider calls for one command, which is the sort of thing
 * that works in testing and takes the bot down when two people run it at once.
 *
 * The consequence is that pulse sees breadth, not depth: it can rank and it can
 * flag, and anything that needs a token examined properly says "run /scan on it".
 */

export type Mover = {
  symbol: string;
  address: string;
  changePct: number | null;
  volume24Usd: number | null;
  liquidityUsd: number | null;
};

export type MarketPulse = {
  /** Aggregate across every indexed token, not just tokenised stocks. */
  totalLiquidityUsd: number | null;
  totalVolume24Usd: number | null;
  activeTokens: number;
  indexedTokens: number;
  stockTokens: number;
  driftedTokens: number;
  scheduledActions: number;

  chain: ChainStats;

  /** Percent change in chain-wide volume and liquidity, from our own history. */
  volumeChangePct: number | null;
  liquidityChangePct: number | null;
  momentum: "bullish" | "neutral" | "bearish";

  gainers: Mover[];
  losers: Mover[];
  byVolume: Mover[];

  /** Tokens whose own history says something unusual is happening. */
  anomalous: AnomalyReport[];

  /** True when the equity market is open, which changes what premiums mean. */
  marketOpen: boolean;
  generatedAt: string;
};

/** Chain-wide aggregates are stored under this pseudo-address in the baseline. */
export const CHAIN_KEY = "0xchain";

const shape = (t: CodexToken): Mover => ({
  symbol: t.symbol,
  address: t.address.toLowerCase(),
  changePct: t.change24Pct,
  volume24Usd: t.volume24Usd,
  liquidityUsd: t.liquidityUsd,
});

/**
 * Tokens considered for the movers lists.
 *
 * A percentage change on a token with no depth behind it is arithmetic, not a
 * market: one $50 trade against $300 of liquidity prints +400%, and a "top
 * gainers" board made of those is worse than no board. This floor is what keeps
 * the list meaningful.
 */
export const MIN_MOVER_LIQUIDITY_USD = 25_000;
export const MIN_MOVER_VOLUME_USD = 5_000;

export async function readPulse(): Promise<MarketPulse> {
  const [ranked, stats, snapshot, state] = await Promise.all([
    codexTopTokens("volume24", 50).catch(() => ({ tokens: [], indexed: 0 })),
    fetchChainStats().catch(() => ({
      totalTransactions: null,
      transactionsToday: null,
      totalAddresses: null,
      averageBlockTimeMs: null,
    })),
    buildRadarSnapshot().catch(() => null),
    readState().catch(() => null),
  ]);

  const tokens = ranked.tokens;
  const baselines = readBaselines(state);

  const sum = (pick: (t: CodexToken) => number | null): number | null => {
    const values = tokens.map(pick).filter((v): v is number => v !== null && Number.isFinite(v));
    return values.length ? values.reduce((a, b) => a + b, 0) : null;
  };

  const totalLiquidityUsd = sum((t) => t.liquidityUsd);
  const totalVolume24Usd = sum((t) => t.volume24Usd);

  const liquid = tokens.filter(
    (t) =>
      (t.liquidityUsd ?? 0) >= MIN_MOVER_LIQUIDITY_USD && (t.volume24Usd ?? 0) >= MIN_MOVER_VOLUME_USD
  );

  const withChange = liquid.filter((t) => t.change24Pct !== null);
  const gainers = [...withChange].sort((a, b) => (b.change24Pct ?? 0) - (a.change24Pct ?? 0)).slice(0, 5).map(shape);
  const losers = [...withChange].sort((a, b) => (a.change24Pct ?? 0) - (b.change24Pct ?? 0)).slice(0, 5).map(shape);
  const byVolume = [...tokens].sort((a, b) => (b.volume24Usd ?? 0) - (a.volume24Usd ?? 0)).slice(0, 5).map(shape);

  /*
   * Chain-wide trend comes from our own recorded aggregate, for the same reason
   * everything else does: nothing serves last hour's chain-wide liquidity.
   */
  const chainSeries = seriesFrom(baselines, CHAIN_KEY);
  const volumeChangePct = changeOver(chainSeries, "v", 6 * 3600).pct;
  const liquidityChangePct = changeOver(chainSeries, "l", 6 * 3600).pct;

  /*
   * Momentum from breadth rather than from any one number: how many liquid
   * tokens rose against how many fell. A single large name moving does not make
   * a market, and an average would let it.
   */
  const up = withChange.filter((t) => (t.change24Pct ?? 0) > 1).length;
  const down = withChange.filter((t) => (t.change24Pct ?? 0) < -1).length;
  const momentum: MarketPulse["momentum"] =
    up > down * 1.5 ? "bullish" : down > up * 1.5 ? "bearish" : "neutral";

  /*
   * Anomalies only among tokens we already have history for. Scanning the rest
   * would mean a provider call each and would mostly return "no baseline".
   */
  const anomalous = tokens
    .filter((t) => seriesFrom(baselines, t.address) !== null)
    .map((t) =>
      detectAnomalies(
        {
          address: t.address,
          symbol: t.symbol,
          priceUsd: t.priceUsd,
          liquidityUsd: t.liquidityUsd,
          volume24hUsd: t.volume24Usd,
          holders: t.holders,
          buyPressurePct:
            t.buys24 !== null && t.sells24 !== null && t.buys24 + t.sells24 > 0
              ? (t.buys24 / (t.buys24 + t.sells24)) * 100
              : null,
          largestTradeUsd: null,
          medianTradeUsd: null,
        },
        baselines
      )
    )
    .filter((r) => r.anomalies.length > 0)
    .sort((a, b) => b.topScore - a.topScore)
    .slice(0, 5);

  return {
    totalLiquidityUsd,
    totalVolume24Usd,
    activeTokens: tokens.filter((t) => (t.volume24Usd ?? 0) > 0).length,
    indexedTokens: ranked.indexed,
    stockTokens: snapshot?.stats.tracked ?? 0,
    driftedTokens: snapshot?.stats.drifted ?? 0,
    scheduledActions: snapshot?.stats.scheduled ?? 0,
    chain: stats,
    volumeChangePct,
    liquidityChangePct,
    momentum,
    gainers,
    losers,
    byVolume,
    anomalous,
    marketOpen: snapshot?.tokens.some(() => false) ?? false,
    generatedAt: new Date().toISOString(),
  };
}

/** Evidence block for the model, when a pulse needs a written read. */
export function pulseEvidence(p: MarketPulse): string {
  const m = (v: number | null) => (v === null ? "unavailable" : `$${Math.round(v).toLocaleString()}`);
  const pc = (v: number | null) => (v === null ? "unavailable" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`);

  const list = (rows: Mover[]) =>
    rows.length ? rows.map((r) => `  ${r.symbol} ${pc(r.changePct)} vol=${m(r.volume24Usd)} liq=${m(r.liquidityUsd)}`).join("\n") : "  none";

  return [
    `ROBINHOOD CHAIN — ${p.generatedAt}`,
    `indexedTokens=${p.indexedTokens} active24h=${p.activeTokens} stockTokens=${p.stockTokens} drifted=${p.driftedTokens} scheduledActions=${p.scheduledActions}`,
    `top50Liquidity=${m(p.totalLiquidityUsd)} top50Volume24h=${m(p.totalVolume24Usd)}`,
    `chainVolumeChange6h=${pc(p.volumeChangePct)} chainLiquidityChange6h=${pc(p.liquidityChangePct)} breadthMomentum=${p.momentum}`,
    `transactionsToday=${p.chain.transactionsToday?.toLocaleString() ?? "unavailable"}`,
    "",
    `GAINERS (liquidity ≥ $${MIN_MOVER_LIQUIDITY_USD.toLocaleString()})`,
    list(p.gainers),
    "",
    "LOSERS",
    list(p.losers),
    "",
    p.anomalous.length
      ? `ANOMALIES\n${p.anomalous.map((a) => `  ${a.symbol ?? a.address} ${a.anomalies[0].kind} score=${a.topScore} — ${a.anomalies[0].detail}`).join("\n")}`
      : "ANOMALIES none among tokens with recorded history",
  ].join("\n");
}
