import test from "node:test";
import assert from "node:assert/strict";

import { assess, LP_CONCENTRATION_PCT, TAX_HIGH_PCT } from "../lib/intel/security";
import { UNASSESSED, type TokenSecurity } from "../lib/goplus";
import { riskScore } from "../lib/intel/score";

/**
 * Contract security.
 *
 * The property that matters most: an absent check must never read as a pass.
 * GoPlus answers 21 of its 36 checks on Robinhood Chain, and the 15 it omits
 * include honeypot, mintable and pausable — so a token here can be genuinely
 * unassessed on exactly the questions a reader cares about, and saying nothing
 * about them would be read as saying they are fine.
 */

const security = (over: Partial<TokenSecurity> = {}): TokenSecurity => ({
  address: "0xtoken",
  name: "Test",
  symbol: "TEST",
  buyTaxPct: 0,
  sellTaxPct: 0,
  transferTaxPct: 0,
  cannotBuy: { assessed: true, value: false },
  cannotSellAll: { assessed: true, value: false },
  honeypotSameCreator: { assessed: true, value: false },
  isOpenSource: { assessed: true, value: true },
  isProxy: { assessed: true, value: false },
  isInDex: { assessed: true, value: true },
  creatorAddress: "0xcreator",
  creatorPercent: 0,
  holderCount: 1000,
  holders: [],
  lpHolderCount: 10,
  lpHolders: [],
  totalSupply: 1000,
  unassessed: [],
  fetchedAt: "2026-01-01T00:00:00Z",
  ...over,
});

test("a token with everything clean reports no concerns", () => {
  const a = assess(security(), "0xtoken");
  assert.equal(a.assessed, true);
  assert.equal(a.concerns.length, 0);
  assert.equal(a.score, 0);
  assert.ok(a.passed.length > 0);
});

test("a provider that did not answer is not a clean bill of health", () => {
  const a = assess(null, "0xtoken");
  assert.equal(a.assessed, false);
  assert.equal(a.score, null, "null, not 0 — unknown must never render as safe");
  assert.equal(a.confidence, 0);
});

test("an unassessed flag is never treated as passing", () => {
  const a = assess(
    security({
      cannotSellAll: UNASSESSED,
      honeypotSameCreator: UNASSESSED,
    }),
    "0xtoken"
  );

  assert.equal(a.concerns.length, 0, "an unassessed check raises no concern");
  assert.ok(
    !a.passed.some((p) => /sold|honeypot/.test(p)),
    "and it must not appear in the passed list either"
  );
});

test("checks this chain does not run are named, not omitted", () => {
  const a = assess(security({ unassessed: ["is_honeypot", "is_mintable"] }), "0xtoken");
  assert.deepEqual(a.unassessed, ["is_honeypot", "is_mintable"]);
});

test("confidence falls as coverage falls", () => {
  const full = assess(security({ unassessed: [] }), "0xtoken");
  const partial = assess(
    security({ unassessed: ["is_honeypot", "is_mintable", "transfer_pausable", "selfdestruct"] }),
    "0xtoken"
  );

  assert.ok(
    partial.confidence < full.confidence,
    `partial coverage must be less confident: ${partial.confidence} vs ${full.confidence}`
  );
});

test("a token that cannot be fully sold is critical", () => {
  const a = assess(security({ cannotSellAll: { assessed: true, value: true } }), "0xtoken");
  assert.equal(a.concerns[0].severity, "critical");
  assert.ok((a.score ?? 0) >= 90);
});

test("a high sell tax is a high-severity concern", () => {
  const a = assess(security({ sellTaxPct: (TAX_HIGH_PCT + 5) / 100 }), "0xtoken");
  const tax = a.concerns.find((c) => c.title.startsWith("Sell tax"));
  assert.ok(tax);
  assert.equal(tax!.severity, "high");
});

test("a trivial tax is noted without being alarming", () => {
  const a = assess(security({ buyTaxPct: 0.01 }), "0xtoken");
  const tax = a.concerns.find((c) => c.title.startsWith("Buy tax"));
  assert.equal(tax?.severity, "low");
});

test("an unverified contract is flagged", () => {
  const a = assess(security({ isOpenSource: { assessed: true, value: false } }), "0xtoken");
  assert.ok(a.concerns.some((c) => /not verified/i.test(c.title)));
});

test("a proxy is flagged by Veltr, and says the owner is unknown here", () => {
  const a = assess(security({ isProxy: { assessed: true, value: true } }), "0xtoken");
  const proxy = a.concerns.find((c) => /upgradeable/i.test(c.title));
  assert.ok(proxy);
  assert.equal(proxy!.source, "veltr", "GoPlus reports the flag; the conclusion is ours");
  assert.match(proxy!.detail, /owner/i);
});

test("liquidity held by one provider is flagged", () => {
  const a = assess(
    security({
      lpHolders: [
        { address: "0xa", isContract: false, percent: LP_CONCENTRATION_PCT + 10, tag: null },
        { address: "0xb", isContract: false, percent: 5, tag: null },
      ],
    }),
    "0xtoken"
  );

  const lp = a.concerns.find((c) => /liquidity/i.test(c.title));
  assert.ok(lp, "one address able to withdraw the market is the point of this check");
  assert.equal(lp!.source, "veltr");
});

test("well-spread liquidity passes instead of warning", () => {
  const a = assess(
    security({
      lpHolders: [
        { address: "0xa", isContract: false, percent: 20, tag: null },
        { address: "0xb", isContract: false, percent: 15, tag: null },
      ],
    }),
    "0xtoken"
  );
  assert.ok(!a.concerns.some((c) => /liquidity/i.test(c.title)));
  assert.ok(a.passed.some((p) => /liquidity spread/i.test(p)));
});

test("a creator holding a large share is flagged", () => {
  const a = assess(security({ creatorPercent: 35 }), "0xtoken");
  assert.ok(a.concerns.some((c) => /Creator holds/.test(c.title)));
});

test("one critical finding outranks several cosmetic ones", () => {
  const critical = assess(security({ cannotSellAll: { assessed: true, value: true } }), "0x");
  const cosmetic = assess(
    security({ buyTaxPct: 0.01, sellTaxPct: 0.01, transferTaxPct: 0.01, creatorPercent: 1 }),
    "0x"
  );

  assert.ok(
    (critical.score ?? 0) > (cosmetic.score ?? 0),
    "summing severities would let five small findings outrank one trap"
  );
});

test("concerns are ordered worst first", () => {
  const a = assess(
    security({
      buyTaxPct: 0.01,
      cannotSellAll: { assessed: true, value: true },
      isProxy: { assessed: true, value: true },
    }),
    "0xtoken"
  );
  assert.equal(a.concerns[0].severity, "critical");
});

/* ------------------------------------------------- Feeding the risk score */

test("security is one weighted input, not an override", () => {
  const base = {
    liquidityUsd: 5_000_000,
    topSharePct: 20,
    holders: 40_000,
    turnover: 0.4,
    volatilityPct: 2,
    multiplierDrifted: false,
  };

  const clean = riskScore({ ...base, securityScore: 0 });
  const moderate = riskScore({ ...base, securityScore: 40 });

  assert.ok((moderate.value ?? 0) > (clean.value ?? 0), "a security concern raises risk");
  assert.ok(
    (moderate.value ?? 0) < 60,
    "but a deep, well-distributed token is not made dangerous by one medium finding"
  );
});

test("a critical contract finding raises the risk floor", () => {
  const safeLooking = {
    liquidityUsd: 5_000_000,
    topSharePct: 20,
    holders: 40_000,
    turnover: 0.4,
    volatilityPct: 2,
    multiplierDrifted: false,
  };

  const trapped = riskScore({ ...safeLooking, securityScore: 100 });
  assert.ok(
    (trapped.value ?? 0) >= 85,
    `a token that cannot be sold is not moderate risk on average, got ${trapped.value}`
  );
});

test("an unassessed contract leaves risk to the other inputs rather than assuming safety", () => {
  const base = {
    liquidityUsd: 4_000,
    topSharePct: 95,
    holders: 12,
    turnover: 12,
    volatilityPct: 60,
    multiplierDrifted: false,
  };

  const unknown = riskScore({ ...base, securityScore: null });
  assert.ok((unknown.value ?? 0) > 70, "thin and captured is still dangerous without a security read");
  assert.ok(unknown.confidence < 1, "and the missing input is reflected in coverage");
});
