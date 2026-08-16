import test from "node:test";
import assert from "node:assert/strict";

import { evaluateWatch, PREMIUM_REARM_POINTS } from "../lib/watch/alerts";
import { fetchPremiums } from "../lib/watch/premium";
import { validateField, parseNumericInput, MAX_PREMIUM_PCT } from "../lib/watch/settings";
import { makeMarket, makeSettings, makeWatch } from "./helpers";

/**
 * Premium and discount alerts.
 *
 * The one signal here that no other chain has: what a tokenised share costs
 * against the actual share. Everything below defends two things — that the sign
 * survives, because a discount is the direction the arbitrage runs, and that
 * nothing fires against a stale reference price.
 */

const NOW = new Date("2026-08-17T15:00:00.000Z");

function evaluate(premiumPct: number | null, settings: Parameters<typeof makeSettings>[0], stale = false) {
  return evaluateWatch(
    makeWatch(),
    makeMarket({ premiumPct, premiumIsStale: stale }),
    makeSettings(settings),
    NOW
  );
}

/* --------------------------------------------------------------- Firing */

test("a token trading above its share fires the premium alert", () => {
  const result = evaluate(2.4, { premiumAbove: 2 });
  assert.equal(result.alerts.length, 1);
  assert.equal(result.alerts[0].kind, "premiumAbove");
  assert.equal(result.alerts[0].value, 2.4);
});

test("a token trading below its share fires the discount alert", () => {
  // The case people actually want: the token is cheaper than the stock.
  const result = evaluate(-3.6, { premiumBelow: -3 });
  assert.equal(result.alerts.length, 1);
  assert.equal(result.alerts[0].kind, "premiumBelow");
});

test("a spread short of the threshold is silent", () => {
  assert.deepEqual(evaluate(1.4, { premiumAbove: 2 }).alerts, []);
  assert.deepEqual(evaluate(-2.4, { premiumBelow: -3 }).alerts, []);
});

test("no threshold means no premium alert, whatever the spread", () => {
  assert.deepEqual(evaluate(12, {}).alerts, []);
});

/* ---------------------------------------------------------- Stale price */

test("nothing fires while the equity market is shut", () => {
  // The reference is the last close, so the "premium" is drift against a stale
  // number rather than a spread anyone could trade.
  assert.deepEqual(evaluate(9.5, { premiumAbove: 2 }, true).alerts, []);
});

test("a shut market leaves the arm state exactly as it was", () => {
  // Otherwise a spread held over the close either re-fires at the open or is
  // silently disarmed overnight.
  const armed = evaluate(9.5, { premiumAbove: 2 }, true);
  assert.equal(armed.watch.armed.premiumAbove, true);

  const fired = evaluate(9.5, { premiumAbove: 2 });
  assert.equal(fired.watch.armed.premiumAbove, false, "and a live reading does disarm it");
});

test("an unreadable premium is not a premium of zero", () => {
  assert.deepEqual(evaluate(null, { premiumBelow: -1 }).alerts, []);
});

/* -------------------------------------------------------------- Re-arm */

test("a sustained spread fires once, not every cycle", () => {
  const first = evaluate(2.4, { premiumAbove: 2 });
  assert.equal(first.alerts.length, 1);

  const second = evaluateWatch(
    first.watch,
    makeMarket({ premiumPct: 2.5, premiumIsStale: false }),
    makeSettings({ premiumAbove: 2, alertCooldownSec: 0 }),
    new Date(NOW.getTime() + 3600_000)
  );
  assert.deepEqual(second.alerts, [], "still wide, still the same event");
});

test("the spread must genuinely close before it can fire again", () => {
  const fired = evaluate(2.4, { premiumAbove: 2 });

  // Just inside the band: not enough.
  const nearly = evaluateWatch(
    fired.watch,
    makeMarket({ premiumPct: 2 - PREMIUM_REARM_POINTS / 2, premiumIsStale: false }),
    makeSettings({ premiumAbove: 2, alertCooldownSec: 0 }),
    new Date(NOW.getTime() + 3600_000)
  );
  assert.equal(nearly.watch.armed.premiumAbove, false);

  const closed = evaluateWatch(
    fired.watch,
    makeMarket({ premiumPct: 2 - PREMIUM_REARM_POINTS * 2, premiumIsStale: false }),
    makeSettings({ premiumAbove: 2, alertCooldownSec: 0 }),
    new Date(NOW.getTime() + 3600_000)
  );
  assert.equal(closed.watch.armed.premiumAbove, true);
});

test("a discount re-arms upwards, not downwards", () => {
  // The bug this guards: a re-arm band computed as a fraction of a negative
  // threshold points the wrong way and re-arms the instant the alert fires.
  const fired = evaluate(-3.6, { premiumBelow: -3 });
  assert.equal(fired.watch.armed.premiumBelow, false);

  const deeper = evaluateWatch(
    fired.watch,
    makeMarket({ premiumPct: -5, premiumIsStale: false }),
    makeSettings({ premiumBelow: -3, alertCooldownSec: 0 }),
    new Date(NOW.getTime() + 3600_000)
  );
  assert.equal(deeper.watch.armed.premiumBelow, false, "a wider discount is not a recovery");

  const recovered = evaluateWatch(
    fired.watch,
    makeMarket({ premiumPct: -3 + PREMIUM_REARM_POINTS * 2, premiumIsStale: false }),
    makeSettings({ premiumBelow: -3, alertCooldownSec: 0 }),
    new Date(NOW.getTime() + 3600_000)
  );
  assert.equal(recovered.watch.armed.premiumBelow, true);
});

test("the band is percentage points, not a fraction of the threshold", () => {
  // At a 0.5% threshold a proportional band would be 0.025 points, which noise
  // crosses back and forth, firing again every cycle.
  const fired = evaluate(0.6, { premiumAbove: 0.5 });
  assert.equal(fired.alerts.length, 1);

  const jitter = evaluateWatch(
    fired.watch,
    makeMarket({ premiumPct: 0.47, premiumIsStale: false }),
    makeSettings({ premiumAbove: 0.5, alertCooldownSec: 0 }),
    new Date(NOW.getTime() + 3600_000)
  );
  assert.equal(jitter.watch.armed.premiumAbove, false, "0.03 points of noise is not a recovery");
});

/* ---------------------------------------------------------- Settings */

test("a negative premium threshold keeps its sign", () => {
  // Every other percentage stores direction in the field name and magnitude in
  // the value. Stripping the sign here would turn "tell me when it goes cheap"
  // into a threshold that is true almost all of the time.
  assert.deepEqual(validateField("premiumBelow", -3), { ok: true, value: -3 });
  assert.deepEqual(validateField("premiumAbove", 2), { ok: true, value: 2 });
  assert.equal(parseNumericInput("-3"), -3);
  assert.equal(parseNumericInput("-2.5%"), -2.5);
});

test("a price threshold still drops its sign, as it always did", () => {
  assert.deepEqual(validateField("priceDownPct", -10), { ok: true, value: 10 });
});

test("an implausible premium is refused rather than stored", () => {
  for (const bad of [0, MAX_PREMIUM_PCT + 1, -(MAX_PREMIUM_PCT + 1)]) {
    assert.equal(validateField("premiumAbove", bad).ok, false, String(bad));
  }
});

/* ------------------------------------------------------------ Fetching */

test("no equity quote is read while the market is shut", () => {
  // The largest saving available: the alert cannot fire anyway, so the cost
  // disappears overnight, at weekends and on holidays.
  let quotes = 0;
  return fetchPremiums(["0xabc"], {
    marketOpen: async () => false,
    resolveSymbol: async () => "NVDA",
    read: async () => {
      quotes++;
      return { premiumPct: 5, equityPriceUsd: 100 };
    },
  }).then((out) => {
    assert.equal(quotes, 0);
    assert.deepEqual(out.get("0xabc"), { premiumPct: null, equityPriceUsd: null, isStale: true });
  });
});

test("a token with no listed underlying is absent, not null", () => {
  // A quote provider returns a price for SPCX, but SpaceX is private: that
  // price is a different instrument, and a premium against it is fiction.
  return fetchPremiums(["0xspcx"], {
    marketOpen: async () => true,
    resolveSymbol: async () => null,
    read: async () => ({ premiumPct: 5, equityPriceUsd: 100 }),
  }).then((out) => {
    assert.equal(out.has("0xspcx"), false);
  });
});

test("one unreadable quote does not cost the others their alerts", () => {
  return fetchPremiums(["0xa", "0xb"], {
    marketOpen: async () => true,
    resolveSymbol: async (a) => (a === "0xa" ? "BAD" : "NVDA"),
    read: async (symbol) => {
      if (symbol === "BAD") throw new Error("provider down");
      return { premiumPct: -2, equityPriceUsd: 225.16 };
    },
  }).then((out) => {
    assert.equal(out.has("0xa"), false);
    assert.deepEqual(out.get("0xb"), { premiumPct: -2, equityPriceUsd: 225.16, isStale: false });
  });
});
