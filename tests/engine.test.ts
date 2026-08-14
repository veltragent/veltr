import test from "node:test";
import assert from "node:assert/strict";

import { runWatchCycle, isDue, type EngineDeps } from "../lib/watch/engine";
import type { SourceReadings } from "../lib/watch/aggregate";
import { emptyMarketData, type TokenMarketData, type TokenWatch, type WatchSettings } from "../lib/watch/types";
import { makeSettings, makeWatch, TOKEN_A, TOKEN_B } from "./helpers";

/**
 * The monitoring cycle end to end, with the network, the state file and Telegram
 * all replaced. What is being proved is the arithmetic of scale: how many market
 * reads a set of watches costs, and who receives what.
 */

type Harness = {
  deps: Partial<EngineDeps>;
  sent: { userId: string; text: string }[];
  fetches: string[][];
  persisted: TokenWatch[];
  watches: TokenWatch[];
};

function harness(options: {
  watches: TokenWatch[];
  settings: Record<string, WatchSettings>;
  prices: Record<string, Partial<TokenMarketData>>;
  now?: Date;
}): Harness {
  const state = { watches: options.watches };
  const sent: { userId: string; text: string }[] = [];
  const fetches: string[][] = [];
  let persisted: TokenWatch[] = [];

  const deps: Partial<EngineDeps> = {
    loadWatches: async () => state.watches,
    loadSettings: async (userIds) =>
      new Map(userIds.map((id) => [id, options.settings[id] ?? makeSettings()])),
    fetchReadings: async (addresses) => {
      fetches.push([...addresses]);
      const readings: SourceReadings = { dexscreener: new Map(), geckoterminal: new Map() };
      for (const address of addresses) {
        const price = options.prices[address.toLowerCase()];
        if (!price) continue;
        readings.dexscreener.set(address.toLowerCase(), {
          ...emptyMarketData(address, "dexscreener"),
          ...price,
        });
      }
      return readings;
    },
    persist: async (updated) => {
      persisted = updated;
      const byId = new Map(updated.map((w) => [w.id, w]));
      state.watches = state.watches.map((w) => byId.get(w.id) ?? w);
    },
    send: async (userId, text) => {
      sent.push({ userId, text });
      return true;
    },
    now: () => options.now ?? new Date("2026-08-14T01:00:00.000Z"),
  };

  return {
    deps,
    sent,
    fetches,
    get persisted() {
      return persisted;
    },
    get watches() {
      return state.watches;
    },
  } as Harness;
}

test("a hundred users watching one token costs one market read", async () => {
  const watches = Array.from({ length: 100 }, (_, i) =>
    makeWatch({ id: `w${i}`, userId: `user-${i}`, lastCheckedAt: null })
  );
  const settings = Object.fromEntries(watches.map((w) => [w.userId, makeSettings()]));

  const h = harness({ watches, settings, prices: { [TOKEN_A]: { priceUsd: 1 } } });
  const report = await runWatchCycle(h.deps);

  assert.equal(report.due, 100);
  assert.equal(report.tokensFetched, 1, "the reading is a property of the token, not the watcher");
  assert.deepEqual(h.fetches, [[TOKEN_A]]);
});

test("distinct tokens are deduplicated across users", async () => {
  const watches = [
    makeWatch({ id: "a", userId: "1", tokenAddress: TOKEN_A }),
    makeWatch({ id: "b", userId: "2", tokenAddress: TOKEN_A }),
    makeWatch({ id: "c", userId: "2", tokenAddress: TOKEN_B }),
  ];

  const h = harness({
    watches,
    settings: { "1": makeSettings(), "2": makeSettings() },
    prices: { [TOKEN_A]: { priceUsd: 1 }, [TOKEN_B]: { priceUsd: 2 } },
  });

  await runWatchCycle(h.deps);
  assert.deepEqual(h.fetches[0].sort(), [TOKEN_A, TOKEN_B].sort());
});

test("two users watching the same token get their own thresholds", async () => {
  // Same 12% move. User A alerts at +5%, user B at +20% and so hears nothing.
  const watches = [
    makeWatch({ id: "a", userId: "A", baselinePrice: 1 }),
    makeWatch({ id: "b", userId: "B", baselinePrice: 1 }),
  ];

  const h = harness({
    watches,
    settings: {
      A: makeSettings({ priceUpPct: 5, priceDownPct: 5 }),
      B: makeSettings({ priceUpPct: 20, priceDownPct: 15 }),
    },
    prices: { [TOKEN_A]: { priceUsd: 1.12, symbol: "AI" } },
  });

  const report = await runWatchCycle(h.deps);

  assert.equal(report.alerts, 1);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].userId, "A");
  assert.ok(h.sent[0].text.includes("PRICE ALERT"));
});

test("one user's watch never produces another user's alert", async () => {
  const watches = [
    makeWatch({ id: "a", userId: "A", tokenAddress: TOKEN_A, baselinePrice: 1 }),
    makeWatch({ id: "b", userId: "B", tokenAddress: TOKEN_B, baselinePrice: 1, symbol: "NVDA" }),
  ];

  const h = harness({
    watches,
    settings: { A: makeSettings(), B: makeSettings() },
    prices: { [TOKEN_A]: { priceUsd: 1.5, symbol: "AI" }, [TOKEN_B]: { priceUsd: 1.0 } },
  });

  await runWatchCycle(h.deps);

  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].userId, "A");
  assert.ok(!h.sent[0].text.includes("NVDA"));
});

test("a token with no reading is left untouched for the next cycle", async () => {
  const watch = makeWatch({ lastCheckedAt: "2026-08-14T00:00:00.000Z", lastPrice: 1 });
  const h = harness({ watches: [watch], settings: {}, prices: {} });

  const report = await runWatchCycle(h.deps);

  assert.equal(report.unresolved, 1);
  assert.equal(report.alerts, 0);
  assert.deepEqual(h.persisted, [], "an outage must not be recorded as a checked, priced pass");
  assert.equal(h.watches[0].lastCheckedAt, "2026-08-14T00:00:00.000Z");
});

test("a null price never reads as a crash to zero", async () => {
  const watch = makeWatch({ baselinePrice: 1, lastPrice: 1 });
  const h = harness({
    watches: [watch],
    settings: {},
    prices: { [TOKEN_A]: { priceUsd: null, marketCap: null } },
  });

  const report = await runWatchCycle(h.deps);

  assert.equal(report.alerts, 0, "a −100% alert from missing data would be a false alarm");
  assert.equal(report.unresolved, 1);
});

test("only watches whose interval has elapsed are fetched", async () => {
  const now = new Date("2026-08-14T01:00:00.000Z");
  const recent = makeWatch({
    id: "recent",
    userId: "slow",
    tokenAddress: TOKEN_B,
    lastCheckedAt: "2026-08-14T00:59:50.000Z",
  });
  const stale = makeWatch({
    id: "stale",
    userId: "fast",
    tokenAddress: TOKEN_A,
    lastCheckedAt: "2026-08-14T00:50:00.000Z",
  });

  const h = harness({
    watches: [recent, stale],
    settings: { slow: makeSettings({ checkIntervalSec: 900 }), fast: makeSettings({ checkIntervalSec: 30 }) },
    prices: { [TOKEN_A]: { priceUsd: 1 }, [TOKEN_B]: { priceUsd: 1 } },
    now,
  });

  const report = await runWatchCycle(h.deps);

  assert.equal(report.due, 1);
  assert.deepEqual(h.fetches, [[TOKEN_A]], "a 15-minute interval costs nothing on a 15-second tick");
});

test("a paused watch is never evaluated", async () => {
  const h = harness({
    watches: [makeWatch({ enabled: false, lastCheckedAt: null })],
    settings: {},
    prices: { [TOKEN_A]: { priceUsd: 99 } },
  });

  const report = await runWatchCycle(h.deps);
  assert.equal(report.due, 0);
  assert.equal(h.fetches.length, 0);
});

test("an empty watchlist makes no provider calls at all", async () => {
  const h = harness({ watches: [], settings: {}, prices: {} });
  const report = await runWatchCycle(h.deps);
  assert.equal(report.due, 0);
  assert.equal(h.fetches.length, 0);
});

test("a provider disabled by one user does not stop another user's fetch", async () => {
  const watches = [
    makeWatch({ id: "a", userId: "A" }),
    makeWatch({ id: "b", userId: "B" }),
  ];

  let requestedSources: unknown = null;
  const h = harness({
    watches,
    settings: {
      A: makeSettings({ useDexScreener: false }),
      B: makeSettings({ useDexScreener: true }),
    },
    prices: { [TOKEN_A]: { priceUsd: 1 } },
  });

  const report = await runWatchCycle({
    ...h.deps,
    fetchReadings: async (addresses, sources) => {
      requestedSources = sources;
      return h.deps.fetchReadings!(addresses, sources);
    },
  });

  assert.deepEqual(requestedSources, { useDexScreener: true, useGeckoTerminal: true });
  assert.equal(report.tokensFetched, 1);
});

test("state advanced by a cycle is persisted for the next one", async () => {
  const h = harness({
    watches: [makeWatch({ baselinePrice: 1, lastPrice: 1, lastCheckedAt: null })],
    settings: {},
    prices: { [TOKEN_A]: { priceUsd: 1.5, marketCap: 2_000_000 } },
  });

  await runWatchCycle(h.deps);

  assert.equal(h.persisted.length, 1);
  assert.equal(h.persisted[0].lastPrice, 1.5);
  assert.equal(h.persisted[0].lastMarketCap, 2_000_000);
  assert.equal(h.persisted[0].lastCheckedAt, "2026-08-14T01:00:00.000Z");
});

test("isDue treats a backwards clock as due rather than parking the watch", () => {
  const future = makeWatch({ lastCheckedAt: "2027-01-01T00:00:00.000Z" });
  assert.equal(isDue(future, makeSettings(), new Date("2026-08-14T00:00:00.000Z")), true);
});

test("a watch that has never been checked is due immediately", () => {
  assert.equal(isDue(makeWatch({ lastCheckedAt: null }), makeSettings(), new Date()), true);
});
