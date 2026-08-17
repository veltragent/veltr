import test from "node:test";
import assert from "node:assert/strict";

import { analyseFlow, aggregateWallets, MIN_TRADE_USD, DEFAULT_SMART_MONEY } from "../lib/intel/smart-money";
import type { CodexSwap } from "../lib/codex";
import {
  applyCooldowns,
  rank,
  signalFromSmartMoney,
  signalsFromAnomalies,
  wanted,
  DEFAULT_SIGNAL_PREFERENCES,
} from "../lib/intel/signals";
import { compareFlows } from "../lib/intel/relationships";
import { preferencesFrom, updatePreference } from "../lib/intel/preferences";
import { normaliseSettings, DEFAULT_SETTINGS } from "../lib/watch/settings";

/**
 * Flow analysis, signal delivery and the claims each is allowed to make.
 *
 * The tests that matter most here are the ones asserting restraint: that a thin
 * window produces "insufficient" rather than a verdict, and that one large buyer
 * is never reported as a crowd.
 */

let clock = 1_700_000_000;
const swap = (over: Partial<CodexSwap> = {}): CodexSwap => ({
  type: "Swap",
  timestamp: clock++,
  valueUsd: 1000,
  units: 1,
  priceUsd: 100,
  maker: "0xaaa",
  txHash: "0xhash",
  side: "buy",
  ...over,
});

const many = (n: number, over: Partial<CodexSwap> = {}) =>
  Array.from({ length: n }, (_, i) => swap({ maker: `0xw${i % 10}`, ...over }));

test("dust is excluded from wallet aggregation", () => {
  const wallets = aggregateWallets([
    swap({ maker: "0xa", valueUsd: MIN_TRADE_USD - 1 }),
    swap({ maker: "0xa", valueUsd: 500 }),
  ]);
  assert.equal(wallets.length, 1);
  assert.equal(wallets[0].buys, 1, "only the trade above the dust floor counted");
});

test("swaps with no direction are ignored rather than guessed at", () => {
  const wallets = aggregateWallets([
    swap({ maker: "0xa", side: null }),
    swap({ maker: "0xa", side: "buy" }),
  ]);
  assert.equal(wallets[0].buys + wallets[0].sells, 1);
});

test("buy and sell totals are kept separate and net correctly", () => {
  const wallets = aggregateWallets([
    swap({ maker: "0xa", side: "buy", valueUsd: 1000 }),
    swap({ maker: "0xa", side: "sell", valueUsd: 400 }),
  ]);
  assert.equal(wallets[0].buyUsd, 1000);
  assert.equal(wallets[0].sellUsd, 400);
  assert.equal(wallets[0].netUsd, 600);
  assert.equal(wallets[0].largestUsd, 1000);
});

test("an empty window yields no verdict at all", () => {
  const read = analyseFlow("0xtoken", "TEST", [], 0, false);
  assert.equal(read.verdict, "insufficient");
  assert.equal(read.confidence, 0);
});

test("a handful of trades is described but not concluded from", () => {
  const read = analyseFlow("0xtoken", "TEST", many(4), 600, false);
  assert.notEqual(read.verdict, "accumulation", "four trades cannot establish accumulation");
});

test("one large buyer against several sellers is not accumulation", () => {
  /*
   * The defect this pins: net flow alone was positive, so a single whale buying
   * against six wallets selling was being reported as "SMART MONEY
   * ACCUMULATION" — a crowd that did not exist.
   */
  const swaps: CodexSwap[] = [
    ...Array.from({ length: 8 }, () => swap({ maker: "0xwhale", side: "buy", valueUsd: 50_000 })),
    ...Array.from({ length: 6 }, (_, i) =>
      Array.from({ length: 3 }, () => swap({ maker: `0xseller${i}`, side: "sell", valueUsd: 2_000 }))
    ).flat(),
  ];

  const read = analyseFlow("0xtoken", "TEST", swaps, 6 * 3600, false);
  assert.ok(read.netFlowUsd > 0, "the money does lean positive");
  assert.notEqual(read.verdict, "accumulation", "but one buyer is not a crowd");
});

test("broad one-sided buying with enough evidence does read as accumulation", () => {
  const swaps = Array.from({ length: 10 }, (_, i) =>
    Array.from({ length: 6 }, () => swap({ maker: `0xbuyer${i}`, side: "buy", valueUsd: 3_000 }))
  ).flat();

  const read = analyseFlow("0xtoken", "TEST", swaps, 6 * 3600, false);
  assert.equal(read.verdict, "accumulation");
  assert.ok(read.accumulating.length >= DEFAULT_SMART_MONEY.minWallets);
  assert.ok(read.confidence > 0);
});

test("the reported window is the span actually covered", () => {
  const read = analyseFlow("0xtoken", "TEST", many(30), 2.5 * 3600, true);
  assert.ok(Math.abs(read.windowHours - 2.5) < 0.001);
  assert.equal(read.truncated, true);
});

test("a truncated window is reported at lower confidence than a complete one", () => {
  const swaps = many(60, { side: "buy", valueUsd: 3000 });
  const complete = analyseFlow("0xt", "T", swaps, 6 * 3600, false);
  const partial = analyseFlow("0xt", "T", swaps, 6 * 3600, true);
  assert.ok(partial.confidence < complete.confidence);
});

/* -------------------------------------------------------------- Signals */

test("a balanced flow read produces no signal", () => {
  const read = analyseFlow("0xtoken", "TEST", many(4), 600, false);
  assert.equal(signalFromSmartMoney(read), null);
});

test("anomalies map onto signal kinds without losing their facts", () => {
  const signals = signalsFromAnomalies({
    address: "0xtoken",
    symbol: "TEST",
    anomalies: [
      { kind: "volume_spike", score: 90, confidence: 70, changePct: 400, sigma: 6, detail: "volume +400%" },
    ],
    topScore: 90,
    hasBaseline: true,
    samples: 40,
  });

  assert.equal(signals.length, 1);
  assert.equal(signals[0].kind, "volume_spike");
  assert.equal(signals[0].strength, 90);
  assert.ok(signals[0].facts.some((f) => f.includes("volume +400%")));
  assert.ok(signals[0].facts.some((f) => f.includes("6.0σ")));
});

test("a signal without a baseline says so in its own facts", () => {
  const signals = signalsFromAnomalies({
    address: "0xt",
    symbol: "T",
    anomalies: [{ kind: "buy_pressure", score: 80, confidence: 60, changePct: null, sigma: null, detail: "90% buying" }],
    topScore: 80,
    hasBaseline: false,
    samples: 0,
  });
  assert.ok(signals[0].facts.some((f) => f.includes("No recorded history")));
});

test("cooldown suppresses a repeat and lets an unrelated kind through", () => {
  const base = {
    address: "0xtoken",
    symbol: "T",
    title: "X",
    strength: 80,
    confidence: 80,
    facts: [],
    at: 0,
  };
  const volume = { ...base, kind: "volume_spike" as const };
  const smart = { ...base, kind: "smart_money" as const };

  const first = applyCooldowns([volume], "user1", {}, 1000, 3600);
  assert.equal(first.deliver.length, 1);

  const repeat = applyCooldowns([volume], "user1", first.cooldowns, 2000, 3600);
  assert.equal(repeat.deliver.length, 0, "same kind, same token, inside the window");

  const other = applyCooldowns([smart], "user1", first.cooldowns, 2000, 3600);
  assert.equal(other.deliver.length, 1, "a different kind is not suppressed");

  const later = applyCooldowns([volume], "user1", first.cooldowns, 1000 + 3601, 3600);
  assert.equal(later.deliver.length, 1, "and it returns once the window passes");
});

test("one user's cooldown never silences another's alert", () => {
  const signal = {
    kind: "volume_spike" as const,
    address: "0xtoken",
    symbol: "T",
    title: "X",
    strength: 80,
    confidence: 80,
    facts: [],
    at: 0,
  };

  const first = applyCooldowns([signal], "userA", {}, 1000, 3600);
  const second = applyCooldowns([signal], "userB", first.cooldowns, 1000, 3600);
  assert.equal(second.deliver.length, 1);
});

test("preferences filter by confidence and by kind", () => {
  const signal = {
    kind: "volume_spike" as const,
    address: "0x",
    symbol: null,
    title: "X",
    strength: 90,
    confidence: 50,
    facts: [],
    at: 0,
  };

  assert.equal(wanted(signal, { ...DEFAULT_SIGNAL_PREFERENCES, minConfidence: 60 }), false);
  assert.equal(wanted(signal, { ...DEFAULT_SIGNAL_PREFERENCES, minConfidence: 40 }), true);
  assert.equal(
    wanted(signal, { ...DEFAULT_SIGNAL_PREFERENCES, minConfidence: 40, kinds: ["smart_money"] }),
    false
  );
  assert.equal(
    wanted(signal, { ...DEFAULT_SIGNAL_PREFERENCES, minConfidence: 40, kinds: ["volume_spike"] }),
    true
  );
});

test("ranking puts the strongest first, then the best evidenced", () => {
  const mk = (strength: number, confidence: number) => ({
    kind: "anomaly" as const,
    address: "0x",
    symbol: null,
    title: "",
    strength,
    confidence,
    facts: [],
    at: 0,
  });
  const ranked = rank([mk(50, 90), mk(90, 10), mk(90, 80)]);
  assert.deepEqual(
    ranked.map((r) => [r.strength, r.confidence]),
    [
      [90, 80],
      [90, 10],
      [50, 90],
    ]
  );
});

/* ---------------------------------------------------------- Preferences */

test("signals are off unless a user turns them on", () => {
  const prefs = preferencesFrom(DEFAULT_SETTINGS);
  assert.ok(prefs.minConfidence > 95, "an impossible bar is the off switch");
});

test("signal preferences survive a settings round-trip", () => {
  /*
   * The defect this pins: normaliseSettings rebuilds from defaults, so without
   * explicit preservation every signal preference was silently erased on the
   * first read after being set.
   */
  const stored = {
    ...DEFAULT_SETTINGS,
    signalsEnabled: true,
    signalMinConfidence: 75,
    signalCooldownSec: 7200,
    signalKinds: ["smart_money"],
  };

  const round = normaliseSettings(stored);
  const prefs = preferencesFrom(round);

  assert.equal(prefs.minConfidence, 75);
  assert.equal(prefs.cooldownSec, 7200);
  assert.deepEqual(prefs.kinds, ["smart_money"]);
});

test("a rubbish stored preference falls back rather than poisoning the engine", () => {
  const round = normaliseSettings({
    ...DEFAULT_SETTINGS,
    signalsEnabled: true,
    signalMinConfidence: "very high",
    signalKinds: "not-an-array",
  });
  const prefs = preferencesFrom(round);
  assert.equal(prefs.minConfidence, DEFAULT_SIGNAL_PREFERENCES.minConfidence);
  assert.deepEqual(prefs.kinds, []);
});

test("preference updates validate instead of clamping silently", () => {
  assert.deepEqual(updatePreference("signalsEnabled", "on"), { ok: true, patch: { signalsEnabled: true } });
  assert.equal(updatePreference("signalMinConfidence", "200").ok, false);
  assert.equal(updatePreference("signalCooldownSec", "1s").ok, false, "below the floor");
  assert.equal(updatePreference("signalKinds", "smart_money volume_spike").ok, true);
  assert.equal(updatePreference("signalKinds", "nonsense").ok, false);
  assert.deepEqual(updatePreference("signalKinds", "all"), { ok: true, patch: { signalKinds: [] } });
});

test("a cooldown below the floor is rejected so signals cannot become a firehose", () => {
  const result = updatePreference("signalCooldownSec", "60");
  assert.equal(result.ok, false);
});

/* --------------------------------------------------------- Relationships */

const side = (entries: Array<[string, boolean, number]>) =>
  new Map(entries.map(([w, bought, at]) => [w, { bought, at }]));

test("overlap is measured against the smaller token's trader set", () => {
  const overlap = compareFlows(
    { address: "0xa", symbol: "A", wallets: side([["0x1", true, 100], ["0x2", true, 200]]) },
    {
      address: "0xb",
      symbol: "B",
      wallets: side([
        ["0x1", true, 150],
        ["0x9", false, 400],
        ["0x8", false, 500],
        ["0x7", false, 600],
      ]),
    },
    6
  );

  assert.equal(overlap.shared.length, 1);
  assert.equal(overlap.overlapPct, 50, "1 of the smaller side's 2, not 1 of the union's 5");
  assert.equal(overlap.sharedBuyers, 1);
  assert.equal(overlap.nearSimultaneous, 1, "50 seconds apart is well inside the hour");
});

test("no overlap yields zero strength and keeps the caveat", () => {
  const overlap = compareFlows(
    { address: "0xa", symbol: "A", wallets: side([["0x1", true, 100]]) },
    { address: "0xb", symbol: "B", wallets: side([["0x2", true, 100]]) },
    6
  );
  assert.equal(overlap.shared.length, 0);
  assert.equal(overlap.strength, 0);
  assert.ok(overlap.caveat.includes("does not establish common ownership"));
});

test("wallets that merely touched both score below wallets that bought both together", () => {
  const weak = compareFlows(
    { address: "0xa", symbol: "A", wallets: side([["0x1", false, 0], ["0x2", false, 0]]) },
    { address: "0xb", symbol: "B", wallets: side([["0x1", false, 99_999], ["0x2", false, 99_999]]) },
    6
  );
  const strong = compareFlows(
    { address: "0xa", symbol: "A", wallets: side([["0x1", true, 100], ["0x2", true, 100]]) },
    { address: "0xb", symbol: "B", wallets: side([["0x1", true, 200], ["0x2", true, 200]]) },
    6
  );
  assert.ok(strong.strength > weak.strength);
});

test("an empty side cannot produce a relationship", () => {
  const overlap = compareFlows(
    { address: "0xa", symbol: "A", wallets: side([]) },
    { address: "0xb", symbol: "B", wallets: side([["0x1", true, 100]]) },
    6
  );
  assert.equal(overlap.overlapPct, null);
  assert.equal(overlap.confidence, 0);
});
