import test from "node:test";
import assert from "node:assert/strict";

import {
  BROADCASTABLE,
  DEDUP_WINDOW_SEC,
  GLOBAL_MIN_CONFIDENCE,
  GLOBAL_MIN_STRENGTH,
  PER_TOKEN_COOLDOWN_SEC,
  broadcast,
  eligible,
  gate,
  recipientsOf,
  signalIdentity,
  wantsGlobalAlerts,
} from "../lib/intel/broadcast";
import { runBroadcastCycle } from "../lib/intel/broadcast-cycle";
import type { Signal } from "../lib/intel/signals";
import type { Subscription } from "../lib/store";
import type { DeliveryOutcome } from "../lib/notify";

/**
 * The global alert path.
 *
 * Everything here tests a refusal. Broadcasting is the only thing Veltr does
 * that reaches a person who did not ask a question, so the failure that matters
 * is sending — a missed alert disappoints one user, a spammed one loses all of
 * them.
 */

const signal = (over: Partial<Signal> = {}): Signal => ({
  kind: "volume_spike",
  address: "0xtoken",
  symbol: "TEST",
  title: "VOLUME SPIKE",
  strength: 90,
  confidence: 90,
  facts: ["volume +400% against its own median"],
  at: 1_700_000_000,
  ...over,
});

/* ------------------------------------------------------------ Eligibility */

test("a strong, well-evidenced signal of a broadcastable kind passes", () => {
  assert.equal(eligible(signal()).ok, true);
});

test("low confidence is refused even when the move is huge", () => {
  const weak = eligible(signal({ strength: 100, confidence: GLOBAL_MIN_CONFIDENCE - 1 }));
  assert.equal(weak.ok, false);
});

test("low strength is refused even when confidence is perfect", () => {
  const small = eligible(signal({ strength: GLOBAL_MIN_STRENGTH - 1, confidence: 95 }));
  assert.equal(small.ok, false);
});

test("the global bar sits well above the personal signal default", () => {
  // Personal signals default to 60; anything at that level must not reach everyone.
  assert.ok(GLOBAL_MIN_CONFIDENCE > 60);
  assert.equal(eligible(signal({ confidence: 60 })).ok, false);
});

test("momentum and holder growth are never broadcast", () => {
  assert.ok(!BROADCASTABLE.includes("momentum"));
  assert.ok(!BROADCASTABLE.includes("holder_growth"));
  assert.equal(eligible(signal({ kind: "momentum" })).ok, false);
  assert.equal(eligible(signal({ kind: "holder_growth" })).ok, false);
});

test("a signal with no checkable facts is a claim, and claims are refused", () => {
  assert.equal(eligible(signal({ facts: [] })).ok, false);
});

test("a refusal explains itself", () => {
  const verdict = eligible(signal({ confidence: 10 }));
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.match(verdict.reason, /confidence/);
});

/* --------------------------------------------------------- Deduplication */

test("the same event detected twice has one identity", () => {
  const a = signal({ at: 1_700_000_000 });
  const b = signal({ at: 1_700_000_000 + 60 });
  assert.equal(signalIdentity(a), signalIdentity(b), "a re-detection a minute later is the same event");
});

test("the same signal an hour later is a new event", () => {
  const a = signal({ at: 1_700_000_000 });
  const b = signal({ at: 1_700_000_000 + DEDUP_WINDOW_SEC * 2 });
  assert.notEqual(signalIdentity(a), signalIdentity(b));
});

test("different tokens and kinds never share an identity", () => {
  assert.notEqual(signalIdentity(signal()), signalIdentity(signal({ address: "0xother" })));
  assert.notEqual(signalIdentity(signal()), signalIdentity(signal({ kind: "smart_money" })));
});

test("an already-broadcast event is refused", () => {
  const s = signal();
  const first = gate(s, {}, s.at);
  assert.equal(first.send, true);
  if (!first.send) return;

  const second = gate(s, first.marks, s.at + 60);
  assert.equal(second.send, false, "two workers detecting the same event must not both send");
});

test("a token stays quiet after any alert about it, across kinds", () => {
  const first = gate(signal(), {}, 1_700_000_000);
  assert.equal(first.send, true);
  if (!first.send) return;

  // One event described three ways is still one event.
  const other = gate(
    signal({ kind: "whale_activity", at: 1_700_000_600 }),
    first.marks,
    1_700_000_600
  );
  assert.equal(other.send, false);
  if (!other.send) assert.match(other.reason, /cooling down/);
});

test("a different token is not silenced by another's cooldown", () => {
  const first = gate(signal(), {}, 1_700_000_000);
  assert.equal(first.send, true);
  if (!first.send) return;

  const elsewhere = gate(signal({ address: "0xother" }), first.marks, 1_700_000_600);
  assert.equal(elsewhere.send, true);
});

test("the token speaks again once its cooldown expires", () => {
  const first = gate(signal(), {}, 1_700_000_000);
  assert.equal(first.send, true);
  if (!first.send) return;

  const later = 1_700_000_000 + PER_TOKEN_COOLDOWN_SEC + 1;
  const again = gate(signal({ at: later }), first.marks, later);
  assert.equal(again.send, true);
});

/* ------------------------------------------------------------ Recipients */

const sub = (over: Partial<Subscription> = {}): Subscription => ({
  id: "1",
  address: null,
  channel: "telegram",
  destination: "100",
  minDeltaPct: 0,
  createdAt: "2026-01-01T00:00:00Z",
  ...over,
});

test("an existing subscriber with no preference recorded receives alerts", () => {
  // Absence means on — nobody who subscribed before this feature is excluded.
  assert.equal(wantsGlobalAlerts(sub()), true);
});

test("an explicit opt-out is respected", () => {
  assert.equal(wantsGlobalAlerts(sub({ globalAlerts: false })), false);
});

test("a chat marked unreachable is skipped", () => {
  assert.equal(wantsGlobalAlerts(sub({ undeliverableSince: "2026-01-02T00:00:00Z" })), false);
});

test("recipients are deduplicated by chat id", () => {
  const list = recipientsOf([
    sub({ id: "a", destination: "100" }),
    sub({ id: "b", destination: "100" }),
    sub({ id: "c", destination: "200" }),
    sub({ id: "d", destination: "300", globalAlerts: false }),
  ]);
  assert.deepEqual(list.sort(), ["100", "200"]);
});

/* -------------------------------------------------------------- Delivery */

const ok = (): DeliveryOutcome => ({ ok: true });
const blocked = (): DeliveryOutcome => ({ ok: false, permanent: true, reason: "bot was blocked by the user" });
const throttled = (): DeliveryOutcome => ({
  ok: false,
  permanent: false,
  retryAfterSec: 1,
  reason: "Too Many Requests",
});

const deps = (send: (chatId: string) => Promise<DeliveryOutcome>) => {
  const removed: string[] = [];
  const sleeps: number[] = [];
  return {
    removed,
    sleeps,
    deps: {
      send: async (chatId: string) => send(chatId),
      markUndeliverable: async (chatId: string) => {
        removed.push(chatId);
      },
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    },
  };
};

test("every recipient gets the message", async () => {
  const h = deps(async () => ok());
  const result = await broadcast(["1", "2", "3"], "hello", h.deps);
  assert.equal(result.sent, 3);
  assert.equal(result.attempted, 3);
});

test("a blocked user is recorded once and not retried", async () => {
  const h = deps(async (chatId) => (chatId === "2" ? blocked() : ok()));
  const result = await broadcast(["1", "2", "3"], "hello", h.deps);

  assert.equal(result.sent, 2);
  assert.equal(result.removed, 1);
  assert.deepEqual(h.removed, ["2"]);
  assert.equal(result.failed, 0, "a blocked user is not a failure to retry, it is a user who left");
});

test("a rate limit is waited out and the message retried", async () => {
  let calls = 0;
  const h = deps(async () => {
    calls++;
    return calls === 1 ? throttled() : ok();
  });

  const result = await broadcast(["1"], "hello", h.deps);
  assert.equal(result.sent, 1, "the retry succeeded, so this counts as sent");
  assert.equal(result.throttled, 1);
  assert.ok(h.sleeps.includes(1000), "honoured retry_after rather than pressing on");
});

test("delivery is paced between recipients", async () => {
  const h = deps(async () => ok());
  await broadcast(["1", "2"], "hello", h.deps);
  // One pacing sleep per recipient — going flat out earns a bot-wide 429.
  assert.ok(h.sleeps.length >= 2);
});

/* ----------------------------------------------------------- Full cycle */

const cycleDeps = (over: Partial<Parameters<typeof runBroadcastCycle>[0]> = {}) => {
  const sent: string[] = [];
  let marks: Record<string, number> = {};
  return {
    sent,
    getMarks: () => marks,
    deps: {
      candidateTokens: async () => [{ address: "0xtoken", symbol: "TEST" }],
      evaluate: async () => [signal()],
      loadRecipients: async () => ["100", "200"],
      loadMarks: async () => marks,
      saveMarks: async (next: Record<string, number>) => {
        marks = { ...marks, ...next };
      },
      send: async (chatIds: string[], text: string) => {
        sent.push(text);
        return { sent: chatIds.length, removed: 0 };
      },
      now: () => 1_700_000_000,
      ...over,
    },
  };
};

test("a qualifying signal reaches every recipient once", async () => {
  const h = cycleDeps();
  const report = await runBroadcastCycle(h.deps);

  assert.equal(report.broadcast, 1);
  assert.equal(report.recipients, 2);
  assert.equal(report.sent, 2);
  assert.equal(h.sent.length, 1, "one message, sent to many — not one computation per user");
});

test("the second sweep sends nothing for the same event", async () => {
  const h = cycleDeps();
  await runBroadcastCycle(h.deps);
  const second = await runBroadcastCycle(h.deps);

  assert.equal(second.broadcast, 0);
  assert.equal(h.sent.length, 1);
});

test("marks are written before delivery, so a crash cannot re-send to everyone", async () => {
  const h = cycleDeps({
    send: async () => {
      throw new Error("telegram exploded");
    },
  });

  await assert.rejects(() => runBroadcastCycle(h.deps));
  assert.ok(
    Object.keys(h.getMarks()).length > 0,
    "the event was marked before the send, so a retry cannot duplicate for those already reached"
  );
});

test("a cycle with no candidates does nothing", async () => {
  const h = cycleDeps({ candidateTokens: async () => [] });
  const report = await runBroadcastCycle(h.deps);
  assert.equal(report.broadcast, 0);
  assert.equal(report.candidates, 0);
});

test("ineligible signals are rejected with reasons and nothing is sent", async () => {
  const h = cycleDeps({ evaluate: async () => [signal({ confidence: 20 })] });
  const report = await runBroadcastCycle(h.deps);

  assert.equal(report.signalsFound, 1);
  assert.equal(report.eligible, 0);
  assert.equal(report.broadcast, 0);
  assert.equal(report.rejections.length, 1);
});

test("a provider failure on one token does not stop the sweep", async () => {
  const h = cycleDeps({
    candidateTokens: async () => [
      { address: "0xbad", symbol: "BAD" },
      { address: "0xtoken", symbol: "TEST" },
    ],
    evaluate: async (address: string) => {
      if (address === "0xbad") throw new Error("provider down");
      return [signal()];
    },
  });

  const report = await runBroadcastCycle(h.deps);
  assert.equal(report.broadcast, 1, "the healthy token still produced its alert");
});

test("a burst of signals is capped per cycle", async () => {
  const h = cycleDeps({
    candidateTokens: async () =>
      Array.from({ length: 10 }, (_, i) => ({ address: `0xt${i}`, symbol: `T${i}` })),
    evaluate: async (address: string) => [signal({ address })],
  });

  const report = await runBroadcastCycle(h.deps);
  assert.ok(report.eligible >= 10);
  assert.ok(report.broadcast <= 2, `a market-wide move must not send ten alerts, sent ${report.broadcast}`);
});
