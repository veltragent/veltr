import { readState } from "../store";
import { readBaselines } from "./baseline";
import { recentMoves } from "./anomaly";
import { deepScan, type DeepScan } from "./scan";

/**
 * Why a token is moving.
 *
 * The hard requirement here is epistemic rather than technical: the brief asked
 * that confirmed data, strong signals and possible explanations never be stated
 * in the same voice. On-chain data can show that volume tripled while three
 * wallets accumulated; it cannot show that one caused the other, and it can
 * never show *why* those wallets acted.
 *
 * So a driver carries its own standing, and the renderer prints that standing
 * next to it. Nothing in this file promotes a correlation to a cause — the only
 * thing allowed to phrase a cause is the model, and it is handed these labels
 * and told not to cross them.
 */

export type Standing =
  | "confirmed" // measured directly from a provider reading
  | "signal" // a strong statistical departure from this token's own norm
  | "possible"; // consistent with the data, but not established by it

export type Driver = {
  standing: Standing;
  text: string;
  /** 0–100. Present only where something was actually measured. */
  weight: number;
};

export type WhyReport = {
  address: string;
  symbol: string;
  priceChangePct: number | null;
  volumeChangePct: number | null;
  liquidityChangePct: number | null;
  buyPressurePct: number | null;
  smartMoney: DeepScan["smartMoney"];
  drivers: Driver[];
  /** 0–95. How much of the explanation rests on measured history. */
  confidence: number;
  /** Set when there is not enough recorded history to explain a move at all. */
  caveat: string | null;
  scan: DeepScan;
};

const pct = (v: number | null, dp = 1) =>
  v === null ? "?" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(dp)}%`;

const money = (v: number) => `$${Math.round(Math.abs(v)).toLocaleString()}`;

/**
 * Assembles the drivers.
 *
 * Ordered by standing first and weight second, so a reader meets the measured
 * facts before the interpretation — which is the whole point of separating them.
 */
export async function explainMove(symbolOrAddress: string, windowSec = 3600): Promise<WhyReport | null> {
  const scan = await deepScan(symbolOrAddress);
  if (!scan) return null;

  const state = await readState().catch(() => null);
  const moves = recentMoves(readBaselines(state), scan.address, windowSec);

  const drivers: Driver[] = [];

  // ---- Confirmed: things a provider reading states outright.
  if (moves.price.pct !== null) {
    drivers.push({
      standing: "confirmed",
      text: `Price ${pct(moves.price.pct, 2)} over the last ${(windowSec / 3600).toFixed(0)}h`,
      weight: Math.min(100, Math.abs(moves.price.pct) * 8),
    });
  }
  if (moves.volume.pct !== null) {
    drivers.push({
      standing: "confirmed",
      text: `24h volume ${pct(moves.volume.pct)}`,
      weight: Math.min(100, Math.abs(moves.volume.pct) / 2),
    });
  }
  if (moves.liquidity.pct !== null && Math.abs(moves.liquidity.pct) >= 1) {
    drivers.push({
      standing: "confirmed",
      text: `Liquidity ${pct(moves.liquidity.pct)} — ${moves.liquidity.pct > 0 ? "depth added" : "depth withdrawn"}`,
      weight: Math.min(100, Math.abs(moves.liquidity.pct) * 3),
    });
  }
  if (moves.holders.pct !== null && Math.abs(moves.holders.pct) >= 0.5) {
    drivers.push({
      standing: "confirmed",
      text: `Holders ${pct(moves.holders.pct, 2)}`,
      weight: Math.min(100, Math.abs(moves.holders.pct) * 10),
    });
  }
  if (scan.buyPressurePct !== null) {
    const p = scan.buyPressurePct;
    drivers.push({
      standing: "confirmed",
      text: `${p.toFixed(0)}% of recent directional flow was buying`,
      weight: Math.abs(p - 50) * 2,
    });
  }

  // ---- Signals: departures from this token's own recorded norm.
  for (const a of scan.anomalies.anomalies) {
    drivers.push({ standing: "signal", text: a.detail, weight: a.score });
  }

  if (scan.smartMoney.verdict === "accumulation" || scan.smartMoney.verdict === "distribution") {
    const side =
      scan.smartMoney.verdict === "accumulation" ? scan.smartMoney.accumulating : scan.smartMoney.distributing;
    drivers.push({
      standing: "signal",
      text: `${side.length} notable wallets ${scan.smartMoney.verdict === "accumulation" ? "accumulated" : "sold"}, net ${money(scan.smartMoney.netFlowUsd)} over ${scan.smartMoney.windowHours.toFixed(1)}h`,
      weight: scan.smartMoney.confidence,
    });
  }

  /*
   * ---- Possible: consistent with the data, not established by it.
   *
   * These are the only lines that reach toward causation, and each one names the
   * thing it cannot rule out. A tokenised stock moving while its exchange is
   * shut genuinely cannot be attributed to the equity — that is a real and
   * useful thing to say, and it stops well short of claiming what did cause it.
   */
  if (scan.premiumPct !== null && scan.premiumIsStale) {
    drivers.push({
      standing: "possible",
      text: `The US market is shut, so this move is on-chain only — the ${pct(scan.premiumPct, 2)} gap is drift against the last close, not a live spread`,
      weight: 40,
    });
  }

  if (scan.turnover !== null && scan.turnover > 3) {
    drivers.push({
      standing: "possible",
      text: `Turnover of ${scan.turnover.toFixed(1)}× liquidity — consistent with the same depth being traded through repeatedly rather than new money arriving`,
      weight: 45,
    });
  }

  if (scan.multiplierDrifted) {
    drivers.push({
      standing: "possible",
      text: "A corporate action has moved this token's uiMultiplier — check whether the move is the action rather than the market",
      weight: 60,
    });
  }

  const order: Record<Standing, number> = { confirmed: 0, signal: 1, possible: 2 };
  drivers.sort((a, b) => order[a.standing] - order[b.standing] || b.weight - a.weight);

  const measured = drivers.filter((d) => d.standing === "confirmed").length;
  const confidence = Math.min(95, Math.round((measured / 5) * 60 + (scan.anomalies.hasBaseline ? 25 : 0)));

  return {
    address: scan.address,
    symbol: scan.symbol,
    priceChangePct: moves.price.pct,
    volumeChangePct: moves.volume.pct,
    liquidityChangePct: moves.liquidity.pct,
    buyPressurePct: scan.buyPressurePct,
    smartMoney: scan.smartMoney,
    drivers: drivers.slice(0, 8),
    confidence,
    caveat: scan.anomalies.hasBaseline
      ? null
      : "No recorded history for this token yet, so nothing here is measured against its own norm. Veltr builds that history as it watches — ask again later for a stronger read.",
    scan,
  };
}
