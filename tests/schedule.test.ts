import test from "node:test";
import assert from "node:assert/strict";

import {
  compareRun,
  extractFigures,
  figureMoved,
  isRateKey,
  MATERIAL_RATE_POINTS,
  fingerprintRun,
  isDue,
  materiallyDifferent,
  MATERIAL_CHANGE,
  type Schedule,
} from "../lib/agent/schedule";
import { parseInterval } from "../lib/agent/schedule-commands";
import { runScheduleCycle, type ScheduleDeps } from "../lib/agent/schedule-engine";
import type { Mission } from "../lib/agent/types";

/**
 * Recurring missions.
 *
 * The property everything serves: a scheduled run is silent unless the figures
 * it observed actually moved. Comparing the model's prose would report a change
 * every single run, because a model never phrases the same facts twice the same
 * way — the same trap the page tracker had to avoid.
 */

function schedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: "s1",
    ownerId: "111",
    objective: "why is the NVDA premium where it is",
    intervalSec: 3600,
    fingerprint: null,
    lastFigures: {},
    lastSummary: null,
    lastRunAt: null,
    lastChangedAt: null,
    failures: 0,
    enabled: true,
    createdAt: "2026-08-15T00:00:00.000Z",
    ...overrides,
  };
}

function mission(summaries: string[]): Mission {
  return {
    id: "m1",
    ownerId: "111",
    objective: "x",
    state: "completed",
    permissionMode: "read_only",
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
    deadlineAt: "2026-08-15T01:00:00.000Z",
    iterations: 2,
    toolCalls: 2,
    evidence: summaries.map((summary, i) => ({
      id: `e${i + 1}`,
      tool: "get_price",
      args: {},
      ok: true,
      summary,
      urls: [],
      at: "2026-08-15T00:00:00.000Z",
    })),
    steps: [],
    pendingAction: null,
    decisions: [],
    result: { summary: "done", evidenceIds: ["e1"], confidence: null, actionsTaken: [] },
    error: null,
  };
}

/* ------------------------------------------------------------ Figures */

test("figures are read out of the observations under their own names", () => {
  assert.deepEqual({ ...extractFigures('{"price":226.06,"liquidity":1401755}') }, {
    price: 226.06,
    liquidity: 1401755,
  });
});

test("nested figures keep the path they were found at", () => {
  const figures = extractFigures('{"globalCrypto":{"btcDominance":56.11},"chain":{"stockTokens":95}}');
  assert.equal(figures["globalCrypto.btcDominance"], 56.11);
  assert.equal(figures["chain.stockTokens"], 95);
});

test("prose still yields figures, by position", () => {
  const figures = extractFigures("the price is 226.06 and liquidity 1401755");
  assert.deepEqual(Object.values(figures), [226.06, 1401755]);
});

test("timestamps are not figures", () => {
  // A run's own clock would otherwise make every comparison differ.
  const figures = extractFigures('{"at":"2026-08-15T00:00:00.000Z","price":226.06}');
  assert.ok(!Object.values(figures).some((n) => n > 1e11), "epoch-scale numbers are excluded");
  assert.ok(Object.values(figures).includes(226.06));
});

test("a move under the threshold is not a change", () => {
  // 226.06 → 226.09 between hourly runs is not news.
  assert.equal(materiallyDifferent({ price: 226.06 }, { price: 226.09 }), false);
  assert.equal(materiallyDifferent({ price: 226.06 }, { price: 240.0 }), true);
  assert.equal(MATERIAL_CHANGE, 0.02);
});

test("a different set of figures is itself a change", () => {
  // Usually a source dropped out or a new one answered.
  assert.equal(materiallyDifferent({ a: 1, b: 2 }, { a: 1, b: 2, c: 3 }), true);
  assert.equal(materiallyDifferent({ a: 1, b: 2 }, { a: 1, c: 2 }), true);
});

test("figures are matched by name, not by position", () => {
  // A source returning its fields in a different order returned the same numbers.
  assert.equal(materiallyDifferent({ price: 226.06, liq: 1 }, { liq: 1, price: 226.06 }), false);
});

test("values near zero do not produce infinite relative change", () => {
  assert.equal(materiallyDifferent({ x: 0 }, { x: 0 }), false);
  assert.equal(materiallyDifferent({ x: 0 }, { x: 1e-12 }), false);
});

test("the same figures fingerprint the same regardless of key order", () => {
  assert.equal(fingerprintRun({ a: 1, b: 2 }), fingerprintRun({ b: 2, a: 1 }));
  assert.notEqual(fingerprintRun({ a: 1, b: 2 }), fingerprintRun({ a: 1, b: 3 }));
});

/* -------------------------------------------------------------- Rates */

test("a rate that barely moved is not a change, however large the ratio", () => {
  // The bug that made this necessary: an hourly 24h-change figure drifting from
  // -0.0621% to -0.0538% is 13% relative and eight thousandths of a point real.
  assert.equal(figureMoved("exchangeChangePct", -0.0621, -0.0538), false);
  assert.equal(figureMoved("premiumPct", 0.01776, 0.01821), false);
});

test("a rate that genuinely moved is a change", () => {
  assert.equal(figureMoved("exchangeChangePct", -0.06, -6.5), true);
  assert.equal(figureMoved("globalCrypto.btcDominance", 56.11, 60.0), true);
});

test("the absolute floor applies only to rates", () => {
  // Otherwise a token trading at $0.0177 could double unnoticed — magnitude
  // alone cannot tell a cheap price from a ratio, which is why the key is read.
  assert.equal(figureMoved("onChainPrice", 0.01776, 0.03552), true);
  assert.equal(figureMoved("premiumPct", 0.01776, 0.03552), false);
  assert.equal(MATERIAL_RATE_POINTS, 0.25);
});

test("rate-like keys are recognised by name", () => {
  for (const key of ["premiumPct", "exchangeChangePct", "btcDominance", "spread", "apy"]) {
    assert.equal(isRateKey(key), true, key);
  }
  for (const key of ["exchangePrice", "liquidityUsd", "volume24hUsd", "stockTokens"]) {
    assert.equal(isRateKey(key), false, key);
  }
});

test("a quiet market does not wake anyone", () => {
  // The exact reading a live get_price returned, against a plausible one an hour
  // later: price +0.05%, liquidity +0.09%, nothing happened. Compared without
  // names this fired, because the derived percentage moved 13% against itself.
  const before = extractFigures(
    '{"symbol":"NVDA","exchangePrice":225.16,"exchangeChangePct":-0.0621,"previousClose":225.3,' +
      '"onChainPrice":225.2,"premiumPct":0.01776514478593061,"liquidityUsd":1364619.17,"volume24hUsd":459305.56}'
  );
  const after = extractFigures(
    '{"symbol":"NVDA","exchangePrice":225.28,"exchangeChangePct":-0.0538,"previousClose":225.3,' +
      '"onChainPrice":225.31,"premiumPct":0.01821,"liquidityUsd":1365900.02,"volume24hUsd":459812.11}'
  );

  assert.notEqual(fingerprintRun(before), fingerprintRun(after), "the reading did change");
  assert.equal(materiallyDifferent(before, after), false, "but not in any way worth a message");
});

test("a real move on the same reading is still caught", () => {
  const before = extractFigures(
    '{"exchangePrice":225.16,"exchangeChangePct":-0.0621,"liquidityUsd":1364619.17}'
  );
  const crash = extractFigures(
    '{"exchangePrice":198.40,"exchangeChangePct":-11.9,"liquidityUsd":1361200.00}'
  );
  assert.equal(materiallyDifferent(before, crash), true);

  // And a drain of liquidity, with the price untouched.
  const drained = extractFigures(
    '{"exchangePrice":225.16,"exchangeChangePct":-0.0621,"liquidityUsd":402000.00}'
  );
  assert.equal(materiallyDifferent(before, drained), true);
});

/* ---------------------------------------------------------- Comparison */

test("the first run establishes a baseline and reports nothing", () => {
  const c = compareRun(schedule(), mission(['{"price":226.06}']));
  assert.equal(c.changed, false);
  assert.equal(c.reason, "first-run");
  assert.ok(c.fingerprint);
});

test("an identical run reports nothing", () => {
  const first = compareRun(schedule(), mission(['{"price":226.06}']));
  const c = compareRun(
    schedule({ fingerprint: first.fingerprint, lastFigures: first.figures }),
    mission(['{"price":226.06}'])
  );
  assert.equal(c.changed, false);
  assert.equal(c.reason, "no-change");
});

test("a hash that moved but figures that barely did stays silent", () => {
  // The common case on a live market, and the reason this is not a hash compare.
  const first = compareRun(schedule(), mission(['{"price":226.06}']));
  const c = compareRun(
    schedule({ fingerprint: first.fingerprint, lastFigures: first.figures }),
    mission(['{"price":226.09}'])
  );
  assert.notEqual(c.fingerprint, first.fingerprint, "the hash did change");
  assert.equal(c.changed, false, "but not by enough to interrupt anyone");
});

test("a real move is reported", () => {
  const first = compareRun(schedule(), mission(['{"price":226.06}']));
  const c = compareRun(
    schedule({ fingerprint: first.fingerprint, lastFigures: first.figures }),
    mission(['{"price":198.40}'])
  );
  assert.equal(c.changed, true);
  assert.equal(c.reason, "figures-moved");
});

test("a run that observed nothing is not a change", () => {
  const c = compareRun(schedule({ fingerprint: "abc", lastFigures: { price: 1 } }), mission(["no numbers here"]));
  assert.equal(c.changed, false);
  assert.equal(c.reason, "no-evidence");
});

/* ------------------------------------------------------------ Interval */

test("intervals are read the way people write them", () => {
  assert.equal(parseInterval("30m"), 1800);
  assert.equal(parseInterval("2h"), 7200);
  assert.equal(parseInterval("90"), 5400, "a bare number means minutes");
  assert.equal(parseInterval("1.5h"), 5400);
});

test("nonsense is refused rather than defaulted", () => {
  for (const bad of ["", "soon", "-5m", "0", "1d"]) {
    assert.equal(parseInterval(bad), null, bad);
  }
});

test("due only once the interval has elapsed", () => {
  const now = new Date("2026-08-15T12:00:00.000Z");
  assert.equal(isDue(schedule({ lastRunAt: null }), now), true);
  assert.equal(isDue(schedule({ lastRunAt: "2026-08-15T11:30:00.000Z" }), now), false);
  assert.equal(isDue(schedule({ lastRunAt: "2026-08-15T10:30:00.000Z" }), now), true);
  assert.equal(isDue(schedule({ enabled: false, lastRunAt: null }), now), false);
});

/* -------------------------------------------------------------- Engine */

function harness(options: { schedules: Schedule[]; summaries: string[] | null }) {
  const sent: string[] = [];
  const saved: Schedule[] = [];
  let runs = 0;

  const deps: Partial<ScheduleDeps> = {
    loadSchedules: async () => options.schedules,
    runMission: async () => {
      runs++;
      return options.summaries === null ? null : mission(options.summaries);
    },
    save: async (s) => void saved.push(s),
    send: async (_o, text) => {
      sent.push(text);
      return true;
    },
    now: () => new Date("2026-08-15T12:00:00.000Z"),
  };

  return { deps, sent, saved, runs: () => runs };
}

test("a first run stores a baseline and sends nothing", async () => {
  const h = harness({ schedules: [schedule()], summaries: ['{"price":226.06}'] });
  const report = await runScheduleCycle(h.deps);

  assert.equal(report.ran, 1);
  assert.equal(report.changed, 0);
  assert.deepEqual(h.sent, []);
  assert.ok(h.saved[0].fingerprint, "the baseline was recorded");
});

test("a moved figure produces exactly one message", async () => {
  const base = compareRun(schedule(), mission(['{"price":226.06}']));
  const h = harness({
    schedules: [schedule({ fingerprint: base.fingerprint, lastFigures: base.figures, lastRunAt: "2026-08-15T10:00:00.000Z" })],
    summaries: ['{"price":150.00}'],
  });

  const report = await runScheduleCycle(h.deps);

  assert.equal(report.changed, 1);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /SCHEDULED MISSION/);
  assert.equal(h.saved[0].lastChangedAt, "2026-08-15T12:00:00.000Z");
});

test("nothing due means no mission is run at all", async () => {
  const h = harness({
    schedules: [schedule({ lastRunAt: "2026-08-15T11:59:00.000Z" })],
    summaries: ['{"price":1}'],
  });

  const report = await runScheduleCycle(h.deps);
  assert.equal(report.due, 0);
  assert.equal(h.runs(), 0, "a mission is expensive; due-ness is checked before spending one");
});

test("only one mission runs per cycle however many are due", async () => {
  const h = harness({
    schedules: [schedule({ id: "a" }), schedule({ id: "b", objective: "second" }), schedule({ id: "c", objective: "third" })],
    summaries: ['{"price":1}'],
  });

  const report = await runScheduleCycle(h.deps);
  assert.equal(report.due, 3);
  assert.equal(h.runs(), 1, "five model conversations queued behind each other would stall the scheduler");
});

test("a failed run counts towards pausing rather than retrying forever", async () => {
  const h = harness({ schedules: [schedule({ failures: 4 })], summaries: null });
  const report = await runScheduleCycle(h.deps);

  assert.equal(report.failed, 1);
  assert.equal(report.paused, 1);
  assert.equal(h.saved[0].enabled, false);
  assert.deepEqual(h.sent, [], "and the owner is not told about it every cycle");
});

test("a run with no evidence does not overwrite the last good baseline", async () => {
  const h = harness({
    schedules: [schedule({ fingerprint: "keepme", lastFigures: { price: 226.06 } })],
    summaries: ["nothing numeric at all"],
  });

  await runScheduleCycle(h.deps);

  assert.equal(h.saved[0].fingerprint, "keepme", "otherwise the next real run would look like a change");
  assert.equal(h.saved[0].failures, 1);
});
