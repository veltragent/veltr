import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Mission persistence against a real file.
 *
 * The load-bearing claim is that a mission waiting for approval survives a
 * restart: the answer can arrive hours later and in a different process, and a
 * mission that forgot it was waiting would strand the person who was asked.
 *
 * The process moves to a temporary directory before the store is imported, so
 * these assertions never touch the real state file.
 */

const sandbox = mkdtempSync(join(tmpdir(), "veltr-agent-"));
mkdirSync(join(sandbox, "data"), { recursive: true });
process.chdir(sandbox);

const STATE_FILE = join(sandbox, "data", "watcher-state.json");

/** A state file predating both the token watcher and the agent. */
writeFileSync(
  STATE_FILE,
  JSON.stringify({
    lastMultiplier: { "0xabc": 1 },
    lastPending: {},
    seenActionIds: [],
    changes: [],
    subscriptions: [{ id: "s1", address: null, channel: "telegram", destination: "111", minDeltaPct: 0, createdAt: "2026-01-01T00:00:00.000Z" }],
    lastRunAt: "2026-08-14T11:41:19.902Z",
    lastBlock: "36224302",
    lastTelegramUpdateId: 1,
    lastBriefSentOn: "2026-08-13",
  }),
  "utf8"
);

const { readState } = await import("../lib/store");
const store = await import("../lib/agent/store");
const { createMission, transition } = await import("../lib/agent/mission");
const { LIMITS } = await import("../lib/agent/budget");
import type { Mission } from "../lib/agent/types";

function mission(overrides: Partial<Mission> = {}): Mission {
  return {
    ...createMission({ ownerId: "111", objective: "investigate why NVDA is moving" }),
    ...overrides,
  };
}

test("a state file predating the agent loads with no missions", async () => {
  const state = await readState();

  assert.equal(state.lastBlock, "36224302", "existing state is untouched");
  assert.equal(state.subscriptions.length, 1);
  assert.deepEqual(state.missions, [], "a missing field defaults rather than failing the read");
});

test("a mission round-trips to disk", async () => {
  const saved = await store.saveMission(mission({ id: "11111111-1111-4111-8111-111111111111" }));
  assert.equal(saved.id, "11111111-1111-4111-8111-111111111111");

  const onDisk = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  assert.equal(onDisk.missions.length, 1);
  assert.equal(onDisk.missions[0].objective, "investigate why NVDA is moving");
  assert.equal(onDisk.lastBlock, "36224302", "the watcher's own state survived the write");
  assert.equal(onDisk.subscriptions.length, 1);
});

test("a mission waiting for approval survives a restart", async () => {
  const waiting = transition(
    { ...mission({ id: "22222222-2222-4222-8222-222222222222" }), state: "running" },
    "waiting_permission",
    "Approval needed: defend_position.",
    new Date()
  );

  await store.saveMission({
    ...waiting,
    pendingAction: { tool: "defend_position", args: { tokenId: "42" }, risk: "high", rationale: "split incoming" },
  });

  // A distinct specifier gives a module instance with an empty memo — what a
  // restarted process has. Everything must come back off the disk.
  const freshCopy = "../lib/agent/store.ts?restart=1";
  const restarted: typeof store = await import(freshCopy);

  const recovered = await restarted.getMission("111", "22222222-2222-4222-8222-222222222222");
  assert.equal(recovered?.state, "waiting_permission");
  assert.equal(recovered?.pendingAction?.tool, "defend_position");
  assert.equal(recovered?.pendingAction?.risk, "high");

  const pending = await restarted.pendingApprovals("111");
  assert.equal(pending.length, 1, "the outstanding question is still findable after a restart");
});

test("a mission is only reachable by its owner", async () => {
  await store.saveMission(mission({ id: "33333333-3333-4333-8333-333333333333", ownerId: "222" }));

  assert.equal(await store.getMission("111", "33333333-3333-4333-8333-333333333333"), null);
  assert.ok(await store.getMission("222", "33333333-3333-4333-8333-333333333333"));

  const mine = await store.listMissions("111");
  assert.ok(mine.every((m) => m.ownerId === "111"));
});

test("one owner cannot delete another owner's mission", async () => {
  assert.equal(await store.removeMission("111", "33333333-3333-4333-8333-333333333333"), false);
  assert.ok(await store.getMission("222", "33333333-3333-4333-8333-333333333333"));
});

test("a finished mission is compacted to its cited evidence", async () => {
  const finished: Mission = {
    ...mission({ id: "44444444-4444-4444-8444-444444444444" }),
    state: "completed",
    evidence: Array.from({ length: 20 }, (_, i) => ({
      id: `e${i + 1}`,
      tool: "get_price",
      args: {},
      ok: true,
      summary: "x".repeat(500),
      urls: [],
      at: "2026-08-14T00:00:00.000Z",
    })),
    result: { summary: "done", evidenceIds: ["e3"], confidence: null, actionsTaken: [] },
  };

  const saved = await store.saveMission(finished);

  assert.deepEqual(saved.evidence.map((e) => e.id), ["e3"], "only what the result rests on is kept");
});

test("an unfinished mission is never evicted by the retention limit", async () => {
  const live = mission({ id: "55555555-5555-4555-8555-555555555555", ownerId: "bulk", state: "waiting_permission" });
  await store.saveMission(live);

  // Push well past the retention ceiling with finished missions.
  for (let i = 0; i < LIMITS.maxMissionsPerOwner + 5; i++) {
    await store.saveMission({
      ...mission({ ownerId: "bulk" }),
      id: `66666666-6666-4666-8666-${String(i).padStart(12, "0")}`,
      state: "completed",
      result: { summary: "done", evidenceIds: [], confidence: null, actionsTaken: [] },
    });
  }

  const kept = await store.listMissions("bulk");
  assert.ok(
    kept.some((m) => m.id === "55555555-5555-4555-8555-555555555555"),
    "dropping a mission that is waiting would strand the person who was asked"
  );
  assert.ok(kept.length <= LIMITS.maxMissionsPerOwner + 1);
});

test("one owner's volume cannot evict another owner's record", async () => {
  const mine = await store.listMissions("111");
  assert.ok(mine.length > 0, "still here after another owner wrote 25 missions");
});

test("removing all of an owner's missions leaves everyone else's", async () => {
  const before = (await store.listMissions("222")).length;
  const dropped = await store.removeAllMissions("111");

  assert.ok(dropped > 0);
  assert.equal((await store.listMissions("111")).length, 0);
  assert.equal((await store.listMissions("222")).length, before);
});
