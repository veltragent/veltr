import test from "node:test";
import assert from "node:assert/strict";

import * as ds from "../lib/watch/providers/dexscreener";
import * as gt from "../lib/watch/providers/geckoterminal";
import { resetBudgets } from "../lib/watch/http";
import { stubFetch, TOKEN_A, TOKEN_B } from "./helpers";

/**
 * Provider adapters.
 *
 * The fixtures below are trimmed copies of real responses captured from the live
 * APIs for this chain, so a schema change on either provider surfaces here rather
 * than as a silent null in an alert.
 */

const dsPair = (overrides: Partial<ds.DsPair> = {}): ds.DsPair => ({
  chainId: "robinhood",
  dexId: "uniswap",
  url: "https://dexscreener.com/robinhood/0xcbdf",
  pairAddress: "0xcbdf",
  baseToken: { address: TOKEN_A, name: "Artificial Inu", symbol: "AI" },
  quoteToken: { address: TOKEN_B, symbol: "USDG" },
  priceNative: "0.0000063",
  priceUsd: "0.01167",
  txns: { h24: { buys: 4570, sells: 2735 } },
  volume: { h24: 2_510_865.28 },
  priceChange: { m5: -0.56, h1: 0.8, h6: 15.83, h24: 30.57 },
  liquidity: { usd: 1_013_544.13 },
  fdv: 11_569_595,
  marketCap: 11_670_071,
  ...overrides,
});

test("DexScreener: a live pair maps onto every field of the internal model", () => {
  const data = ds.parsePairs([dsPair()], TOKEN_A)!;

  assert.equal(data.symbol, "AI");
  assert.equal(data.name, "Artificial Inu");
  assert.equal(data.priceUsd, 0.01167);
  assert.equal(data.price, 0.0000063);
  assert.equal(data.marketCap, 11_670_071);
  assert.equal(data.fdv, 11_569_595, "market cap and FDV are distinct figures, not aliases");
  assert.equal(data.liquidity, 1_013_544.13);
  assert.equal(data.volume24h, 2_510_865.28);
  assert.equal(data.priceChange5m, -0.56);
  assert.equal(data.priceChange24h, 30.57);
  assert.equal(data.buys, 4570);
  assert.equal(data.sells, 2735);
  assert.equal(data.dex, "uniswap");
  assert.deepEqual(data.source, ["dexscreener"]);
});

test("DexScreener: pairs on other chains are discarded", () => {
  const foreign = dsPair({ chainId: "base", liquidity: { usd: 99_000_000 } });
  const local = dsPair({ liquidity: { usd: 5_000 } });

  const data = ds.parsePairs([foreign, local], TOKEN_A)!;
  assert.equal(data.liquidity, 5_000, "the deeper pool on the wrong chain must not win");

  assert.equal(
    ds.parsePairs([foreign], TOKEN_A),
    null,
    "an identical contract address on another chain is not this token"
  );
});

test("DexScreener: pairs where the token is the quote side are discarded", () => {
  // "AI / NVDA" quotes NVDA's price against AI. Reading it as NVDA's own pair
  // reports the wrong asset's price and 24h change under NVDA's name.
  const inverted = dsPair({
    baseToken: { address: TOKEN_A, symbol: "AI" },
    quoteToken: { address: TOKEN_B, symbol: "NVDA" },
    liquidity: { usd: 9_000_000 },
  });

  assert.equal(ds.parsePairs([inverted], TOKEN_B), null);
});

test("DexScreener: the deepest eligible pool wins", () => {
  const thin = dsPair({ pairAddress: "0xthin", liquidity: { usd: 1_000 }, priceUsd: "9.99" });
  const deep = dsPair({ pairAddress: "0xdeep", liquidity: { usd: 800_000 }, priceUsd: "0.01" });

  const data = ds.parsePairs([thin, deep], TOKEN_A)!;
  assert.equal(data.pairAddress, "0xdeep");
  assert.equal(data.priceUsd, 0.01, "a thin pool's last trade must not set the alerting price");
});

test("DexScreener: absent fields stay null rather than becoming zero", () => {
  const sparse: ds.DsPair = {
    chainId: "robinhood",
    baseToken: { address: TOKEN_A, symbol: "AI" },
    priceUsd: "0.5",
  };

  const data = ds.parsePairs([sparse], TOKEN_A)!;
  assert.equal(data.priceUsd, 0.5);
  assert.equal(data.marketCap, null);
  assert.equal(data.liquidity, null);
  assert.equal(data.volume24h, null);
  assert.equal(data.buys, null);
});

test("DexScreener: an unparseable number is null, not NaN", () => {
  const data = ds.parsePairs([dsPair({ priceUsd: "not-a-price", marketCap: undefined })], TOKEN_A)!;
  assert.equal(data.priceUsd, null);
  assert.equal(data.marketCap, null);
});

test("DexScreener: batching splits at the provider's cap of 30", async () => {
  resetBudgets();
  const addresses = Array.from({ length: 31 }, (_, i) => `0x${String(i).padStart(40, "0")}`);
  const { impl, calls } = stubFetch(() => ({ body: [] }));

  await ds.fetchBatch(addresses, { fetchImpl: impl });

  assert.equal(calls.length, 2, "31 addresses cannot go in one request — the endpoint truncates");
  assert.equal(calls[0].split("/").pop()!.split(",").length, 30);
  assert.equal(calls[1].split("/").pop()!.split(",").length, 1);
  assert.ok(calls[0].includes("/tokens/v1/robinhood/"));
});

test("GeckoTerminal: the token endpoint maps onto the internal model", () => {
  const data = gt.parseToken(
    {
      data: {
        attributes: {
          address: TOKEN_B,
          name: "NVIDIA • Robinhood Token",
          symbol: "NVDA",
          price_usd: "226.0649550344",
          fdv_usd: "4033915.58369291",
          market_cap_usd: "4033915.94333627",
          total_reserve_in_usd: "1885089.596091650",
          volume_usd: { h24: "8641810.79354754" },
        },
      },
    },
    TOKEN_B
  )!;

  assert.equal(data.symbol, "NVDA");
  assert.equal(data.priceUsd, 226.0649550344);
  assert.equal(data.marketCap, 4033915.94333627);
  assert.equal(data.liquidity, 1885089.59609165);
  assert.equal(data.volume24h, 8641810.79354754);
  assert.deepEqual(data.source, ["geckoterminal"]);
});

test("GeckoTerminal: an indexed token with no price is not a reading", () => {
  const data = gt.parseToken(
    { data: { attributes: { address: TOKEN_A, symbol: "AI", price_usd: undefined } } },
    TOKEN_A
  );
  assert.equal(data, null);
});

test("GeckoTerminal: only pools where the token is the base side are read", () => {
  const inverted = {
    attributes: {
      address: "0xcbdf",
      base_token_price_usd: "0.01214801156",
      price_change_percentage: { h24: "30.5" },
      reserve_in_usd: "2059511.34",
    },
    relationships: { base_token: { data: { id: `robinhood_${TOKEN_A}` } } },
  };

  // Asking about TOKEN_B must not return the pool whose base is TOKEN_A.
  assert.equal(gt.parsePools({ data: [inverted] }, TOKEN_B), null);

  const correct = gt.parsePools({ data: [inverted] }, TOKEN_A)!;
  assert.equal(correct.priceUsd, 0.01214801156);
  assert.equal(correct.priceChange24h, 30.5);
});

test("GeckoTerminal: a pool from another network is rejected even at this address", () => {
  const foreign = {
    attributes: { address: "0xpool", base_token_price_usd: "1" },
    relationships: { base_token: { data: { id: `base_${TOKEN_A}` } } },
  };
  assert.equal(gt.parsePools({ data: [foreign] }, TOKEN_A), null);
});

test("GeckoTerminal: the batch endpoint is keyed lower-case regardless of the request", () => {
  const readings = gt.parseSimplePrices(
    {
      data: {
        attributes: {
          token_prices: { [TOKEN_B.toLowerCase()]: "226.06" },
          market_cap_usd: { [TOKEN_B.toLowerCase()]: "4033915.94" },
          h24_volume_usd: { [TOKEN_B.toLowerCase()]: "8641810.79" },
          h24_price_change_percentage: { [TOKEN_B.toLowerCase()]: "1.0453493042" },
          total_reserve_in_usd: { [TOKEN_B.toLowerCase()]: "1885089.59" },
        },
      },
    },
    [TOKEN_B.toUpperCase().replace("0X", "0x")]
  );

  const data = readings.get(TOKEN_B.toLowerCase())!;
  assert.equal(data.priceUsd, 226.06);
  assert.equal(data.priceChange24h, 1.0453493042);
  assert.equal(data.liquidity, 1885089.59);
});

test("GeckoTerminal: a token missing from the batch response is absent, not zero", () => {
  const readings = gt.parseSimplePrices(
    { data: { attributes: { token_prices: { [TOKEN_A]: "1.5" } } } },
    [TOKEN_A, TOKEN_B]
  );

  assert.equal(readings.size, 1);
  assert.equal(readings.has(TOKEN_B.toLowerCase()), false);
});

test("GeckoTerminal: batching splits at the documented cap of 30", async () => {
  resetBudgets();
  const addresses = Array.from({ length: 45 }, (_, i) => `0x${String(i).padStart(40, "0")}`);
  const { impl, calls } = stubFetch(() => ({ body: { data: { attributes: { token_prices: {} } } } }));

  await gt.fetchBatch(addresses, { fetchImpl: impl });

  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes("/simple/networks/robinhood/token_price/"));
  assert.ok(calls[0].includes("include_market_cap=true"));
  assert.ok(calls[0].includes("include_24hr_price_change=true"));
});
