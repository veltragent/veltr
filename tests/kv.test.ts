import test from "node:test";
import assert from "node:assert/strict";

import { kvAvailable, kvGet, kvSet, kvDel, kvIncr, kvAcquire, kvPing, resetLocalKv } from "../lib/kv";

/**
 * The shared store, exercised through its fallback.
 *
 * No credentials are set here, so every call takes the in-memory path — which is
 * exactly the behaviour a single instance gets, and therefore the behaviour that
 * must keep working when Redis is absent or unreachable.
 */

delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

test("without credentials the store reports itself unavailable", () => {
  assert.equal(kvAvailable(), false);
  // Nothing should pretend a round trip happened.
  assert.equal(kvPing() instanceof Promise, true);
});

test("values round-trip through the local fallback", async () => {
  resetLocalKv();
  await kvSet("a", "hello", 60_000);
  assert.equal(await kvGet("a"), "hello");
  await kvDel("a");
  assert.equal(await kvGet("a"), null);
});

test("a value past its ttl reads as absent", async () => {
  resetLocalKv();
  await kvSet("b", "x", -1);
  assert.equal(await kvGet("b"), null);
});

test("counters increment and keep their original window", async () => {
  resetLocalKv();
  assert.equal(await kvIncr("hits", 60_000), 1);
  assert.equal(await kvIncr("hits", 60_000), 2);
  assert.equal(await kvIncr("hits", 60_000), 3);
});

test("an expired counter starts again rather than sliding forever", async () => {
  resetLocalKv();
  assert.equal(await kvIncr("window", -1), 1);
  assert.equal(await kvIncr("window", -1), 1, "a fresh window, not a running total");
});

test("lease operations report unavailable rather than guessing", async () => {
  // Returning false would read as "someone else holds it" and stand the
  // scheduler down for a reason that does not exist. Null means "ask elsewhere".
  assert.equal(await kvAcquire("lease", "A", 1000), null);
});

test("ping is null when there is nothing to ping", async () => {
  assert.equal(await kvPing(), null);
});
