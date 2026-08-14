import test from "node:test";
import assert from "node:assert/strict";

import {
  formatPrice,
  formatMoney,
  formatPct,
  renderAlert,
  renderSettings,
  renderWatchConfirmation,
  renderWatchlist,
  TOKEN_NOT_FOUND,
} from "../lib/watch/format";
import { evaluateWatch } from "../lib/watch/alerts";
import { makeMarket, makeSettings, makeWatch } from "./helpers";

/** Message copy. Alerts are read on a lock screen, so their shape is part of the feature. */

test("prices keep their significant digits across nine orders of magnitude", () => {
  assert.equal(formatPrice(226.0649), "$226.06");
  assert.equal(formatPrice(1.2345678), "$1.2346");
  assert.equal(formatPrice(0.0117), "$0.011700");
  assert.equal(formatPrice(0.000000123), "$1.2300e-7", "a memecoin price must not render as $0.00");
  assert.equal(formatPrice(null), "—");
});

test("missing figures render as a dash, never as zero", () => {
  assert.equal(formatMoney(null), "—");
  assert.equal(formatPct(null), "—");
  assert.equal(formatMoney(0), "$0.00", "an actual zero is still shown as zero");
});

test("money is compacted the way a trader reads it", () => {
  assert.equal(formatMoney(492_000), "$492.0K");
  assert.equal(formatMoney(1_020_000), "$1.02M");
  assert.equal(formatMoney(4_033_915), "$4.03M");
  assert.equal(formatMoney(2_500_000_000), "$2.50B");
});

test("a price alert carries the move, the threshold and the context", () => {
  const settings = makeSettings({ priceUpPct: 10 });
  const market = makeMarket({
    priceUsd: 0.00142,
    marketCap: 142_000,
    liquidity: 51_000,
    volume24h: 318_000,
    url: "https://dexscreener.com/robinhood/0xcbdf",
    source: ["dexscreener", "geckoterminal"],
  });

  const { alerts } = evaluateWatch(
    makeWatch({ baselinePrice: 0.00128, lastPrice: 0.00128 }),
    market,
    settings,
    new Date("2026-08-14T01:00:00.000Z")
  );

  const text = renderAlert(alerts[0]);

  assert.ok(text.startsWith("🟢 PRICE ALERT $AI"));
  assert.ok(text.includes("Change: +10.94%"));
  assert.ok(text.includes("Threshold: +10%"));
  assert.ok(text.includes("MC: $142.0K"));
  assert.ok(text.includes("Liquidity: $51.0K"));
  assert.ok(text.includes("24h Volume: $318.0K"));
  assert.ok(text.includes("Source: DEX Screener + GeckoTerminal"));
  assert.ok(text.includes("View Chart ↗ https://dexscreener.com/robinhood/0xcbdf"));
  assert.ok(text.length < 500, "an alert must fit on a lock screen");
});

test("a price-down alert is visually distinct from a price-up alert", () => {
  const { alerts } = evaluateWatch(
    makeWatch({ baselinePrice: 0.001, lastPrice: 0.001 }),
    makeMarket({ priceUsd: 0.00089 }),
    makeSettings({ priceDownPct: 10 }),
    new Date("2026-08-14T01:00:00.000Z")
  );

  const text = renderAlert(alerts[0]);
  assert.ok(text.startsWith("🔴 PRICE ALERT"));
  assert.ok(text.includes("Change: −11.00%"));
  assert.ok(text.includes("Threshold: −10%"));
});

test("a market cap alert names the level it crossed", () => {
  const { alerts } = evaluateWatch(
    makeWatch({ lastMarketCap: 900_000 }),
    makeMarket({ marketCap: 1_020_000 }),
    makeSettings({ priceUpPct: null, priceDownPct: null, marketCapAbove: 1_000_000 }),
    new Date("2026-08-14T01:00:00.000Z")
  );

  const text = renderAlert(alerts[0]);
  assert.ok(text.startsWith("🚀 MC ALERT $AI"));
  assert.ok(text.includes("Market Cap:\n$1.02M"));
  assert.ok(text.includes("Threshold:\n$1.00M"));
});

test("an alert for a token with no symbol falls back to its address", () => {
  const { alerts } = evaluateWatch(
    makeWatch({ symbol: null, baselinePrice: 1, lastPrice: 1 }),
    makeMarket({ symbol: null, priceUsd: 2 }),
    makeSettings(),
    new Date("2026-08-14T01:00:00.000Z")
  );

  assert.ok(renderAlert(alerts[0]).startsWith("🟢 PRICE ALERT 0x2e8c3116…"));
});

test("the watch confirmation shows the figures and the active thresholds", () => {
  const text = renderWatchConfirmation(
    makeWatch(),
    makeMarket({ priceUsd: 0.000123, marketCap: 125_000, liquidity: 48_000, volume24h: 310_000 }),
    makeSettings(),
    false
  );

  assert.ok(text.startsWith("👁 Watching $AI"));
  assert.ok(text.includes("Price: $0.000123"));
  assert.ok(text.includes("MC: $125.0K"));
  assert.ok(text.includes("🟢 Up: +10%"));
  assert.ok(text.includes("🔴 Down: −10%"));
  assert.ok(text.includes("You'll be notified"));
});

test("a disabled price threshold is stated, not omitted", () => {
  const text = renderWatchConfirmation(
    makeWatch(),
    makeMarket(),
    makeSettings({ priceUpPct: null }),
    false
  );
  assert.ok(text.includes("🟢 Up: Disabled"));
});

test("an empty watchlist explains how to fill it", () => {
  const text = renderWatchlist([], makeSettings());
  assert.ok(text.includes("Nothing watched yet"));
  assert.ok(text.includes("/watch 0x"));
});

test("the watchlist shows each token's move since it was watched", () => {
  const text = renderWatchlist(
    [
      makeWatch({ id: "1", symbol: "AI", baselinePrice: 1, lastPrice: 1.2, lastMarketCap: 120_000 }),
      makeWatch({ id: "2", symbol: "ABC", baselinePrice: 0.05, lastPrice: 0.042, lastMarketCap: 2_100_000 }),
    ],
    makeSettings()
  );

  assert.ok(text.includes("1. $AI"));
  assert.ok(text.includes("(+20.00% since watch)"));
  assert.ok(text.includes("2. $ABC"));
  assert.ok(text.includes("(−16.00% since watch)"));
  assert.ok(text.includes("Alert: +10% / −10%"));
});

test("the settings panel lists every control and the current source state", () => {
  const text = renderSettings(makeSettings({ marketCapAbove: 1_000_000, useGeckoTerminal: false }), 3);

  for (const line of [
    "🟢 Price Up: +10%",
    "🔴 Price Down: −10%",
    "📈 MC Above: $1.00M",
    "📉 MC Below: Disabled",
    "💧 Liquidity Above: Disabled",
    "📊 24h Volume Above: Disabled",
    "⏱ Check Interval: 30s",
    "🔕 Alert Cooldown: 15m",
    "🟢 DEX Screener",
    "🔴 GeckoTerminal",
    "Watching 3 tokens",
  ]) {
    assert.ok(text.includes(line), `settings panel should contain: ${line}`);
  }
});

test("the not-found message says what to check", () => {
  assert.ok(TOKEN_NOT_FOUND.includes("Robinhood Chain"));
  assert.ok(TOKEN_NOT_FOUND.includes("indexed trading pair"));
});
