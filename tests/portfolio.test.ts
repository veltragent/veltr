import test from "node:test";
import assert from "node:assert/strict";

import { readPortfolio, toUnits, DUST_UNITS, type PortfolioDeps } from "../lib/portfolio";

/**
 * What an address holds.
 *
 * The property everything else rests on: the balance read is `balanceOfUI`, so
 * a holding is correct after a split. Reading plain `balanceOf` would misstate
 * exposure by exactly the amount of the corporate action this product exists to
 * warn people about.
 */

const OWNER = "0x1111111111111111111111111111111111111111";
const NVDA = "0xaaa0000000000000000000000000000000000001";
const AAPL = "0xaaa0000000000000000000000000000000000002";

function deps(overrides: Partial<PortfolioDeps> = {}): Partial<PortfolioDeps> {
  return {
    listTokens: async () => [
      { address: NVDA, symbol: "NVDA", name: "NVIDIA", decimals: 18, priceUsd: 217.05, actionPending: false },
      { address: AAPL, symbol: "AAPL", name: "Apple", decimals: 18, priceUsd: 100, actionPending: false },
    ],
    readBalances: async () => [2n * 10n ** 18n, 0n],
    premiums: async () => ({ bySymbol: new Map([["NVDA", -3.6]]), marketOpen: true }),
    ...overrides,
  };
}

test("a holding is valued at the token price", async () => {
  const p = await readPortfolio(OWNER, deps());

  assert.equal(p.holdings.length, 1);
  assert.equal(p.holdings[0].symbol, "NVDA");
  assert.equal(p.holdings[0].units, 2);
  assert.equal(p.holdings[0].valueUsd, 434.1);
  assert.equal(p.totalValueUsd, 434.1);
});

test("a zero balance is not a holding", async () => {
  const p = await readPortfolio(OWNER, deps());
  assert.equal(p.holdings.some((h) => h.symbol === "AAPL"), false);
});

test("dust is not a position", async () => {
  // A few billionths of a share is a rounding artefact of a transfer, and thirty
  // of them bury the two holdings that matter.
  const p = await readPortfolio(OWNER, deps({ readBalances: async () => [1n, 0n] }));
  assert.deepEqual(p.holdings, []);
  assert.ok(DUST_UNITS > 0);
});

test("a token that could not be read is skipped, not counted as empty", async () => {
  // allowFailure yields null for a revert; treating that as a zero balance would
  // quietly drop a real position from the total.
  const p = await readPortfolio(OWNER, deps({ readBalances: async () => [null, null] }));
  assert.deepEqual(p.holdings, []);
  assert.equal(p.tokensChecked, 2, "and the read is still known to have happened");
});

/* ------------------------------------------------------------- Premium */

test("the same exposure is also valued at the underlying share price", async () => {
  // 434.10 of a token trading 3.6% below the share is 450.31 of actual shares.
  const p = await readPortfolio(OWNER, deps());
  assert.equal(p.holdings[0].premiumPct, -3.6);
  assert.equal(Math.round((p.holdings[0].valueAtSharePriceUsd ?? 0) * 100) / 100, 450.31);
  assert.equal(Math.round((p.totalAtSharePriceUsd ?? 0) * 100) / 100, 450.31);
});

test("no premium is claimed while the equity market is shut", async () => {
  // The reference would be a stale close, so the dollar gap would be fiction.
  const p = await readPortfolio(
    OWNER,
    deps({ premiums: async () => ({ bySymbol: new Map([["NVDA", -3.6]]), marketOpen: false }) })
  );

  assert.equal(p.premiumIsStale, true);
  assert.equal(p.holdings[0].premiumPct, null);
  assert.equal(p.holdings[0].valueAtSharePriceUsd, null);
  assert.equal(p.totalAtSharePriceUsd, null, "and no total is invented from nothing");
});

test("a token with no premium still counts towards the value held", async () => {
  const p = await readPortfolio(
    OWNER,
    deps({ premiums: async () => ({ bySymbol: new Map(), marketOpen: true }) })
  );
  assert.equal(p.totalValueUsd, 434.1);
  assert.equal(p.totalAtSharePriceUsd, null);
});

test("a premium feed that fails costs the premium, not the portfolio", async () => {
  const p = await readPortfolio(
    OWNER,
    deps({ premiums: async () => { throw new Error("down"); } })
  );
  assert.equal(p.totalValueUsd, 434.1);
  assert.equal(p.holdings[0].premiumPct, null);
});

/* --------------------------------------------------------------- Units */

test("units survive a balance that does not divide evenly", async () => {
  // 1.5 shares, in wei.
  assert.equal(toUnits(1_500_000_000_000_000_000n, 18), 1.5);
  assert.equal(toUnits(0n, 18), 0);
  assert.equal(toUnits(123_456n, 6), 0.123456);
});

test("a large balance does not lose its fractional part", async () => {
  // Number(raw) alone would round this away entirely.
  const raw = 12_345_678n * 10n ** 18n + 5n * 10n ** 17n;
  assert.equal(toUnits(raw, 18), 12_345_678.5);
});

/* -------------------------------------------------------------- Sorting */

test("the largest position is first", async () => {
  const p = await readPortfolio(
    OWNER,
    deps({ readBalances: async () => [1n * 10n ** 18n, 100n * 10n ** 18n] })
  );
  assert.deepEqual(p.holdings.map((h) => h.symbol), ["AAPL", "NVDA"]);
});

test("a queued corporate action is flagged on the holding it will hit", async () => {
  const p = await readPortfolio(
    OWNER,
    deps({
      listTokens: async () => [
        { address: NVDA, symbol: "NVDA", name: "NVIDIA", decimals: 18, priceUsd: 217.05, actionPending: true },
      ],
      readBalances: async () => [2n * 10n ** 18n],
    })
  );
  assert.equal(p.holdings[0].actionPending, true);
});
