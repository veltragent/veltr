import test from "node:test";
import assert from "node:assert/strict";

import { census, describeCensus, isEmpty, wouldLoseData, type Census } from "../lib/backup";

/**
 * Off-host copies of the state document.
 *
 * The property under test is not "a copy was written" — it is that a copy is
 * *refused* when writing it would destroy the only remaining record of every
 * user. A backup that faithfully mirrors an empty volume is worse than none.
 */

function c(overrides: Partial<Census> = {}): Census {
  return {
    subscriptions: 10,
    tokenWatches: 8,
    schedules: 2,
    missions: 40,
    tracks: 3,
    hasOwner: true,
    ...overrides,
  };
}

const nothing: Census = {
  subscriptions: 0,
  tokenWatches: 0,
  schedules: 0,
  missions: 0,
  tracks: 0,
  hasOwner: false,
};

test("emptiness is judged on what someone would miss", () => {
  assert.equal(isEmpty(nothing), true);
  assert.equal(isEmpty(c()), false);
  // Missions are logs of past work; losing them is not losing the population.
  assert.equal(isEmpty({ ...nothing, missions: 500 }), true);
  assert.equal(isEmpty({ ...nothing, hasOwner: true }), false);
});

test("a wiped volume is never allowed to overwrite the copy of everyone", () => {
  // The whole reason this file exists: boot against an empty disk, snapshot what
  // you see, and a recoverable incident becomes a permanent one.
  assert.equal(wouldLoseData(c(), nothing), true);
});

test("losing most of the population is refused, not called churn", () => {
  assert.equal(wouldLoseData(c({ subscriptions: 100, tokenWatches: 0, tracks: 0 }), c({ subscriptions: 20, tokenWatches: 0, tracks: 0 })), true);
});

test("ordinary churn and growth are allowed", () => {
  assert.equal(wouldLoseData(c(), c({ subscriptions: 11 })), false);
  assert.equal(wouldLoseData(c(), c({ subscriptions: 9 })), false, "one person left");
  assert.equal(wouldLoseData(c({ subscriptions: 10, tokenWatches: 8, tracks: 3 }), c({ subscriptions: 8, tokenWatches: 8, tracks: 3 })), false);
});

test("the first backup is never refused", () => {
  assert.equal(wouldLoseData(null, c()), false);
  assert.equal(wouldLoseData(null, nothing), false, "a genuinely new install must be able to start");
});

test("a backup of nothing over nothing is not a loss", () => {
  assert.equal(wouldLoseData(nothing, nothing), false);
});

test("counting reads the fields that matter and tolerates their absence", () => {
  const counted = census({ subscriptions: [{ id: "1" }] } as never);
  assert.equal(counted.subscriptions, 1);
  assert.equal(counted.tokenWatches, 0, "an older state document has no such field");
  assert.equal(counted.hasOwner, false);
});

test("a census reads as a sentence", () => {
  assert.match(describeCensus(c({ subscriptions: 1, tokenWatches: 1, schedules: 1, tracks: 1 })), /1 subscriber, 1 watch, 1 schedule, 1 track/);
  assert.match(describeCensus(c()), /10 subscribers, 8 watches, 2 schedules, 3 tracks/);
});
