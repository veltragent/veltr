/**
 * Scoring, kept free of the network on purpose.
 *
 * Every function here takes numbers and returns numbers, so the judgement a
 * score encodes can be tested without a provider, a key or a fixture server. It
 * also means the rules are readable in one place instead of being scattered
 * through the code that fetches things.
 *
 * Two rules run through all of it:
 *
 *  - A missing input is not a zero. Scores carry the number of components that
 *    actually contributed, and a score assembled from two of six inputs says so
 *    rather than quietly reading as a weak result.
 *  - Confidence is about the evidence, not the conclusion. A high anomaly score
 *    from thin history is reported as a high score at low confidence, never
 *    softened into a middling score that looks better supported than it is.
 */

export const clamp = (v: number, lo = 0, hi = 100): number => Math.min(hi, Math.max(lo, v));

/** Maps a value onto 0–100 by where it sits between two reference points. */
export function ramp(value: number | null, zeroAt: number, hundredAt: number): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (hundredAt === zeroAt) return null;
  return clamp(((value - zeroAt) / (hundredAt - zeroAt)) * 100);
}

export type Component = { label: string; score: number | null; weight: number };

export type Score = {
  /** 0–100, or null when nothing contributed. */
  value: number | null;
  /** 0–1 — the share of total weight that had data behind it. */
  confidence: number;
  /** Which inputs were present, for the explanation. */
  present: string[];
  missing: string[];
};

/**
 * Weighted blend that reports its own coverage.
 *
 * Renormalises over the components that had data, so a missing input widens the
 * error bar instead of dragging the result toward zero — a token whose holder
 * count is unavailable should not score as a token with no holders.
 */
export function blend(components: Component[]): Score {
  const present = components.filter((c) => c.score !== null && Number.isFinite(c.score));
  const missing = components.filter((c) => !present.includes(c));

  const totalWeight = components.reduce((s, c) => s + c.weight, 0);
  const haveWeight = present.reduce((s, c) => s + c.weight, 0);

  if (haveWeight === 0 || totalWeight === 0) {
    return { value: null, confidence: 0, present: [], missing: components.map((c) => c.label) };
  }

  const value = present.reduce((s, c) => s + (c.score as number) * c.weight, 0) / haveWeight;

  return {
    value: Math.round(clamp(value)),
    confidence: haveWeight / totalWeight,
    present: present.map((c) => c.label),
    missing: missing.map((c) => c.label),
  };
}

/* ------------------------------------------------------- Market scoring */

/**
 * Liquidity depth.
 *
 * Anchored at ten thousand dollars because that is the floor the premium wall
 * already uses to decide whether a quoted price means anything, and at five
 * million because past that, depth stops being the binding constraint on this
 * chain. Logarithmic: the difference between $10K and $100K matters far more
 * than between $4M and $5M.
 */
export function liquidityScore(liquidityUsd: number | null, poolCount: number | null): Score {
  const depth =
    liquidityUsd === null || liquidityUsd <= 0
      ? null
      : ramp(Math.log10(liquidityUsd), Math.log10(10_000), Math.log10(5_000_000));

  // Several venues is a real difference: one pool is a single point of failure
  // for both price discovery and exit.
  const spread = poolCount === null ? null : ramp(poolCount, 1, 12);

  return blend([
    { label: "depth", score: depth, weight: 3 },
    { label: "venues", score: spread, weight: 1 },
  ]);
}

/**
 * Turnover — volume measured against the liquidity backing it.
 *
 * The ratio matters more than the raw figure. A million dollars of volume on
 * fifty thousand of liquidity is the same pool being traded through repeatedly,
 * which looks like interest and is closer to churn; the same volume on two
 * million of depth is ordinary activity.
 */
export function turnoverRatio(volume24hUsd: number | null, liquidityUsd: number | null): number | null {
  if (volume24hUsd === null || liquidityUsd === null || liquidityUsd <= 0) return null;
  return volume24hUsd / liquidityUsd;
}

/**
 * Buy pressure as a share of directional flow, 0–100.
 *
 * Null rather than 50 when nothing traded: an even split and no trades are
 * different facts, and reporting the second as the first invents a balanced
 * market on a token nobody touched.
 */
export function buyPressure(buys: number | null, sells: number | null): number | null {
  if (buys === null || sells === null) return null;
  const total = buys + sells;
  if (total <= 0) return null;
  return (buys / total) * 100;
}

/**
 * Momentum from the price changes a provider already reports.
 *
 * Short windows are weighted more heavily than long ones because the question
 * momentum answers is "is this happening now". The 24h figure is context.
 */
export function momentumScore(input: {
  change5m: number | null;
  change1h: number | null;
  change6h: number | null;
  change24h: number | null;
}): Score {
  return blend([
    { label: "5m", score: ramp(input.change5m, -3, 3), weight: 1 },
    { label: "1h", score: ramp(input.change1h, -8, 8), weight: 3 },
    { label: "6h", score: ramp(input.change6h, -15, 15), weight: 2 },
    { label: "24h", score: ramp(input.change24h, -25, 25), weight: 2 },
  ]);
}

/**
 * Volatility as the spread of a candle series, in percent of its own median.
 *
 * Range-based rather than a standard deviation of returns: it is what a reader
 * actually sees on a chart, and it needs far fewer bars to be meaningful.
 */
export function volatilityPct(closes: number[]): number | null {
  const clean = closes.filter((c) => Number.isFinite(c) && c > 0);
  if (clean.length < 3) return null;
  const hi = Math.max(...clean);
  const lo = Math.min(...clean);
  const mid = (hi + lo) / 2;
  return mid > 0 ? ((hi - lo) / mid) * 100 : null;
}

/* ------------------------------------------------------- Holder scoring */

export type Concentration = {
  /** Share of the examined holdings held by the top N non-contract addresses. */
  topSharePct: number | null;
  /** How many addresses that covers. */
  topN: number;
  /**
   * Whether pools and contracts were removed first.
   *
   * They always are, and it matters: the largest "holder" of almost every token
   * on this chain is its own liquidity pool, and counting that as concentration
   * would make every healthy token look captured by one address.
   */
  excludedContracts: number;
  /**
   * True only when the full holder set was examined.
   *
   * Never true in practice on this chain — the explorer serves fifty holders a
   * page against tokens with forty thousand — so this is a partial measure and
   * is labelled as one everywhere it surfaces.
   */
  complete: boolean;
};

export function concentration(
  holders: Array<{ address: string; isContract: boolean; value: number }>,
  topN = 10
): Concentration {
  const wallets = holders.filter((h) => !h.isContract && Number.isFinite(h.value) && h.value > 0);
  const excluded = holders.length - wallets.length;

  if (wallets.length === 0) {
    return { topSharePct: null, topN: 0, excludedContracts: excluded, complete: false };
  }

  const sorted = [...wallets].sort((a, b) => b.value - a.value);
  const total = sorted.reduce((s, h) => s + h.value, 0);
  const top = sorted.slice(0, topN).reduce((s, h) => s + h.value, 0);

  return {
    topSharePct: total > 0 ? (top / total) * 100 : null,
    topN: Math.min(topN, sorted.length),
    excludedContracts: excluded,
    complete: false,
  };
}

/**
 * Holder health: more holders is better, more concentrated is worse.
 *
 * Concentration is inverted before scoring — 80% in ten wallets is a low score,
 * not a high one.
 */
export function holderScore(holders: number | null, topSharePct: number | null): Score {
  const breadth = holders === null || holders <= 0 ? null : ramp(Math.log10(holders), 1, 4.5);
  const spread = topSharePct === null ? null : ramp(topSharePct, 90, 20);

  return blend([
    { label: "holders", score: breadth, weight: 2 },
    { label: "distribution", score: spread, weight: 2 },
  ]);
}

/* ---------------------------------------------------------- Risk scoring */

export type RiskInput = {
  liquidityUsd: number | null;
  topSharePct: number | null;
  holders: number | null;
  turnover: number | null;
  volatilityPct: number | null;
  /** A queued or applied corporate action — specific to this chain. */
  multiplierDrifted: boolean;
  /**
   * Contract-security concern level, 0-100, or null when unassessed.
   *
   * One weighted input rather than an override: a token can have a clean
   * contract and still be dangerous because its pool is three thousand dollars
   * deep, and a security score presented alone would say the opposite.
   */
  securityScore?: number | null;
};

/**
 * Risk, where 100 is the most dangerous.
 *
 * Inverted relative to every other score here, and named so it cannot be
 * confused: a high TOKEN SCORE is good, a high RISK SCORE is bad.
 */
export function riskScore(input: RiskInput): Score {
  const thin =
    input.liquidityUsd === null || input.liquidityUsd <= 0
      ? null
      : ramp(Math.log10(input.liquidityUsd), Math.log10(2_000_000), Math.log10(5_000));

  const captured = input.topSharePct === null ? null : ramp(input.topSharePct, 20, 90);
  const few = input.holders === null || input.holders <= 0 ? null : ramp(Math.log10(input.holders), 4.5, 1);

  // Turnover far above 1 means the pool is being cycled rather than invested in.
  const churn = input.turnover === null ? null : ramp(input.turnover, 0.5, 8);
  const swing = input.volatilityPct === null ? null : ramp(input.volatilityPct, 3, 40);

  const components: Component[] = [
    { label: "thin liquidity", score: thin, weight: 3 },
    { label: "concentration", score: captured, weight: 2 },
    { label: "few holders", score: few, weight: 1 },
    { label: "churn", score: churn, weight: 1 },
    { label: "volatility", score: swing, weight: 2 },
    { label: "contract security", score: input.securityScore ?? null, weight: 3 },
  ];

  const base = blend(components);
  if (base.value === null) return base;

  /*
   * A live multiplier drift is the one risk on this chain that is categorical
   * rather than a matter of degree: every wallet reading balanceOf is currently
   * reporting the wrong number for this token. It raises the floor rather than
   * adding a weighted component, because averaging it away would be the same
   * mistake as not knowing about it.
   */
  let value = input.multiplierDrifted ? Math.max(base.value, 55) : base.value;

  /*
   * A critical contract finding raises the floor too.
   *
   * Same reasoning as the multiplier drift: a token that cannot be fully sold is
   * not moderately risky on average with everything else, it is the one fact
   * that matters. Averaging is right for degrees and wrong for traps.
   */
  if ((input.securityScore ?? 0) >= 90) value = Math.max(value, 85);

  return { ...base, value };
}

/* --------------------------------------------------------- Presentation */

export type Band = "very low" | "low" | "moderate" | "high" | "very high";

export function band(score: number | null): Band | null {
  if (score === null) return null;
  if (score >= 80) return "very high";
  if (score >= 60) return "high";
  if (score >= 40) return "moderate";
  if (score >= 20) return "low";
  return "very low";
}

/**
 * Confidence as a percentage, floored at zero and never presented as certainty.
 *
 * Capped at 95: every input here is a third-party reading of a chain, and a
 * hundred percent would claim something no data pipeline earns.
 */
export function confidencePct(confidence: number): number {
  return Math.round(clamp(confidence * 100, 0, 95));
}
