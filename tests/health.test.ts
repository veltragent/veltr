import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.VELTR_DATA_DIR = mkdtempSync(join(tmpdir(), "veltr-health-"));

const { beat } = await import("../lib/heartbeat");
const { healthReport } = await import("../lib/health");

/**
 * The health endpoint.
 *
 * Its job here is to make one specific failure visible: a background loop that
 * has ended inside a process that is otherwise perfectly fine. Nothing outside
 * can see that — the port answers, questions get replies — so if this endpoint
 * reports healthy, no monitor anywhere will ever report otherwise.
 */

async function body() {
  const report = await healthReport();
  return { status: report.httpStatus, json: report.body as unknown as Record<string, unknown> };
}

test("a host with no loops running is healthy", async () => {
  // The website deploys this same code and runs none of them.
  const { status, json } = await body();
  assert.equal(status, 200);
  assert.equal(json.status, "ok");
  assert.deepEqual(json.loops, {});
  assert.equal("stalled" in json, false, "nothing to report is reported as nothing");
});

test("a loop reporting normally is healthy, and its age is shown", async () => {
  beat("telegram", Date.now() - 30_000);
  const { status, json } = await body();

  assert.equal(status, 200);
  assert.equal((json.loops as Record<string, number>).telegram, 30);
});

test("a stopped loop degrades the service and names itself", async () => {
  // The process is still up and still answering. This is the only signal.
  beat("telegram", Date.now() - 30 * 60_000);
  const { status, json } = await body();

  assert.equal(status, 503, "an external monitor must be able to see this");
  assert.equal(json.status, "degraded");
  assert.deepEqual(json.stalled, ["telegram"]);
});

test("a recovered loop clears the degradation", async () => {
  beat("telegram", Date.now());
  const { status, json } = await body();

  assert.equal(status, 200);
  assert.equal(json.status, "ok");
});

/* ------------------------------------------- Across two processes */

test("loops running in another process are still reported", async () => {
  // The failure this replaced: the scheduler ran in one process and the health
  // endpoint answered in another, so it reported every loop running and
  // `loops: {}` in the same breath, and the stall check was dead code.
  const { publishBeats, beat: writerBeat } = await import("../lib/heartbeat");

  writerBeat("watch", Date.now() - 20_000);
  await publishBeats();

  // A reader that never ran a loop of its own.
  const { readPublishedBeats } = await import("../lib/heartbeat");
  const published = await readPublishedBeats();

  assert.equal(published.known, true);
  if (published.known) {
    assert.ok(published.ages.watch >= 20, "the other process's pass is visible");
  }
});

test("a stalled loop in the published file degrades the reader", async () => {
  const { publishBeats, beat: writerBeat } = await import("../lib/heartbeat");
  const { readPublishedBeats } = await import("../lib/heartbeat");

  writerBeat("watch", Date.now() - 30 * 60_000);
  await publishBeats();

  const published = await readPublishedBeats();
  assert.equal(published.known, true);
  if (published.known) {
    assert.deepEqual(published.stalled.map((s) => s.loop), ["watch"]);
  }
});

test("a watchdog that stopped writing is itself a failure", async () => {
  // Otherwise every age in the file freezes and reads as perfectly healthy.
  const { readPublishedBeats, BEATS_STALE_MS } = await import("../lib/heartbeat");
  const { writeFile } = await import("node:fs/promises");
  const { dataFile } = await import("../lib/paths");

  await writeFile(
    dataFile("heartbeat.json"),
    JSON.stringify({
      instance: "gone",
      at: new Date(Date.now() - 20 * 60_000).toISOString(),
      beats: { watch: new Date().toISOString() },
    }),
    "utf8"
  );

  const published = await readPublishedBeats();
  assert.equal(published.known, true);
  if (published.known) {
    assert.ok(published.writerSilentMs > BEATS_STALE_MS, "the writer is gone even though the ages look fresh");
    assert.deepEqual(published.stalled, [], "and the ages themselves are not what gives it away");
  }
});

test("nothing about who uses the product is exposed", async () => {
  // Public and unauthenticated: a subscriber count here could not be taken back.
  const { json } = await body();
  const text = JSON.stringify(json);
  for (const leak of ["subscri", "chatId", "chat_id", "token", "owner"]) {
    assert.ok(!text.toLowerCase().includes(leak.toLowerCase()), `${leak} must not appear`);
  }
});
