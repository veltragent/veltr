import test from "node:test";
import assert from "node:assert/strict";

import {
  compareRun,
  extractFigures,
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
    lastFigures: [],
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

test("figures are read out of the observations", () => {
  assert.deepEqual(extractFigures('{"price":226.06,"liquidity":1401755}'), [226.06, 1401755]);
});

test("timestamps are not figures", () => {
  // A run's own clock would otherwise make every comparison differ.
  const figures = extractFigures('{"at":"2026-08-15T00:00:00.000Z","price":226.06}');
  assert.ok(!figures.some((n) => n > 1e11), "epoch-scale numbers are excluded");
  assert.ok(figures.includes(226.06));
});

test("a move under the threshold is not a change", () => {
  // 226.06 → 226.09 between hourly runs is not news.
  assert.equal(materiallyDifferent([226.06], [226.09]), false);
  assert.equal(materiallyDifferent([226.06], [240.0]), true);
  assert.equal(MATERIAL_CHANGE, 0.02);
});

test("a different number of figures is itself a change", () => {
  // Usually a source dropped out or a new one answered.
  assert.equal(materiallyDifferent([1, 2], [1, 2, 3]), true);
});

test("values near zero do not produce infinite relative change", () => {
  assert.equal(materiallyDifferent([0], [0]), false);
  assert.equal(materiallyDifferent([0], [1e-12]), false);
});

test("the same figures fingerprint the same", () => {
  assert.equal(fingerprintRun([1, 2, 3]), fingerprintRun([1, 2, 3]));
  assert.notEqual(fingerprintRun([1, 2, 3]), fingerprintRun([1, 2, 4]));
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
  const c = compareRun(schedule({ fingerprint: "abc", lastFigures: [1] }), mission(["no numbers here"]));
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
    schedules: [schedule({ fingerprint: "keepme", lastFigures: [226.06] })],
    summaries: ["nothing numeric at all"],
  });

  await runScheduleCycle(h.deps);

  assert.equal(h.saved[0].fingerprint, "keepme", "otherwise the next real run would look like a change");
  assert.equal(h.saved[0].failures, 1);
});
