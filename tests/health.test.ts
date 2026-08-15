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

test("nothing about who uses the product is exposed", async () => {
  // Public and unauthenticated: a subscriber count here could not be taken back.
  const { json } = await body();
  const text = JSON.stringify(json);
  for (const leak of ["subscri", "chatId", "chat_id", "token", "owner"]) {
    assert.ok(!text.toLowerCase().includes(leak.toLowerCase()), `${leak} must not appear`);
  }
});
