import type { AlertKind, ArmState, TokenMarketData, TokenWatch, WatchSettings } from "./types";

/**
 * Alert condition engine.
 *
 * Pure: given a watch, a market reading and a user's settings, it returns the
 * alerts to send and the watch as it should be stored next. No I/O, no clock of
 * its own — `now` is passed in — so every transition below is directly testable.
 *
 * The whole design exists to answer one question correctly: *did this condition
 * just become true*, as opposed to *is this condition true*. Polling a sustained
 * move answers "yes" on every pass, which is how price bots become unusable.
 */

/**
 * Fraction of the threshold the price must retreat to before an alert re-arms.
 *
 * At 0.5 a +10% alert re-arms once the move has decayed to +5%, so a token that
 * climbs to +10% and keeps climbing produces exactly one alert, while a token
 * that genuinely round-trips and rallies again produces two.
 */
export const PRICE_REARM_FRACTION = 0.5;

/**
 * Dead band around a level threshold, as a fraction of the threshold.
 *
 * Market cap, liquidity and volume are not percentages of a baseline, so they
 * re-arm on a band around the level itself: a market cap oscillating by cents
 * across $1,000,000 would otherwise alert on every crossing.
 */
export const LEVEL_REARM_BAND = 0.05;

/**
 * Re-arm band for premium, in percentage points.
 *
 * A fixed distance rather than a fraction of the threshold, because the metric
 * is already a percentage and can sit near zero. The spread has to genuinely
 * close by a quarter of a point before the same alert can fire again.
 */
export const PREMIUM_REARM_POINTS = 0.25;

export const ALL_KINDS: AlertKind[] = [
  "priceUp",
  "priceDown",
  "marketCapAbove",
  "marketCapBelow",
  "liquidityAbove",
  "liquidityBelow",
  "volumeAbove",
  "volumeBelow",
  "premiumAbove",
  "premiumBelow",
];

export function fullyArmed(): ArmState {
  return {
    priceUp: true,
    priceDown: true,
    marketCapAbove: true,
    marketCapBelow: true,
    liquidityAbove: true,
    liquidityBelow: true,
    volumeAbove: true,
    volumeBelow: true,
    premiumAbove: true,
    premiumBelow: true,
  };
}

export type Alert = {
  kind: AlertKind;
  watchId: string;
  userId: string;
  tokenAddress: string;
  symbol: string | null;
  /** The metric that crossed: a price for price alerts, a dollar level otherwise. */
  value: number;
  /** For price alerts, the percentage threshold; otherwise the dollar level. */
  threshold: number;
  /** Percent move from baseline. Null for level alerts. */
  changePct: number | null;
  market: TokenMarketData;
  firedAt: string;
};

type Condition = {
  kind: AlertKind;
  /** The live metric, or null when this provider cycle could not establish it. */
  value: number | null;
  threshold: number | null;
  /** True when the alert condition currently holds. */
  crossed: boolean;
  /** True when the metric has retreated far enough to make the alert eligible again. */
  rearmed: boolean;
};

/**
 * Percent move from the baseline price.
 *
 * Returns null rather than 0 when either side is missing or the baseline is
 * zero — a division that cannot be performed is not a move of nothing.
 */
export function percentChange(baseline: number | null, current: number | null): number | null {
  if (baseline === null || current === null) return null;
  if (!Number.isFinite(baseline) || !Number.isFinite(current) || baseline <= 0) return null;
  return (current / baseline - 1) * 100;
}

/**
 * Builds the condition table for one reading.
 *
 * A condition whose metric or threshold is null is neither crossed nor re-armed,
 * so it can never fire and never silently flips the arm state. This is the single
 * place where "the provider had no data" is kept distinct from "the value is 0".
 */
function conditionsFor(
  watch: TokenWatch,
  market: TokenMarketData,
  settings: WatchSettings
): Condition[] {
  const price = market.priceUsd;
  const change = percentChange(watch.baselinePrice, price);

  const level = (
    kind: AlertKind,
    value: number | null,
    threshold: number | null,
    direction: "above" | "below"
  ): Condition => {
    if (value === null || threshold === null) {
      return { kind, value, threshold, crossed: false, rearmed: false };
    }
    // Magnitude, not the signed value: a negative threshold would otherwise
    // produce a negative band and re-arm in the wrong direction — which for a
    // dollar level never happened, since none of them can be negative.
    const band = Math.abs(threshold) * LEVEL_REARM_BAND;
    return direction === "above"
      ? { kind, value, threshold, crossed: value >= threshold, rearmed: value <= threshold - band }
      : { kind, value, threshold, crossed: value <= threshold, rearmed: value >= threshold + band };
  };

  /**
   * Premium against the underlying equity.
   *
   * Not `level`, for two reasons. The metric is signed — a discount is a
   * negative premium, and "alert below −3%" is the arbitrage case people
   * actually want — and it is already a percentage, so a re-arm band expressed
   * as a fraction of the threshold would be a fraction of a percentage. At a
   * threshold of 0.5% that band is 0.025 points, which the number crosses back
   * and forth on noise alone and fires again every cycle.
   *
   * So the band is a fixed number of percentage points, the unit the metric is
   * already in.
   *
   * When the equity market is shut the reading is suppressed entirely: the
   * reference price is the last close, so the "premium" is drift against a
   * stale number rather than a spread anyone could trade. Returning neither
   * crossed nor re-armed leaves the arm state untouched, so a position held at
   * the close resumes at the open rather than re-firing on the same spread.
   */
  const premiumCondition = (
    kind: "premiumAbove" | "premiumBelow",
    threshold: number | null,
    direction: "above" | "below"
  ): Condition => {
    const value = market.premiumPct;
    if (value === null || threshold === null || market.premiumIsStale) {
      return { kind, value, threshold, crossed: false, rearmed: false };
    }
    return direction === "above"
      ? {
          kind,
          value,
          threshold,
          crossed: value >= threshold,
          rearmed: value <= threshold - PREMIUM_REARM_POINTS,
        }
      : {
          kind,
          value,
          threshold,
          crossed: value <= threshold,
          rearmed: value >= threshold + PREMIUM_REARM_POINTS,
        };
  };

  const priceCondition = (kind: "priceUp" | "priceDown", threshold: number | null): Condition => {
    if (change === null || threshold === null || price === null) {
      return { kind, value: price, threshold, crossed: false, rearmed: false };
    }
    const rearmAt = threshold * PRICE_REARM_FRACTION;
    return kind === "priceUp"
      ? { kind, value: price, threshold, crossed: change >= threshold, rearmed: change <= rearmAt }
      : { kind, value: price, threshold, crossed: change <= -threshold, rearmed: change >= -rearmAt };
  };

  return [
    priceCondition("priceUp", settings.priceUpPct),
    priceCondition("priceDown", settings.priceDownPct),
    level("marketCapAbove", market.marketCap, settings.marketCapAbove, "above"),
    level("marketCapBelow", market.marketCap, settings.marketCapBelow, "below"),
    level("liquidityAbove", market.liquidity, settings.liquidityAbove, "above"),
    level("liquidityBelow", market.liquidity, settings.liquidityBelow, "below"),
    level("volumeAbove", market.volume24h, settings.volumeAbove, "above"),
    level("volumeBelow", market.volume24h, settings.volumeBelow, "below"),
    premiumCondition("premiumAbove", settings.premiumAbove, "above"),
    premiumCondition("premiumBelow", settings.premiumBelow, "below"),
  ];
}

export type EvaluationResult = {
  alerts: Alert[];
  watch: TokenWatch;
  /** Set when conditions held but the cooldown suppressed them. */
  suppressedByCooldown: AlertKind[];
};

/**
 * One evaluation pass for one user's watch.
 *
 * The first reading only establishes a baseline: a watch created while the token
 * already sits above a threshold must not alert on the fact that it was already
 * there. Alerts start from the first genuine transition afterwards.
 */
export function evaluateWatch(
  watch: TokenWatch,
  market: TokenMarketData,
  settings: WatchSettings,
  now: Date = new Date()
): EvaluationResult {
  const iso = now.toISOString();
  const conditions = conditionsFor(watch, market, settings);

  const next: TokenWatch = {
    ...watch,
    armed: { ...watch.armed },
    // A null reading leaves the previous value in place. Overwriting a real price
    // with null would destroy the baseline the next comparison depends on.
    lastPrice: market.priceUsd ?? watch.lastPrice,
    lastMarketCap: market.marketCap ?? watch.lastMarketCap,
    lastLiquidity: market.liquidity ?? watch.lastLiquidity,
    lastVolume: market.volume24h ?? watch.lastVolume,
    lastCheckedAt: iso,
    symbol: watch.symbol ?? market.symbol,
    name: watch.name ?? market.name,
    pairAddress: watch.pairAddress ?? market.pairAddress,
  };

  // Baseline missing — this is the establishing pass. Arm each condition against
  // where the token actually is, so nothing fires for a level it never crossed.
  if (watch.baselinePrice === null) {
    if (market.priceUsd !== null) next.baselinePrice = market.priceUsd;
    for (const c of conditions) next.armed[c.kind] = !c.crossed;
    return { alerts: [], watch: next, suppressedByCooldown: [] };
  }

  const cooldownActive =
    settings.alertCooldownSec > 0 &&
    watch.lastAlertAt !== null &&
    now.getTime() - new Date(watch.lastAlertAt).getTime() < settings.alertCooldownSec * 1000;

  const alerts: Alert[] = [];
  const suppressedByCooldown: AlertKind[] = [];

  for (const condition of conditions) {
    const armed = watch.armed[condition.kind] ?? true;

    if (!armed) {
      // Disarmed: the only transition available is back to eligible.
      if (condition.rearmed) next.armed[condition.kind] = true;
      continue;
    }

    if (!condition.crossed) continue;

    // Cooldown is the safety net behind re-arm, not a replacement for it: the
    // condition stays armed so a suppressed alert is delivered once the window
    // closes rather than being lost.
    if (cooldownActive) {
      suppressedByCooldown.push(condition.kind);
      continue;
    }

    next.armed[condition.kind] = false;
    alerts.push({
      kind: condition.kind,
      watchId: watch.id,
      userId: watch.userId,
      tokenAddress: watch.tokenAddress,
      symbol: watch.symbol ?? market.symbol,
      value: condition.value as number,
      threshold: condition.threshold as number,
      changePct: percentChange(watch.baselinePrice, market.priceUsd),
      market,
      firedAt: iso,
    });
  }

  if (alerts.length > 0) next.lastAlertAt = iso;

  return { alerts, watch: next, suppressedByCooldown };
}

/**
 * Re-points the arm state at the current settings without alerting.
 *
 * Called when a user changes a threshold. Without it, moving "MC Above" to $1M
 * while the token already sits at $1.02M fires immediately on the next pass —
 * reporting a crossing that never happened. Uses the values already stored on the
 * watch, so it costs no provider call.
 */
export function resyncArmState(watch: TokenWatch, settings: WatchSettings): TokenWatch {
  const stored: TokenMarketData = {
    address: watch.tokenAddress,
    symbol: watch.symbol,
    name: watch.name,
    price: null,
    priceUsd: watch.lastPrice,
    marketCap: watch.lastMarketCap,
    fdv: null,
    // No equity quote is read here — the point of a resync is that it costs no
    // provider call — so premium is unknown, which leaves its arm state alone.
    premiumPct: null,
    premiumIsStale: true,
    equityPriceUsd: null,
    liquidity: watch.lastLiquidity,
    volume24h: watch.lastVolume,
    priceChange5m: null,
    priceChange1h: null,
    priceChange6h: null,
    priceChange24h: null,
    buys: null,
    sells: null,
    pairAddress: watch.pairAddress,
    dex: null,
    url: null,
    source: [],
    updatedAt: watch.lastCheckedAt ?? watch.createdAt,
  };

  const armed = { ...watch.armed };
  for (const condition of conditionsFor(watch, stored, settings)) {
    // Only a condition with a usable reading can be judged. One with no stored
    // value keeps whatever arm state it had.
    if (condition.value === null || condition.threshold === null) continue;
    armed[condition.kind] = !condition.crossed;
  }

  return { ...watch, armed };
}
