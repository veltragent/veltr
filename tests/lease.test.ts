import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The single-writer lease.
 *
 * This exists because two instances were once running here at the same time and
 * Telegram answered with "Conflict: terminated by other getUpdates request".
 * The property under test is simply that two holders cannot both win.
 */

const sandbox = mkdtempSync(join(tmpdir(), "veltr-lease-"));
mkdirSync(join(sandbox, "data"), { recursive: true });
process.chdir(sandbox);

writeFileSync(
  join(sandbox, "data", "watcher-state.json"),
  JSON.stringify({
    lastMultiplier: {},
    lastPending: {},
    seenActionIds: [],
    changes: [],
    subscriptions: [{ id: "a", address: null, channel: "telegram", destination: "111", minDeltaPct: 0, createdAt: "2026-01-01T00:00:00.000Z" }],
    lastRunAt: null,
    lastBlock: null,
    lastTelegramUpdateId: 42,
    lastBriefSentOn: null,
  }),
  "utf8"
);

const { acquireLease, renewLease, releaseLease, leaseHolder, LEASE_TTL_MS } = await import("../lib/lease");
const { readState } = await import("../lib/store");

const T0 = new Date("2026-08-15T12:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

test("a free lease is granted", async () => {
  assert.equal(await acquireLease("scheduler", { holder: "A", now: T0 }), true);
  assert.equal((await leaseHolder("scheduler"))?.holder, "A");
});

test("a held lease is refused to everyone else", async () => {
  assert.equal(await acquireLease("scheduler", { holder: "B", now: at(1_000) }), false);
  assert.equal((await leaseHolder("scheduler"))?.holder, "A", "the holder is unchanged");
});

test("the holder may re-acquire its own lease", async () => {
  assert.equal(await acquireLease("scheduler", { holder: "A", now: at(2_000) }), true);
});

test("an expired lease is available again", async () => {
  const afterExpiry = at(LEASE_TTL_MS + 5_000);
  assert.equal(await acquireLease("scheduler", { holder: "B", now: afterExpiry }), true);
  assert.equal((await leaseHolder("scheduler"))?.holder, "B", "a crashed holder does not block forever");
});

test("the previous holder cannot renew a lease it lost", async () => {
  const now = at(LEASE_TTL_MS + 6_000);
  assert.equal(await renewLease("scheduler", { holder: "A", now }), false);
  assert.equal((await leaseHolder("scheduler"))?.holder, "B");
});

test("renewing extends the expiry", async () => {
  const now = at(LEASE_TTL_MS + 7_000);
  assert.equal(await renewLease("scheduler", { holder: "B", now }), true);

  const lease = await leaseHolder("scheduler");
  assert.equal(new Date(lease!.expiresAt).getTime(), now.getTime() + LEASE_TTL_MS);
});

test("releasing frees it immediately, without waiting out the TTL", async () => {
  await releaseLease("scheduler", "B");
  assert.equal(await leaseHolder("scheduler"), null);
  assert.equal(await acquireLease("scheduler", { holder: "C", now: at(8_000) }), true);
});

test("releasing someone else's lease does nothing", async () => {
  await releaseLease("scheduler", "not-the-holder");
  assert.equal((await leaseHolder("scheduler"))?.holder, "C", "a stale shutdown hook must not evict the live holder");
});

test("two simultaneous claims produce exactly one winner", async () => {
  await releaseLease("scheduler", "C");

  // The whole point: the read and the write are one queued mutation, so the
  // loser sees the winner's write rather than an empty slot.
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) => acquireLease("race", { holder: `I${i}`, now: at(9_000) }))
  );

  assert.equal(results.filter(Boolean).length, 1, `expected one winner, got ${results.filter(Boolean).length}`);
});

test("leases are independent of each other", async () => {
  assert.equal(await acquireLease("other", { holder: "X", now: at(10_000) }), true);
  assert.equal((await leaseHolder("race"))?.holder?.startsWith("I"), true);
});

test("the rest of the document survives lease writes", async () => {
  const state = await readState();
  assert.equal(state.lastTelegramUpdateId, 42);
  assert.equal(state.subscriptions.length, 1);
});
