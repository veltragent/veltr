import test from "node:test";
import assert from "node:assert/strict";

import { evaluateWatch, percentChange, resyncArmState, PRICE_REARM_FRACTION } from "../lib/watch/alerts";
import { makeMarket, makeSettings, makeWatch } from "./helpers";
import type { TokenWatch } from "../lib/watch/types";

const AT = (iso: string) => new Date(iso);

/** Runs a price series through the engine, carrying state forward as production does. */
function replay(
  prices: (number | null)[],
  options: { watch?: Partial<TokenWatch>; settings?: Parameters<typeof makeSettings>[0]; stepMs?: number } = {}
) {
  const settings = makeSettings(options.settings);
  let watch = makeWatch(options.watch);
  const fired: string[] = [];
  let clock = Date.parse("2026-08-14T00:00:00.000Z");

  for (const price of prices) {
    clock += options.stepMs ?? 60_000;
    const result = evaluateWatch(watch, makeMarket({ priceUsd: price }), settings, new Date(clock));
    watch = result.watch;
    for (const alert of result.alerts) fired.push(`${alert.kind}@${price}`);
  }

  return { fired, watch };
}

test("percentChange keeps missing data distinct from no movement", () => {
  assert.equal(percentChange(1, 1.1), 10.000000000000009);
  assert.equal(percentChange(null, 1.1), null);
  assert.equal(percentChange(1, null), null);
  assert.equal(percentChange(0, 1), null, "a zero baseline cannot produce a percentage");
});

test("price rising through the threshold fires exactly once", () => {
  const { fired } = replay([1.0, 1.05, 1.101, 1.105, 1.11, 1.15]);
  assert.deepEqual(fired, ["priceUp@1.101"], "a sustained move must not alert on every poll");
});

test("price falling through the threshold fires exactly once", () => {
  const { fired } = replay([1.0, 0.95, 0.899, 0.89, 0.85, 0.8]);
  assert.deepEqual(fired, ["priceDown@0.899"]);
});

test("an alert re-arms only after the move decays through the re-arm band", () => {
  // Cooldown off so this exercises re-arm alone; the two mechanisms are
  // independent and the cooldown has its own test.
  // Up 10%: fires at 1.10, re-arms at or below +5% (1.05), fires again on the next break.
  const { fired } = replay([1.0, 1.12, 1.2, 1.06, 1.04, 1.09, 1.13], {
    settings: { alertCooldownSec: 0 },
  });
  assert.deepEqual(fired, ["priceUp@1.12", "priceUp@1.13"]);
  assert.equal(PRICE_REARM_FRACTION, 0.5);
});

test("retreating part-way is not enough to re-arm", () => {
  const { fired } = replay([1.0, 1.12, 1.07, 1.15], { settings: { alertCooldownSec: 0 } });
  assert.deepEqual(fired, ["priceUp@1.12"], "1.07 is still above the +5% re-arm level");
});

test("cooldown alone throttles a token that keeps re-crossing", () => {
  // Re-arm is satisfied on every dip, so only the cooldown limits the rate.
  const { fired } = replay([1.0, 1.12, 1.0, 1.12, 1.0, 1.12], {
    settings: { alertCooldownSec: 900 },
    stepMs: 60_000,
  });
  assert.deepEqual(fired, ["priceUp@1.12"], "one alert per cooldown window");
});

test("cooldown suppresses a second condition but does not lose it", () => {
  const settings = makeSettings({ priceUpPct: 10, marketCapAbove: 2_000_000, alertCooldownSec: 900 });
  let watch = makeWatch();

  const first = evaluateWatch(
    watch,
    makeMarket({ priceUsd: 1.2, marketCap: 1_000_000 }),
    settings,
    AT("2026-08-14T00:01:00.000Z")
  );
  watch = first.watch;
  assert.deepEqual(first.alerts.map((a) => a.kind), ["priceUp"]);

  // Inside the cooldown window the market cap crosses too.
  const second = evaluateWatch(
    watch,
    makeMarket({ priceUsd: 1.2, marketCap: 2_500_000 }),
    settings,
    AT("2026-08-14T00:02:00.000Z")
  );
  watch = second.watch;
  assert.deepEqual(second.alerts, [], "cooldown holds the second alert");
  assert.deepEqual(second.suppressedByCooldown, ["marketCapAbove"]);
  assert.equal(watch.armed.marketCapAbove, true, "a suppressed alert stays armed, so it is not lost");

  // Once the window closes it is delivered.
  const third = evaluateWatch(
    watch,
    makeMarket({ priceUsd: 1.2, marketCap: 2_500_000 }),
    settings,
    AT("2026-08-14T00:20:00.000Z")
  );
  assert.deepEqual(third.alerts.map((a) => a.kind), ["marketCapAbove"]);
});

test("market cap alerts fire on the crossing and re-arm through the dead band", () => {
  const settings = makeSettings({ priceUpPct: null, priceDownPct: null, marketCapAbove: 1_000_000, alertCooldownSec: 0 });
  let watch = makeWatch({ lastMarketCap: 900_000 });
  const fired: string[] = [];

  for (const [i, mc] of [900_000, 1_020_000, 1_100_000, 980_000, 940_000, 1_010_000].entries()) {
    const result = evaluateWatch(
      watch,
      makeMarket({ marketCap: mc }),
      settings,
      new Date(Date.parse("2026-08-14T00:00:00.000Z") + i * 60_000)
    );
    watch = result.watch;
    for (const alert of result.alerts) fired.push(`${alert.kind}@${mc}`);
  }

  assert.deepEqual(fired, ["marketCapAbove@1020000", "marketCapAbove@1010000"]);
  // 980_000 sits inside the 5% band (950_000–1_000_000) and must not re-arm.
});

test("liquidity and volume alerts carry the value and the threshold that fired", () => {
  const settings = makeSettings({
    priceUpPct: null,
    priceDownPct: null,
    liquidityBelow: 10_000,
    volumeAbove: 500_000,
  });
  const watch = makeWatch({ lastLiquidity: 50_000, lastVolume: 100_000 });

  const result = evaluateWatch(
    watch,
    makeMarket({ liquidity: 8_700, volume24h: 512_000 }),
    settings,
    AT("2026-08-14T00:05:00.000Z")
  );

  const kinds = result.alerts.map((a) => a.kind).sort();
  assert.deepEqual(kinds, ["liquidityBelow", "volumeAbove"]);

  const liquidity = result.alerts.find((a) => a.kind === "liquidityBelow")!;
  assert.equal(liquidity.value, 8_700);
  assert.equal(liquidity.threshold, 10_000);
});

test("a null metric never fires and never disarms", () => {
  const settings = makeSettings({ marketCapBelow: 500_000 });
  const watch = makeWatch({ lastMarketCap: 900_000 });

  const result = evaluateWatch(
    watch,
    makeMarket({ marketCap: null, liquidity: null, volume24h: null }),
    settings,
    AT("2026-08-14T00:05:00.000Z")
  );

  assert.deepEqual(result.alerts, [], "absent data must not read as a market cap of zero");
  assert.equal(result.watch.armed.marketCapBelow, true);
  assert.equal(result.watch.lastMarketCap, 900_000, "the last real reading is retained");
});

test("a null price leaves the baseline and the stored price intact", () => {
  const { watch, fired } = replay([null, null]);
  assert.deepEqual(fired, []);
  assert.equal(watch.lastPrice, 1);
  assert.equal(watch.baselinePrice, 1);
});

test("the establishing pass sets a baseline and never alerts", () => {
  const settings = makeSettings({ marketCapAbove: 1_000_000 });
  const watch = makeWatch({ baselinePrice: null, lastPrice: null, lastMarketCap: null });

  const result = evaluateWatch(
    watch,
    makeMarket({ priceUsd: 2, marketCap: 5_000_000 }),
    settings,
    AT("2026-08-14T00:00:30.000Z")
  );

  assert.deepEqual(result.alerts, [], "a token already past a threshold has not crossed it");
  assert.equal(result.watch.baselinePrice, 2);
  assert.equal(result.watch.armed.marketCapAbove, false, "disarmed until it comes back down");
});

test("changing a threshold re-points the arm state instead of firing", () => {
  const watch = makeWatch({ lastMarketCap: 1_020_000 });
  const settings = makeSettings({ marketCapAbove: 1_000_000 });

  const synced = resyncArmState(watch, settings);
  assert.equal(synced.armed.marketCapAbove, false);

  const result = evaluateWatch(
    synced,
    makeMarket({ marketCap: 1_020_000 }),
    settings,
    AT("2026-08-14T00:10:00.000Z")
  );
  assert.deepEqual(result.alerts, [], "setting a threshold below where the token already sits is not a crossing");
});

test("disabled thresholds produce no alerts at any price", () => {
  const { fired } = replay([1, 3, 0.1, 10], {
    settings: { priceUpPct: null, priceDownPct: null },
  });
  assert.deepEqual(fired, []);
});
