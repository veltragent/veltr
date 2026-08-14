import test from "node:test";
import assert from "node:assert/strict";

import { getJson, resetBudgets, budgetSnapshot, chunk } from "../lib/watch/http";
import { stubFetch } from "./helpers";

/**
 * Transport behaviour under failure.
 *
 * The contract every provider depends on: never throw, never retry something a
 * retry cannot fix, and never keep hammering an endpoint that has just asked to
 * be left alone.
 */

test("a 429 returns null and puts the provider to sleep for the whole process", async () => {
  resetBudgets();
  const { impl, calls } = stubFetch(() => ({ status: 429, headers: { "retry-after": "30" } }));

  const first = await getJson("GECKOTERMINAL", "https://example.test/a", { fetchImpl: impl });
  assert.equal(first, null);
  assert.equal(calls.length, 1, "a 429 must not be retried immediately");

  const cooling = budgetSnapshot().GECKOTERMINAL.coolingForMs;
  assert.ok(cooling > 25_000 && cooling <= 30_000, "Retry-After is honoured");

  // A second call while cooling must not reach the network at all.
  const second = await getJson("GECKOTERMINAL", "https://example.test/b", { fetchImpl: impl });
  assert.equal(second, null);
  assert.equal(calls.length, 1, "the cooldown protects the shared IP budget, not just one call");

  resetBudgets();
});

test("a 429 with no Retry-After still backs off", async () => {
  resetBudgets();
  const { impl } = stubFetch(() => ({ status: 429 }));
  await getJson("DEXSCREENER", "https://example.test/a", { fetchImpl: impl });
  assert.ok(budgetSnapshot().DEXSCREENER.coolingForMs > 0);
  resetBudgets();
});

test("a timeout is swallowed and retried once", async () => {
  resetBudgets();
  let attempts = 0;
  const impl = (async () => {
    attempts++;
    const error = new Error("The operation was aborted due to timeout");
    error.name = "TimeoutError";
    throw error;
  }) as unknown as typeof fetch;

  const result = await getJson("DEXSCREENER", "https://example.test/a", { fetchImpl: impl });

  assert.equal(result, null, "a timeout is missing data, not an exception for the caller");
  assert.equal(attempts, 2, "one retry, then give up");
  resetBudgets();
});

test("a 500 is retried but a 404 is not", async () => {
  resetBudgets();
  const server = stubFetch(() => ({ status: 500 }));
  await getJson("DEXSCREENER", "https://example.test/a", { fetchImpl: server.impl });
  assert.equal(server.calls.length, 2, "a server error may be transient");

  const missing = stubFetch(() => ({ status: 404 }));
  await getJson("DEXSCREENER", "https://example.test/b", { fetchImpl: missing.impl });
  assert.equal(missing.calls.length, 1, "retrying a 404 cannot change the answer");
  resetBudgets();
});

test("the local budget stops runaway request volume", async () => {
  resetBudgets();
  const { impl, calls } = stubFetch(() => ({ body: {} }));

  // GeckoTerminal's local ceiling is 20/minute; the 21st must not go out.
  for (let i = 0; i < 25; i++) {
    await getJson("GECKOTERMINAL", `https://example.test/${i}`, { fetchImpl: impl });
  }

  assert.equal(calls.length, 20);
  resetBudgets();
});

test("malformed JSON does not escape as an exception", async () => {
  resetBudgets();
  const impl = (async () =>
    ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
    }) as unknown as Response) as unknown as typeof fetch;

  const result = await getJson("DEXSCREENER", "https://example.test/a", { fetchImpl: impl, retries: 0 });
  assert.equal(result, null);
  resetBudgets();
});

test("chunk splits evenly and keeps the remainder", () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 30), []);
});
