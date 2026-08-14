import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Restricting pushes to the operator.
 *
 * The failure this prevents is concrete: this instance had four subscribers, and
 * a corporate action or a daily brief would have messaged all four. The gate has
 * to fail closed, because "we could not work out who the owner is, so we told
 * everyone" is the exact outcome it exists to stop.
 */

const sandbox = mkdtempSync(join(tmpdir(), "veltr-owner-"));
mkdirSync(join(sandbox, "data"), { recursive: true });
process.chdir(sandbox);

const STATE_FILE = join(sandbox, "data", "watcher-state.json");
writeFileSync(
  STATE_FILE,
  JSON.stringify({
    lastMultiplier: {},
    lastPending: {},
    seenActionIds: [],
    changes: [],
    subscriptions: [
      { id: "a", address: null, channel: "telegram", destination: "111", minDeltaPct: 0, createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "b", address: null, channel: "telegram", destination: "222", minDeltaPct: 0, createdAt: "2026-01-01T00:00:00.000Z" },
    ],
    lastRunAt: null,
    lastBlock: null,
    lastTelegramUpdateId: null,
    lastBriefSentOn: null,
  }),
  "utf8"
);

const owner = await import("../lib/owner");
const { readState } = await import("../lib/store");

const ALL = ["111", "222", "333"];

/**
 * Runs with a temporary environment.
 *
 * Awaits the callback before restoring. A synchronous `finally` around an async
 * body puts the environment back while the body is still suspended on its first
 * await, so every later line runs unconfigured — which showed up here as a push
 * gate that reported itself switched off halfway through a test.
 */
async function withEnv<T>(
  vars: Record<string, string | undefined>,
  run: () => T | Promise<T>
): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    previous[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await run();
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const OFF = { VELTR_OWNER_USERNAME: undefined, VELTR_OWNER_CHAT_ID: undefined };

test("with no owner configured, nothing changes", async () => {
  const result = await withEnv(OFF, () => owner.allowedRecipients(ALL));
  assert.deepEqual(result, ALL, "the existing broadcast behaviour must be preserved");
  assert.equal(owner.ownerRestrictionEnabled(), false);
});

test("a numeric owner id restricts immediately", async () => {
  const result = await withEnv({ ...OFF, VELTR_OWNER_CHAT_ID: "222" }, () =>
    owner.allowedRecipients(ALL)
  );
  assert.deepEqual(result, ["222"]);
});

test("a username with no known chat id sends to nobody", async () => {
  // Fails closed. Telegram cannot resolve a private username for a bot, so until
  // the owner speaks the only safe recipient list is empty.
  const result = await withEnv({ ...OFF, VELTR_OWNER_USERNAME: "dimxbt" }, () =>
    owner.allowedRecipients(ALL)
  );
  assert.deepEqual(result, [], "silence beats messaging three strangers");
});

test("the owner is identified when they speak, and persisted", async () => {
  await withEnv({ ...OFF, VELTR_OWNER_USERNAME: "dimxbt" }, async () => {
    await owner.learnOwner("999", "@DimXBT");
  });

  const onDisk = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  assert.equal(onDisk.ownerChatId, "999", "matched case-insensitively and with the @ stripped");
  assert.equal(onDisk.subscriptions.length, 2, "the rest of the document survived the write");
});

test("once identified, only the owner receives a push", async () => {
  const result = await withEnv({ ...OFF, VELTR_OWNER_USERNAME: "dimxbt" }, () =>
    owner.allowedRecipients([...ALL, "999"])
  );
  assert.deepEqual(result, ["999"]);
});

test("someone else's username never claims ownership", async () => {
  await withEnv({ ...OFF, VELTR_OWNER_USERNAME: "dimxbt" }, async () => {
    await owner.learnOwner("777", "impostor");
    await owner.learnOwner("778", undefined);
    await owner.learnOwner("779", "dimxbt_");
  });

  assert.equal((await readState()).ownerChatId, "999", "still the real owner");
});

test("mayPush answers for one chat", async () => {
  await withEnv({ ...OFF, VELTR_OWNER_USERNAME: "dimxbt" }, async () => {
    assert.equal(await owner.mayPush("999"), true);
    assert.equal(await owner.mayPush("111"), false);
  });
});

test("with the restriction off, anyone may be pushed to", async () => {
  await withEnv(OFF, async () => {
    assert.equal(await owner.mayPush("111"), true);
  });
});

test("an explicit chat id overrides the learned one", async () => {
  const result = await withEnv(
    { ...OFF, VELTR_OWNER_USERNAME: "dimxbt", VELTR_OWNER_CHAT_ID: "111" },
    () => owner.allowedRecipients(ALL)
  );
  assert.deepEqual(result, ["111"]);
});
