import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Persistence, against a real file on disk.
 *
 * The store resolves its path from the working directory at import time, so the
 * process moves to a temporary directory *before* the module is loaded. Node's
 * test runner gives each file its own process, so this cannot affect another
 * test — and it means these assertions never go near the real watcher state.
 */

const sandbox = mkdtempSync(join(tmpdir(), "veltr-watch-"));
mkdirSync(join(sandbox, "data"), { recursive: true });
process.chdir(sandbox);

const STATE_FILE = join(sandbox, "data", "watcher-state.json");

/**
 * A state file written before this feature existed.
 *
 * Loading it is the backward-compatibility test: the corporate-action watcher's
 * fields must survive untouched and the new ones must appear as empty.
 */
const LEGACY_STATE = {
  lastMultiplier: { "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec": 1 },
  lastPending: { "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec": null },
  seenActionIds: ["action-1"],
  changes: [],
  subscriptions: [
    { id: "sub-1", address: null, channel: "telegram", destination: "111", minDeltaPct: 0, createdAt: "2026-01-01T00:00:00.000Z" },
  ],
  lastRunAt: "2026-08-14T11:41:19.902Z",
  lastBlock: "36224302",
  lastTelegramUpdateId: 348752870,
  lastBriefSentOn: "2026-08-13",
};

writeFileSync(STATE_FILE, JSON.stringify(LEGACY_STATE, null, 2), "utf8");

const { readState } = await import("../lib/store");
const store = await import("../lib/watch/store");
const { DEFAULT_SETTINGS } = await import("../lib/watch/settings");

const TOKEN = "0x2e8c31162b855a2ffa90f6f8634643ad6f111e18";

test("a state file written before this feature loads with the new fields empty", async () => {
  const state = await readState();

  assert.equal(state.lastBlock, "36224302", "existing watcher state is untouched");
  assert.equal(state.subscriptions.length, 1);
  assert.deepEqual(state.seenActionIds, ["action-1"]);
  assert.deepEqual(state.tokenWatches, [], "a missing field defaults rather than failing the read");
  assert.deepEqual(state.watchSettings, {});
});

test("a watch round-trips to disk and back", async () => {
  const added = await store.addWatch({
    userId: "111",
    tokenAddress: TOKEN.toUpperCase().replace("0X", "0x"),
    symbol: "AI",
    name: "Artificial Inu",
    pairAddress: "0xcbdf",
    price: 0.0117,
    marketCap: 11_670_071,
    liquidity: 1_013_544,
    volume24h: 2_510_865,
  });

  assert.equal(added.ok, true);

  const onDisk = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  assert.equal(onDisk.tokenWatches.length, 1);
  assert.equal(onDisk.tokenWatches[0].tokenAddress, TOKEN, "addresses are normalised to lower case");
  assert.equal(onDisk.tokenWatches[0].baselinePrice, 0.0117);
  assert.equal(onDisk.lastBlock, "36224302", "the corporate-action watcher's state survived the write");
  assert.equal(onDisk.subscriptions.length, 1);
});

test("settings persist per user and never leak between users", async () => {
  await store.updateSettings("111", { priceUpPct: 5, priceDownPct: 5, marketCapAbove: 1_000_000 });
  await store.updateSettings("222", { priceUpPct: 20, priceDownPct: 15 });

  const a = await store.getSettings("111");
  const b = await store.getSettings("222");

  assert.equal(a.priceUpPct, 5);
  assert.equal(a.marketCapAbove, 1_000_000);
  assert.equal(b.priceUpPct, 20);
  assert.equal(b.marketCapAbove, null, "user B never set this and must not inherit it");

  const fresh = await store.getSettings("333");
  assert.deepEqual(fresh, DEFAULT_SETTINGS, "an unknown user gets defaults, not someone else's");
});

test("a watchlist read is scoped to its owner", async () => {
  await store.addWatch({
    userId: "222",
    tokenAddress: "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec",
    symbol: "NVDA",
    name: "NVIDIA",
    pairAddress: null,
    price: 226,
    marketCap: 4_033_915,
    liquidity: 1_885_089,
    volume24h: 8_641_810,
  });

  const mine = await store.listWatches("111");
  const theirs = await store.listWatches("222");

  assert.deepEqual(mine.map((w) => w.symbol), ["AI"]);
  assert.deepEqual(theirs.map((w) => w.symbol), ["NVDA"]);

  assert.equal(await store.findWatch("111", "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec"), null);
});

test("one user cannot remove another user's watch", async () => {
  const removed = await store.removeWatch("111", "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec");
  assert.equal(removed, null, "the address exists, but not on this user's list");

  const stillThere = await store.listWatches("222");
  assert.equal(stillThere.length, 1);
});

test("the watchlist survives a restart", async () => {
  // A distinct specifier gives a fresh module instance with an empty memo, which
  // is what a restarted process has: everything must come back off the disk.
  // Held in a variable so the query string is a runtime concern — a literal would
  // be a module path tsc then tries, and fails, to resolve.
  const freshCopy = "../lib/watch/store.ts?restart=1";
  const restarted: typeof store = await import(freshCopy);

  const watches = await restarted.listWatches("111");
  assert.equal(watches.length, 1);
  assert.equal(watches[0].symbol, "AI");
  assert.equal(watches[0].baselinePrice, 0.0117);

  const settings = await restarted.getSettings("111");
  assert.equal(settings.priceUpPct, 5, "settings survive too");
});

test("re-watching rebases the baseline and clears the alert history", async () => {
  const again = await store.addWatch({
    userId: "111",
    tokenAddress: TOKEN,
    symbol: "AI",
    name: "Artificial Inu",
    pairAddress: "0xcbdf",
    price: 0.02,
    marketCap: 20_000_000,
    liquidity: 1_500_000,
    volume24h: 3_000_000,
  });

  assert.equal(again.ok && again.alreadyWatched, true, "the same token is not added twice");
  assert.equal(again.ok && again.watch.baselinePrice, 0.02);
  assert.equal(again.ok && again.watch.lastAlertAt, null);

  const watches = await store.listWatches("111");
  assert.equal(watches.length, 1);
});

test("concurrent mutations do not lose each other", async () => {
  // Read-modify-write against one document: without serialisation the later
  // write would be built on a state read before the earlier one landed.
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      store.addWatch({
        userId: `bulk-${i}`,
        tokenAddress: TOKEN,
        symbol: "AI",
        name: "Artificial Inu",
        pairAddress: null,
        price: 1,
        marketCap: null,
        liquidity: null,
        volume24h: null,
      })
    )
  );

  const all = await store.listAllWatches();
  const bulk = all.filter((w) => w.userId.startsWith("bulk-"));
  assert.equal(bulk.length, 8, "every concurrent add is present");
});

test("removing a user's watches leaves everyone else's alone", async () => {
  const before = (await store.listAllWatches()).length;
  const dropped = await store.removeAllWatches("111");

  assert.equal(dropped, 1);
  assert.equal((await store.listWatches("111")).length, 0);
  assert.equal((await store.listAllWatches()).length, before - 1);
  assert.equal((await store.listWatches("222")).length, 1, "another user's list is untouched");
});

test("changing a setting re-arms that user's watches without touching others", async () => {
  await store.updateSettings("222", { marketCapAbove: 1_000_000 });

  const theirs = await store.listWatches("222");
  assert.equal(
    theirs[0].armed.marketCapAbove,
    false,
    "NVDA already sits above $1M, so the threshold starts disarmed rather than firing"
  );

  const settings = await store.getSettings("111");
  assert.equal(settings.marketCapAbove, 1_000_000, "user 111 set this earlier and still has it");
});
