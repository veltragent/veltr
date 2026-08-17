import test from "node:test";
import assert from "node:assert/strict";

import { changeOver, deviation, mad, median, metric, MIN_SAMPLES, type Series } from "../lib/intel/baseline";
import { detectAnomalies, DEFAULT_ANOMALY } from "../lib/intel/anomaly";

/**
 * Baselines and anomaly detection.
 *
 * The behaviour that matters most is the refusal: a token with thin history must
 * produce no anomaly rather than a default one. Getting that wrong would mean
 * every newly listed token screaming on its first reading, which is worse than
 * having no detector at all.
 */

const series = (values: number[], field: "p" | "l" | "v" | "h" = "v"): Series => ({
  address: "0xtest",
  symbol: "TEST",
  samples: values.map((value, i) => ({
    t: 1_000_000 + i * 600,
    p: field === "p" ? value : null,
    l: field === "l" ? value : null,
    v: field === "v" ? value : null,
    h: field === "h" ? value : null,
  })),
});

test("median handles both parities", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
});

test("MAD is not moved by the outlier it exists to measure", () => {
  const ordinary = [10, 10, 11, 9, 10, 10, 11, 9];
  const withSpike = [...ordinary, 5000];

  const stdev = (xs: number[]) => {
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    return Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length);
  };

  const madGrowth = (mad(withSpike) ?? 0) / (mad(ordinary) ?? 1);
  const stdevGrowth = stdev(withSpike) / stdev(ordinary);

  /*
   * This is the whole reason MAD is used instead of a standard deviation. One
   * freak reading inflates the standard deviation by three orders of magnitude,
   * so the spike ends up inside its own "normal" band and scores as ordinary.
   * MAD stays within a small factor, so the spike still registers as a spike.
   */
  assert.ok(stdevGrowth > 1000, `a standard deviation should blow up, grew ${stdevGrowth.toFixed(0)}x`);
  assert.ok(madGrowth <= 2, `MAD should stay stable, grew ${madGrowth.toFixed(2)}x`);
  assert.ok(
    stdevGrowth / madGrowth > 500,
    "MAD must be dramatically more resistant, which is the property being relied on"
  );
});

test("thin history reports insufficient rather than normal", () => {
  const d = deviation([1, 2, 3], 100);
  assert.equal(d.sufficient, false);
  assert.equal(d.sigma, null, "null, not 0 — 0 would read as perfectly ordinary");
  assert.equal(d.pct, null);
});

test("deviation needs MIN_SAMPLES before it will judge anything", () => {
  const justUnder = Array.from({ length: MIN_SAMPLES - 1 }, () => 10);
  const justEnough = Array.from({ length: MIN_SAMPLES }, () => 10);

  assert.equal(deviation(justUnder, 50).sufficient, false);
  assert.equal(deviation(justEnough, 50).sufficient, true);
});

test("a spike against a stable history is measured in sigmas", () => {
  const history = Array.from({ length: 30 }, (_, i) => 100 + (i % 3));
  const d = deviation(history, 400);

  assert.equal(d.sufficient, true);
  assert.ok(d.sigma !== null && d.sigma > 3, `expected a large positive sigma, got ${d.sigma}`);
  assert.ok(d.pct !== null && d.pct > 250);
});

test("a perfectly flat history yields no sigma rather than infinity", () => {
  const flat = Array.from({ length: 30 }, () => 100);
  const d = deviation(flat, 101);

  assert.equal(d.sufficient, true);
  assert.equal(d.sigma, null, "dividing by a zero spread would make any change the biggest anomaly possible");
  assert.ok(d.pct !== null && d.pct > 0, "the percentage move is still reported");
});

test("a current value of null cannot be judged", () => {
  const history = Array.from({ length: 30 }, () => 100);
  assert.equal(deviation(history, null).sufficient, false);
});

test("metric drops gaps rather than reading them as zero", () => {
  const s: Series = {
    address: "0x",
    symbol: null,
    samples: [
      { t: 1, p: 10, l: null, v: 5, h: null },
      { t: 2, p: null, l: null, v: 6, h: null },
      { t: 3, p: 12, l: null, v: null, h: null },
    ],
  };
  assert.deepEqual(metric(s, "p"), [10, 12]);
  assert.deepEqual(metric(s, "v"), [5, 6]);
  assert.deepEqual(metric(s, "l"), []);
});

test("changeOver measures against the oldest sample inside the window", () => {
  const now = 1_000_000 + 29 * 600;
  const c = changeOver(series([100, 110, 120]), "v", 3600, now);
  assert.equal(c.pct, null, "samples outside the window leave nothing to compare");

  const recent = changeOver(series([100, 110, 120]), "v", 86_400, 1_000_000 + 2 * 600);
  assert.ok(recent.pct !== null && Math.abs(recent.pct - 20) < 0.001);
});

/* ------------------------------------------------------------ Anomalies */

const baselineOf = (values: number[], field: "p" | "l" | "v" | "h" = "v") => ({
  "0xtest": series(values, field),
});

const input = (over: Partial<Parameters<typeof detectAnomalies>[0]> = {}) => ({
  address: "0xtest",
  symbol: "TEST",
  priceUsd: null,
  liquidityUsd: null,
  volume24hUsd: null,
  holders: null,
  buyPressurePct: null,
  largestTradeUsd: null,
  medianTradeUsd: null,
  ...over,
});

test("a token with no recorded history produces no anomalies", () => {
  const report = detectAnomalies(input({ volume24hUsd: 999_999 }), {});
  assert.equal(report.anomalies.length, 0);
  assert.equal(report.hasBaseline, false);
  assert.equal(report.topScore, 0);
});

test("a volume spike against a stable baseline is caught", () => {
  const history = Array.from({ length: 30 }, (_, i) => 10_000 + (i % 5) * 100);
  const report = detectAnomalies(
    input({ volume24hUsd: 500_000 }),
    baselineOf(history, "v")
  );

  const spike = report.anomalies.find((a) => a.kind === "volume_spike");
  assert.ok(spike, "expected a volume_spike");
  assert.ok(spike!.score >= DEFAULT_ANOMALY.minScore);
  assert.equal(report.hasBaseline, true);
});

test("ordinary volume produces nothing", () => {
  const history = Array.from({ length: 30 }, (_, i) => 10_000 + (i % 5) * 100);
  const report = detectAnomalies(input({ volume24hUsd: 10_200 }), baselineOf(history, "v"));
  assert.equal(report.anomalies.filter((a) => a.kind === "volume_spike").length, 0);
});

test("a liquidity drain is reported separately from a surge", () => {
  const history = Array.from({ length: 30 }, (_, i) => 1_000_000 + (i % 4) * 1000);
  const drained = detectAnomalies(input({ liquidityUsd: 100_000 }), baselineOf(history, "l"));
  const surged = detectAnomalies(input({ liquidityUsd: 9_000_000 }), baselineOf(history, "l"));

  assert.ok(drained.anomalies.some((a) => a.kind === "liquidity_drain"));
  assert.ok(!drained.anomalies.some((a) => a.kind === "liquidity_surge"));
  assert.ok(surged.anomalies.some((a) => a.kind === "liquidity_surge"));
});

test("flow imbalance needs no history, so it works on a brand new token", () => {
  const report = detectAnomalies(input({ buyPressurePct: 95 }), {});
  const pressure = report.anomalies.find((a) => a.kind === "buy_pressure");
  assert.ok(pressure, "buy pressure is a property of the window, not of history");
  assert.equal(report.hasBaseline, false, "and it does not pretend a baseline exists");
});

test("sell pressure is the mirror of buy pressure", () => {
  const report = detectAnomalies(input({ buyPressurePct: 5 }), {});
  assert.ok(report.anomalies.some((a) => a.kind === "sell_pressure"));
  assert.ok(!report.anomalies.some((a) => a.kind === "buy_pressure"));
});

test("a whale print is judged against this token's own typical trade", () => {
  const big = detectAnomalies(input({ largestTradeUsd: 50_000, medianTradeUsd: 100 }), {});
  const ordinary = detectAnomalies(input({ largestTradeUsd: 300, medianTradeUsd: 100 }), {});

  assert.ok(big.anomalies.some((a) => a.kind === "whale_trade"));
  assert.ok(
    !ordinary.anomalies.some((a) => a.kind === "whale_trade"),
    "3x the median is a normal trade, not a whale"
  );
});

test("sensitivity moves the bar in the direction asked for", () => {
  const history = Array.from({ length: 30 }, (_, i) => 10_000 + (i % 5) * 100);
  const borderline = input({ volume24hUsd: 11_500 });

  const strict = detectAnomalies(borderline, baselineOf(history, "v"), { ...DEFAULT_ANOMALY, sensitivity: 3 });
  const loose = detectAnomalies(borderline, baselineOf(history, "v"), { ...DEFAULT_ANOMALY, sensitivity: 0.3 });

  assert.ok(loose.anomalies.length >= strict.anomalies.length);
});

test("anomalies come back strongest first", () => {
  const report = detectAnomalies(
    input({ buyPressurePct: 99, largestTradeUsd: 100_000, medianTradeUsd: 100 }),
    {}
  );
  const scores = report.anomalies.map((a) => a.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  assert.equal(report.topScore, scores[0]);
});
