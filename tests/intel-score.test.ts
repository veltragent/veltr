import test from "node:test";
import assert from "node:assert/strict";

import {
  blend,
  buyPressure,
  concentration,
  confidencePct,
  holderScore,
  liquidityScore,
  momentumScore,
  ramp,
  riskScore,
  turnoverRatio,
  volatilityPct,
} from "../lib/intel/score";

/**
 * Scoring rules.
 *
 * The property under test throughout is that missing data stays missing. A
 * score assembled from half its inputs must say so rather than reading as a
 * weak-but-confident result, because a confident wrong number is the failure
 * mode that actually costs someone money.
 */

test("a missing input widens the error bar instead of dragging the score down", () => {
  const full = blend([
    { label: "a", score: 80, weight: 1 },
    { label: "b", score: 80, weight: 1 },
  ]);
  const partial = blend([
    { label: "a", score: 80, weight: 1 },
    { label: "b", score: null, weight: 1 },
  ]);

  assert.equal(full.value, 80);
  assert.equal(partial.value, 80, "the present input still says 80 — it is not averaged against zero");
  assert.equal(full.confidence, 1);
  assert.equal(partial.confidence, 0.5, "but only half the weight had data behind it");
  assert.deepEqual(partial.missing, ["b"]);
});

test("a blend with nothing in it is null, not zero", () => {
  const none = blend([{ label: "a", score: null, weight: 1 }]);
  assert.equal(none.value, null);
  assert.equal(none.confidence, 0);
});

test("weights are respected", () => {
  const weighted = blend([
    { label: "heavy", score: 100, weight: 3 },
    { label: "light", score: 0, weight: 1 },
  ]);
  assert.equal(weighted.value, 75);
});

test("ramp clamps rather than extrapolating past its anchors", () => {
  assert.equal(ramp(0, 0, 10), 0);
  assert.equal(ramp(10, 0, 10), 100);
  assert.equal(ramp(50, 0, 10), 100, "beyond the top anchor is still 100");
  assert.equal(ramp(-50, 0, 10), 0);
  assert.equal(ramp(null, 0, 10), null);
  assert.equal(ramp(5, 3, 3), null, "an anchor pair with no span cannot map anything");
});

test("buy pressure distinguishes an even split from no trades at all", () => {
  assert.equal(buyPressure(5, 5), 50);
  assert.equal(buyPressure(0, 0), null, "nothing traded is not a balanced market");
  assert.equal(buyPressure(null, 3), null);
  assert.equal(buyPressure(10, 0), 100);
});

test("turnover needs both sides and refuses to divide by nothing", () => {
  assert.equal(turnoverRatio(1000, 500), 2);
  assert.equal(turnoverRatio(1000, 0), null);
  assert.equal(turnoverRatio(null, 500), null);
});

test("volatility needs a real series", () => {
  assert.equal(volatilityPct([]), null);
  assert.equal(volatilityPct([10, 11]), null, "two points is not a range");
  const v = volatilityPct([90, 100, 110]);
  assert.ok(v !== null && v > 19 && v < 21, `expected ~20%, got ${v}`);
});

test("concentration excludes contracts, because the biggest holder is the pool", () => {
  const c = concentration(
    [
      { address: "0xpool", isContract: true, value: 1_000_000 },
      { address: "0xa", isContract: false, value: 60 },
      { address: "0xb", isContract: false, value: 30 },
      { address: "0xc", isContract: false, value: 10 },
    ],
    2
  );

  assert.equal(c.excludedContracts, 1);
  assert.equal(c.topN, 2);
  assert.equal(c.topSharePct, 90, "60+30 of the 100 held by actual wallets");
  assert.equal(c.complete, false, "the full holder set is never obtainable on this chain");
});

test("concentration with no wallets reports nothing rather than zero", () => {
  const c = concentration([{ address: "0xpool", isContract: true, value: 5 }]);
  assert.equal(c.topSharePct, null);
});

test("holder score rewards breadth and punishes capture", () => {
  const broad = holderScore(40_000, 25);
  const captured = holderScore(40_000, 90);
  assert.ok(
    (broad.value ?? 0) > (captured.value ?? 0),
    "the same holder count concentrated in ten wallets must score lower"
  );
});

test("risk is inverted relative to every other score", () => {
  const safe = riskScore({
    liquidityUsd: 5_000_000,
    topSharePct: 20,
    holders: 40_000,
    turnover: 0.4,
    volatilityPct: 2,
    multiplierDrifted: false,
  });
  const dangerous = riskScore({
    liquidityUsd: 4_000,
    topSharePct: 95,
    holders: 12,
    turnover: 12,
    volatilityPct: 60,
    multiplierDrifted: false,
  });

  assert.ok((safe.value ?? 100) < 30, `deep and distributed should be low risk, got ${safe.value}`);
  assert.ok((dangerous.value ?? 0) > 70, `thin and captured should be high risk, got ${dangerous.value}`);
});

test("a drifted multiplier raises the risk floor and cannot be averaged away", () => {
  const base = {
    liquidityUsd: 5_000_000,
    topSharePct: 20,
    holders: 40_000,
    turnover: 0.4,
    volatilityPct: 2,
  };
  const clean = riskScore({ ...base, multiplierDrifted: false });
  const drifted = riskScore({ ...base, multiplierDrifted: true });

  assert.ok((clean.value ?? 0) < 55);
  assert.ok(
    (drifted.value ?? 0) >= 55,
    "every wallet reading balanceOf is wrong for this token — that is categorical"
  );
});

test("risk with no inputs is null rather than a safe-looking zero", () => {
  const r = riskScore({
    liquidityUsd: null,
    topSharePct: null,
    holders: null,
    turnover: null,
    volatilityPct: null,
    multiplierDrifted: false,
  });
  assert.equal(r.value, null, "unknown must never render as safe");
});

test("liquidity scoring is logarithmic, so small pools separate and large ones saturate", () => {
  const tiny = liquidityScore(10_000, 1);
  const small = liquidityScore(100_000, 1);
  const large = liquidityScore(4_000_000, 1);
  const huge = liquidityScore(5_000_000, 1);

  const gapLow = (small.value ?? 0) - (tiny.value ?? 0);
  const gapHigh = (huge.value ?? 0) - (large.value ?? 0);
  assert.ok(gapLow > gapHigh, "a 10x at the bottom must matter more than 25% at the top");
});

test("momentum weights the near term above the far term", () => {
  const nearUp = momentumScore({ change5m: 0, change1h: 8, change6h: 0, change24h: 0 });
  const farUp = momentumScore({ change5m: 0, change1h: 0, change6h: 0, change24h: 25 });
  assert.ok((nearUp.value ?? 0) > (farUp.value ?? 0), "'is this happening now' is the question");
});

test("confidence never claims certainty", () => {
  assert.equal(confidencePct(1), 95);
  assert.equal(confidencePct(0), 0);
  assert.equal(confidencePct(2), 95, "clamped — no pipeline earns 100%");
});
