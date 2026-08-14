import test from "node:test";
import assert from "node:assert/strict";

import { mergeMarketData, fetchTokenMarketData, fetchSourceReadings, readingFor } from "../lib/watch/aggregate";
import { resetBudgets } from "../lib/watch/http";
import { emptyMarketData } from "../lib/watch/types";
import { makeSettings, stubFetch, TOKEN_A } from "./helpers";

/** Multi-source merge and the fallback path between providers. */

function dsReading(overrides: Record<string, unknown> = {}) {
  return { ...emptyMarketData(TOKEN_A, "dexscreener"), priceUsd: 1, liquidity: 50_000, ...overrides };
}

function gtReading(overrides: Record<string, unknown> = {}) {
  return { ...emptyMarketData(TOKEN_A, "geckoterminal"), priceUsd: 1.02, liquidity: 90_000, ...overrides };
}

test("DexScreener wins the fields it is authoritative for", () => {
  const merged = mergeMarketData([dsReading(), gtReading()])!;

  assert.equal(merged.priceUsd, 1, "the single-pool price is the one the pair link shows");
  assert.equal(merged.liquidity, 50_000);
  assert.deepEqual(merged.source, ["dexscreener"], "GeckoTerminal contributed nothing here");
});

test("a field absent from the preferred source falls through to the other", () => {
  const merged = mergeMarketData([
    dsReading({ marketCap: null, volume24h: null }),
    gtReading({ marketCap: 4_033_915, volume24h: 8_641_810 }),
  ])!;

  assert.equal(merged.priceUsd, 1, "still DexScreener's price");
  assert.equal(merged.marketCap, 4_033_915, "filled from GeckoTerminal");
  assert.equal(merged.volume24h, 8_641_810);
  assert.deepEqual(merged.source.sort(), ["dexscreener", "geckoterminal"]);
});

test("two readings from the same provider both contribute", () => {
  // GeckoTerminal answers with identity and capitalisation on one endpoint and
  // the price windows and chart link on another. Keeping only the first reading
  // would make the second call pure cost.
  const identity = gtReading({ symbol: "AI", marketCap: 11_670_071, priceChange24h: null, url: null });
  const pool = gtReading({
    symbol: null,
    marketCap: null,
    priceChange24h: 30.57,
    priceChange1h: 0.8,
    pairAddress: "0xcbdf",
    url: "https://www.geckoterminal.com/robinhood/pools/0xcbdf",
  });

  const merged = mergeMarketData([null, identity, pool])!;

  assert.equal(merged.symbol, "AI");
  assert.equal(merged.marketCap, 11_670_071);
  assert.equal(merged.priceChange24h, 30.57, "the pool reading must not be discarded");
  assert.equal(merged.url, "https://www.geckoterminal.com/robinhood/pools/0xcbdf");
});

test("a later source never downgrades a present value to null", () => {
  const merged = mergeMarketData([dsReading({ marketCap: 500 }), gtReading({ marketCap: null })])!;
  assert.equal(merged.marketCap, 500);
});

test("one provider failing leaves the other's reading intact", () => {
  const fromGeckoOnly = mergeMarketData([null, gtReading({ marketCap: 12_345 })])!;
  assert.equal(fromGeckoOnly.priceUsd, 1.02);
  assert.equal(fromGeckoOnly.marketCap, 12_345);
  assert.deepEqual(fromGeckoOnly.source, ["geckoterminal"]);

  const fromDexOnly = mergeMarketData([dsReading(), null])!;
  assert.equal(fromDexOnly.priceUsd, 1);
});

test("every provider failing yields nothing rather than an empty reading", () => {
  assert.equal(mergeMarketData([null, null]), null);
  assert.equal(mergeMarketData([]), null);
});

test("a token with no market on either provider resolves to null", async () => {
  resetBudgets();
  const { impl } = stubFetch((url) =>
    url.includes("dexscreener") ? { body: [] } : { body: { data: null } }
  );

  const result = await fetchTokenMarketData(TOKEN_A, { fetchImpl: impl });
  assert.equal(result, null, "the /watch path must be able to say 'not found'");
  resetBudgets();
});

test("DexScreener down: the reading is still built from GeckoTerminal", async () => {
  resetBudgets();
  const { impl } = stubFetch((url) => {
    if (url.includes("dexscreener")) return { status: 503 };
    return {
      body: {
        data: {
          attributes: {
            address: TOKEN_A,
            symbol: "AI",
            name: "Artificial Inu",
            price_usd: "0.0117",
            market_cap_usd: "11670071",
            volume_usd: { h24: "2510865" },
            total_reserve_in_usd: "1013544",
          },
        },
      },
    };
  });

  const result = await fetchTokenMarketData(TOKEN_A, { fetchImpl: impl })!;
  assert.equal(result!.priceUsd, 0.0117);
  assert.equal(result!.symbol, "AI");
  assert.deepEqual(result!.source, ["geckoterminal"]);
  resetBudgets();
});

test("GeckoTerminal down: the reading is still built from DexScreener", async () => {
  resetBudgets();
  const { impl } = stubFetch((url) => {
    if (url.includes("geckoterminal")) return { status: 429 };
    return {
      body: [
        {
          chainId: "robinhood",
          dexId: "uniswap",
          pairAddress: "0xdeep",
          baseToken: { address: TOKEN_A, symbol: "AI", name: "Artificial Inu" },
          priceUsd: "0.0117",
          liquidity: { usd: 1_013_544 },
          marketCap: 11_670_071,
          volume: { h24: 2_510_865 },
        },
      ],
    };
  });

  const result = await fetchTokenMarketData(TOKEN_A, { fetchImpl: impl });
  assert.equal(result!.priceUsd, 0.0117);
  assert.deepEqual(result!.source, ["dexscreener"]);
  resetBudgets();
});

test("a disabled source is never called and never contributes", async () => {
  resetBudgets();
  const { impl, calls } = stubFetch(() => ({
    body: [
      {
        chainId: "robinhood",
        baseToken: { address: TOKEN_A, symbol: "AI" },
        priceUsd: "1",
        liquidity: { usd: 1 },
      },
    ],
  }));

  await fetchTokenMarketData(TOKEN_A, {
    fetchImpl: impl,
    settings: makeSettings({ useGeckoTerminal: false }),
  });

  assert.ok(calls.every((url) => !url.includes("geckoterminal")));
  resetBudgets();
});

test("readingFor applies each user's source preference to one shared batch", async () => {
  resetBudgets();
  const { impl, calls } = stubFetch((url) => {
    if (url.includes("dexscreener")) {
      return {
        body: [
          {
            chainId: "robinhood",
            baseToken: { address: TOKEN_A, symbol: "AI" },
            priceUsd: "1.00",
            liquidity: { usd: 10 },
          },
        ],
      };
    }
    return { body: { data: { attributes: { token_prices: { [TOKEN_A]: "2.00" } } } } };
  });

  const readings = await fetchSourceReadings([TOKEN_A], { fetchImpl: impl });
  assert.equal(calls.length, 2, "one call per provider, not per user");

  const bothUsers = readingFor(readings, TOKEN_A, { useDexScreener: true, useGeckoTerminal: true });
  const geckoOnly = readingFor(readings, TOKEN_A, { useDexScreener: false, useGeckoTerminal: true });

  assert.equal(bothUsers!.priceUsd, 1, "DexScreener leads when both are enabled");
  assert.equal(geckoOnly!.priceUsd, 2, "a user who disabled DexScreener gets GeckoTerminal's price");
  resetBudgets();
});
