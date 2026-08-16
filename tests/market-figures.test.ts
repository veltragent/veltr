import test from "node:test";
import assert from "node:assert/strict";

import { quoteFromPairsForTests as quoteFromPairs } from "../lib/market";

/**
 * Price, liquidity and volume for a token that trades in many pools.
 *
 * The defect these guard against: liquidity and volume were read off the single
 * deepest pair. For NVDA that pair held $1.38M of $2.58M and did $415k of the
 * $4.00M traded in a day, so both figures were published at a fraction of the
 * truth while looking like totals.
 */

type Pair = Parameters<typeof quoteFromPairs>[0][number];

function pair(over: Partial<Pair> = {}): Pair {
  return {
    chainId: "robinhood",
    dexId: "uniswap",
    pairAddress: "0xpair",
    baseToken: { address: "0xnvda", symbol: "NVDA" },
    quoteToken: { symbol: "USDG" },
    priceUsd: "225.00",
    liquidity: { usd: 100_000 },
    volume: { h24: 50_000 },
    txns: { h24: { buys: 10, sells: 5 } },
    ...over,
  } as Pair;
}

test("price comes from the deepest pool", () => {
  // A thin pool's price is noise; the deep one has the liquidity to defend it.
  const q = quoteFromPairs([
    pair({ priceUsd: "218.43", liquidity: { usd: 147_132 } }),
    pair({ priceUsd: "226.00", liquidity: { usd: 1_383_229 } }),
    pair({ priceUsd: "233.69", liquidity: { usd: 0 } }),
  ]);
  assert.equal(q?.priceUsd, 226);
});

test("liquidity is every pool, not the deepest one", () => {
  const q = quoteFromPairs([
    pair({ liquidity: { usd: 1_383_229 } }),
    pair({ liquidity: { usd: 654_672 } }),
    pair({ liquidity: { usd: 129_373 } }),
  ]);
  assert.equal(q?.liquidityUsd, 2_167_274);
  assert.equal(q?.deepestLiquidityUsd, 1_383_229, "the deepest is still reported, separately");
});

test("volume is every pool too", () => {
  const q = quoteFromPairs([
    pair({ liquidity: { usd: 1_383_229 }, volume: { h24: 415_214 } }),
    pair({ liquidity: { usd: 654_672 }, volume: { h24: 3_254_258 } }),
  ]);
  // The deepest pool is not the busiest — reading volume off it understated
  // NVDA by an order of magnitude.
  assert.equal(q?.volume24hUsd, 3_669_472);
});

test("trade counts are summed the same way", () => {
  const q = quoteFromPairs([
    pair({ txns: { h24: { buys: 10, sells: 5 } } }),
    pair({ txns: { h24: { buys: 3, sells: 7 } } }),
  ]);
  assert.equal(q?.buys24h, 13);
  assert.equal(q?.sells24h, 12);
});

test("the pool count is reported so a total can be checked", () => {
  assert.equal(quoteFromPairs([pair(), pair(), pair()])?.poolCount, 3);
});

test("a missing field counts as zero, not as NaN", () => {
  const q = quoteFromPairs([pair(), pair({ liquidity: undefined, volume: undefined, txns: undefined })]);
  assert.equal(q?.liquidityUsd, 100_000);
  assert.equal(q?.volume24hUsd, 50_000);
  assert.ok(Number.isFinite(q?.buys24h ?? NaN));
});

test("no pools means no reading, not a reading of zero", () => {
  assert.equal(quoteFromPairs([]), null);
});

test("an unusable price is refused rather than published", () => {
  // A pool that reports no price cannot set one for the token.
  assert.equal(quoteFromPairs([pair({ priceUsd: undefined })]), null);
  assert.equal(quoteFromPairs([pair({ priceUsd: "0" })]), null);
  assert.equal(quoteFromPairs([pair({ priceUsd: "not a number" })]), null);
});
