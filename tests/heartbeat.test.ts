import test from "node:test";
import assert from "node:assert/strict";

import { beat, stalledLoops, watchLoopHealth, BEACON_TTL_MS } from "../lib/heartbeat";

/**
 * Knowing the agent stopped.
 *
 * The failure being caught is not a crash — a crash is visible. It is a single
 * loop ending while the process stays up and keeps answering, so every external
 * check reports a healthy service that has silently stopped alerting anyone.
 */

const MINUTE = 60_000;

test("a loop reporting on time is not stalled", () => {
  const now = Date.now();
  beat("telegram", now);
  assert.deepEqual(stalledLoops(now), []);
});

test("a loop that stopped reporting is caught", () => {
  const now = Date.now();
  beat("telegram", now - 6 * MINUTE);
  const stalled = stalledLoops(now);

  assert.equal(stalled.length, 1);
  assert.equal(stalled[0].loop, "telegram");
  assert.ok(stalled[0].silentForMs > stalled[0].toleranceMs);
});

test("a slow pass is not an alarm", () => {
  // A loop running behind is ordinary; the tolerances are multiples of each
  // loop's period so one long provider call never wakes anybody.
  const now = Date.now();
  beat("telegram", now - 2 * MINUTE);
  beat("tracks", now - 15 * MINUTE);
  beat("backups", now - 45 * MINUTE);
  assert.deepEqual(stalledLoops(now), []);
});

test("each loop is judged against its own period", () => {
  // Twenty minutes is dead for the telegram poll and perfectly normal for
  // backups, which run every thirty.
  const now = Date.now();
  beat("telegram", now - 20 * MINUTE);
  beat("backups", now - 20 * MINUTE);

  const names = stalledLoops(now).map((s) => s.loop);
  assert.deepEqual(names, ["telegram"]);
});

test("a loop that never started is not reported as stopped", () => {
  // Otherwise every deployment with a feature switched off alarms on boot.
  const now = Date.now();
  const before = stalledLoops(now).map((s) => s.loop);
  assert.ok(!before.includes("schedules"), "not watched until it starts");

  watchLoopHealth("schedules");
  assert.deepEqual(stalledLoops(now).map((s) => s.loop).includes("schedules"), false, "and starting it is itself a beat");
});

test("the beacon outlives one missed tick but not a death", () => {
  // Written every 60s: a single slow tick or brief store outage must not read
  // as a dead process, and a dead process must not look alive for long.
  assert.ok(BEACON_TTL_MS > 60_000, "one missed tick is survivable");
  assert.ok(BEACON_TTL_MS <= 5 * MINUTE, "a death is noticed quickly");
});
