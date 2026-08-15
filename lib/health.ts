import { access, constants } from "node:fs/promises";
import { dataDir } from "./paths";
import { leaseHolder } from "./lease";
import { loopAges, stalledLoops } from "./heartbeat";

/**
 * What this process would say about itself.
 *
 * Separated from the route so it can be tested without a server: the property
 * that matters — a stopped background loop making the service report degraded —
 * is worth a test, and the route itself is only serialisation.
 */

export type HealthReport = {
  httpStatus: number;
  body: {
    status: "ok" | "degraded";
    storage: "writable" | "unwritable";
    scheduler: "running" | "standby";
    loops: Record<string, number>;
    stalled?: string[];
    uptimeSeconds: number;
    checkedInMs: number;
  };
};

export async function healthReport(): Promise<HealthReport> {
  const startedAt = Date.now();

  let storage: "writable" | "unwritable" = "unwritable";
  try {
    await access(dataDir(), constants.W_OK);
    storage = "writable";
  } catch {
    // Left as unwritable: on a host with no mounted volume this is the failure
    // that loses every subscriber on the next deploy, and it should be loud.
  }

  const lease = await leaseHolder("scheduler").catch(() => null);

  /**
   * A stopped background loop fails the health check.
   *
   * This is the whole reason the loops report at all. One of them ending leaves
   * a process that still serves HTTP, still answers questions and looks
   * completely healthy from outside, while alerts silently stop forever — so
   * unless it is said here, no external monitor can ever see it.
   *
   * Read from memory, costing nothing, and empty on the website, which deploys
   * this same code and runs no loops.
   */
  const stalled = stalledLoops();
  const healthy = storage === "writable" && stalled.length === 0;

  return {
    httpStatus: healthy ? 200 : 503,
    body: {
      status: healthy ? "ok" : "degraded",
      storage,
      // "standby" is a normal, correct state — not an error.
      scheduler: lease ? "running" : "standby",
      loops: loopAges(),
      ...(stalled.length ? { stalled: stalled.map((s) => s.loop) } : {}),
      uptimeSeconds: Math.round(process.uptime()),
      checkedInMs: Date.now() - startedAt,
    },
  };
}
