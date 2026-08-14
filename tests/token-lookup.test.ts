import test from "node:test";
import assert from "node:assert/strict";

import { rankCandidates } from "../lib/token-lookup";
import type { DsPair } from "../lib/watch/providers/dexscreener";

/**
 * Symbol resolution on a chain where symbols are not unique.
 *
 * The figures below are real: six tokens on Robinhood Chain answer to "NVDA",
 * and the one with the deepest liquidity that is *not* the tokenised stock
 * trades at $0.00000034. Getting this ranking wrong quotes a copycat.
 */

const pair = (
  address: string,
  symbol: string,
  name: string,
  liquidity: number,
  priceUsd = "1",
  chainId = "robinhood"
): DsPair => ({
  chainId,
  pairAddress: `pair-${address}`,
  baseToken: { address, symbol, name },
  priceUsd,
  liquidity: { usd: liquidity },
});

test("among exact symbol matches, depth decides", () => {
  // The bug this replaced: "Open AI" outranked "Artificial Inu" because its
  // name also contains the query, despite three times less liquidity.
  const ranked = rankCandidates(
    [
      pair("0x19c6", "AI", "Open AI", 302_131),
      pair("0x2E8c", "AI", "Artificial Inu", 921_167),
      pair("0x5279", "AI", "AI Token", 27_517),
    ],
    "AI"
  );

  assert.equal(ranked[0].name, "Artificial Inu");
  assert.equal(ranked[0].liquidityUsd, 921_167);
  assert.equal(ranked.length, 3, "the others are still returned, as alternates");
});

test("an exact symbol match outranks a deeper partial match", () => {
  const ranked = rankCandidates(
    [
      pair("0xdeep", "AIXBT", "AIXBT Agent", 5_000_000),
      pair("0xexact", "AI", "Artificial Inu", 900_000),
    ],
    "AI"
  );

  assert.equal(ranked[0].symbol, "AI", "searching AI must not return AIXBT because it is bigger");
});

test("a name match resolves when the symbol does not", () => {
  const ranked = rankCandidates([pair("0x2E8c", "AI", "Artificial Inu", 921_167)], "Artificial Inu");
  assert.equal(ranked[0].address, "0x2E8c");
});

test("tokens on other chains are never candidates", () => {
  const ranked = rankCandidates(
    [
      pair("0xbase", "AI", "AI on Base", 50_000_000, "1", "base"),
      pair("0xhere", "AI", "Artificial Inu", 900_000),
    ],
    "AI"
  );

  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].address, "0xhere", "an identical symbol on another chain is a different asset");
});

test("one token with many pools is one candidate, at its deepest pool", () => {
  const ranked = rankCandidates(
    [
      pair("0x2E8c", "AI", "Artificial Inu", 100_000),
      pair("0x2E8c", "AI", "Artificial Inu", 921_167),
      pair("0x2E8c", "AI", "Artificial Inu", 4_000),
    ],
    "AI"
  );

  assert.equal(ranked.length, 1, "six pools is one token, not six results");
  assert.equal(ranked[0].liquidityUsd, 921_167);
});

test("a query matching nothing returns nothing rather than the largest token", () => {
  const ranked = rankCandidates(
    [pair("0x1", "NVDA", "NVIDIA", 1_400_000), pair("0x2", "AI", "Artificial Inu", 900_000)],
    "ZZZQQQ"
  );
  assert.deepEqual(ranked, []);
});

test("candidates carry the address, so a caveat can name it", () => {
  const ranked = rankCandidates([pair("0xDeCF", "NVDA", "NVDA", 31_110, "0.00000034")], "NVDA");

  assert.equal(ranked[0].address, "0xDeCF");
  assert.equal(ranked[0].priceUsd, 0.00000034);
  assert.equal(ranked[0].liquidityUsd, 31_110);
});

test("a pair with no base address is skipped rather than ranked as blank", () => {
  const broken = { chainId: "robinhood", baseToken: { symbol: "AI" }, liquidity: { usd: 9_000_000 } } as DsPair;
  const ranked = rankCandidates([broken, pair("0x2E8c", "AI", "Artificial Inu", 900_000)], "AI");

  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].address, "0x2E8c");
});

test("matching is case insensitive in both directions", () => {
  const ranked = rankCandidates([pair("0x2E8c", "ai", "artificial inu", 900_000)], "AI");
  assert.equal(ranked.length, 1);
});
