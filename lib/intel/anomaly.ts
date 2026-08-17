import { deviation, changeOver, metric, seriesFrom, type BaselineStore, type Deviation } from "./baseline";
import { clamp, confidencePct } from "./score";

/**
 * Anomaly detection against a token's own recorded history.
 *
 * The brief asked for statistical comparison rather than hardcoded numbers, and
 * that is the only thing that works here anyway. Tokens on this chain span four
 * orders of magnitude of liquidity; a fixed "volume above $100K is unusual"
 * fires constantly on the large names and never on the small ones, which is the
 * same as having no detector.
 *
 * So every check asks the same question — how far is this from what this token
 * normally does — and the thresholds below are expressed in robust sigmas, which
 * carry the same meaning whatever the token's scale.
 *
 * The honest cost: a token with no recorded history cannot be judged. Those come
 * back with `sufficient: false` and produce no anomaly rather than a default one.
 */

export type AnomalyKind =
  | "volume_spike"
  | "price_move"
  | "liquidity_surge"
  | "liquidity_drain"
  | "buy_pressure"
  | "sell_pressure"
  | "holder_growth"
  | "whale_trade";

export type Anomaly = {
  kind: AnomalyKind;
  /** 0–100. How far outside normal, not how bad. */
  score: number;
  /** 0–95. How much history stands behind the judgement. */
  confidence: number;
  /** The measured move, for display. */
  changePct: number | null;
  sigma: number | null;
  /** One line a reader can check. */
  detail: string;
};

/**
 * Sigmas past which a reading counts as an event.
 *
 * Three is the conventional starting point and holds up here: with the median
 * and MAD as the reference, ordinary trading noise stays well inside it, while
 * the moves people actually notice sit far outside. Liquidity is stricter in
 * both directions because it moves in steps — a provider joins or leaves — and a
 * looser bound reports every routine deposit.
 */
export const SIGMA_THRESHOLDS: Record<string, number> = {
  volume: 3,
  price: 3,
  liquidity: 3.5,
  holders: 3,
};

/** Configurable, so a user can ask for more or less noise. */
export type AnomalyThresholds = {
  /** Multiplies the sigma bars above. Below 1 is more sensitive. */
  sensitivity: number;
  /** A single trade this many times the median counts as a whale print. */
  whaleMultiple: number;
  /** Minimum share of directional flow on one side, in percent. */
  pressurePct: number;
  /** Anomalies scoring below this are not reported. */
  minScore: number;
};

export const DEFAULT_ANOMALY: AnomalyThresholds = {
  sensitivity: 1,
  whaleMultiple: 20,
  pressurePct: 80,
  minScore: 55,
};

/**
 * Turns a deviation into a 0–100 score.
 *
 * Saturating rather than linear: past about twice the threshold the exact
 * multiple stops carrying information a reader can use — twelve sigma and twenty
 * sigma are both simply "this has never happened" — so the curve flattens
 * instead of letting one freak reading dominate every ranking it appears in.
 */
function scoreFromSigma(sigma: number, threshold: number): number {
  const excess = Math.abs(sigma) / threshold;
  if (excess < 1) return 0;
  return clamp(50 + 50 * (1 - Math.exp(-(excess - 1))));
}

function fromDeviation(
  kind: AnomalyKind,
  dev: Deviation,
  threshold: number,
  direction: "up" | "down" | "either",
  describe: (dev: Deviation) => string
): Anomaly | null {
  if (!dev.sufficient || dev.sigma === null) return null;
  if (direction === "up" && dev.sigma <= 0) return null;
  if (direction === "down" && dev.sigma >= 0) return null;

  const score = scoreFromSigma(dev.sigma, threshold);
  if (score === 0) return null;

  return {
    kind,
    score: Math.round(score),
    // More samples behind the median is a firmer claim; caps well short of certainty.
    confidence: confidencePct(Math.min(dev.samples / 48, 1)),
    changePct: dev.pct,
    sigma: dev.sigma,
    detail: describe(dev),
  };
}

const pct = (v: number | null, dp = 1) =>
  v === null ? "?" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(dp)}%`;

export type AnomalyInput = {
  address: string;
  symbol: string | null;
  priceUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  holders: number | null;
  /** Buy share of directional flow, 0–100. */
  buyPressurePct: number | null;
  /** Largest single trade in the recent window, USD. */
  largestTradeUsd: number | null;
  medianTradeUsd: number | null;
};

export type AnomalyReport = {
  address: string;
  symbol: string | null;
  anomalies: Anomaly[];
  /** The strongest score present, which is what ranks a token against others. */
  topScore: number;
  /** False when there is not enough recorded history to judge this token at all. */
  hasBaseline: boolean;
  samples: number;
};

/**
 * Scores one token against its recorded history.
 *
 * Pure: takes the baseline store rather than reading state, so the whole
 * detection path can be tested with a handmade history and no network.
 */
export function detectAnomalies(
  input: AnomalyInput,
  baselines: BaselineStore,
  thresholds: AnomalyThresholds = DEFAULT_ANOMALY
): AnomalyReport {
  const series = seriesFrom(baselines, input.address);
  const s = Math.max(thresholds.sensitivity, 0.1);
  const found: Anomaly[] = [];

  const volume = deviation(metric(series, "v"), input.volume24hUsd);
  const price = deviation(metric(series, "p"), input.priceUsd);
  const liquidity = deviation(metric(series, "l"), input.liquidityUsd);
  const holders = deviation(metric(series, "h"), input.holders);

  const add = (a: Anomaly | null) => {
    if (a && a.score >= thresholds.minScore) found.push(a);
  };

  add(
    fromDeviation("volume_spike", volume, SIGMA_THRESHOLDS.volume * s, "up", (d) =>
      `24h volume ${pct(d.pct)} against this token's own median`
    )
  );
  add(
    fromDeviation("price_move", price, SIGMA_THRESHOLDS.price * s, "either", (d) =>
      `price ${pct(d.pct, 2)} against its recent median`
    )
  );
  add(
    fromDeviation("liquidity_surge", liquidity, SIGMA_THRESHOLDS.liquidity * s, "up", (d) =>
      `liquidity ${pct(d.pct)} — depth added`
    )
  );
  add(
    fromDeviation("liquidity_drain", liquidity, SIGMA_THRESHOLDS.liquidity * s, "down", (d) =>
      `liquidity ${pct(d.pct)} — depth withdrawn`
    )
  );
  add(
    fromDeviation("holder_growth", holders, SIGMA_THRESHOLDS.holders * s, "up", (d) =>
      `holders ${pct(d.pct)} against its usual rate`
    )
  );

  /*
   * Flow imbalance needs no history — it is a property of the window itself, so
   * it works on a token first seen a minute ago. Confidence is fixed lower than
   * the baseline checks because one-sided flow over a couple of hours is a
   * weaker statement than a move measured against days of the token's own norm.
   */
  if (input.buyPressurePct !== null) {
    const p = input.buyPressurePct;
    if (p >= thresholds.pressurePct) {
      found.push({
        kind: "buy_pressure",
        score: Math.round(clamp(50 + (p - thresholds.pressurePct) * 2.5)),
        confidence: 60,
        changePct: null,
        sigma: null,
        detail: `${p.toFixed(0)}% of recent directional flow was buying`,
      });
    } else if (100 - p >= thresholds.pressurePct) {
      found.push({
        kind: "sell_pressure",
        score: Math.round(clamp(50 + (100 - p - thresholds.pressurePct) * 2.5)),
        confidence: 60,
        changePct: null,
        sigma: null,
        detail: `${(100 - p).toFixed(0)}% of recent directional flow was selling`,
      });
    }
  }

  // A whale print is judged against this token's own typical trade, so it means
  // the same thing on a token where $200 is large and one where $200 is dust.
  if (input.largestTradeUsd !== null && input.medianTradeUsd !== null && input.medianTradeUsd > 0) {
    const multiple = input.largestTradeUsd / input.medianTradeUsd;
    if (multiple >= thresholds.whaleMultiple) {
      found.push({
        kind: "whale_trade",
        score: Math.round(clamp(50 + Math.min(multiple / thresholds.whaleMultiple, 2) * 25)),
        confidence: 70,
        changePct: null,
        sigma: null,
        detail: `single trade of $${Math.round(input.largestTradeUsd).toLocaleString()}, ${multiple.toFixed(0)}× the median here`,
      });
    }
  }

  found.sort((a, b) => b.score - a.score);

  return {
    address: input.address.toLowerCase(),
    symbol: input.symbol,
    anomalies: found,
    topScore: found[0]?.score ?? 0,
    hasBaseline: volume.sufficient || price.sufficient || liquidity.sufficient,
    samples: Math.max(volume.samples, price.samples, liquidity.samples, holders.samples),
  };
}

/** Recent movement in plain terms, for the "why" explanation. */
export function recentMoves(baselines: BaselineStore, address: string, windowSec = 3600) {
  const series = seriesFrom(baselines, address);
  return {
    price: changeOver(series, "p", windowSec),
    liquidity: changeOver(series, "l", windowSec),
    volume: changeOver(series, "v", windowSec),
    holders: changeOver(series, "h", windowSec),
  };
}
