import { access, constants } from "node:fs/promises";
import { dataDir } from "./paths";
import { leaseHolder } from "./lease";
import { BEATS_STALE_MS, loopAges, readPublishedBeats, stalledLoops } from "./heartbeat";

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
    watchdog?: "silent";
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
   * The loops almost never run in this process: request handlers are served
   * from workers separate from the one that started the scheduler. So the
   * in-memory view is used when there is one, and otherwise the file the
   * watchdog publishes to the shared volume.
   */
  const local = stalledLoops();
  const inProcess = loopAges();
  const published = Object.keys(inProcess).length > 0 ? null : await readPublishedBeats();

  let loops = inProcess;
  let stalled = local.map((s) => s.loop);
  let writerSilent = false;

  if (published?.known) {
    loops = published.ages;
    stalled = published.stalled.map((s) => s.loop);
    // The watchdog writes this file; if it has stopped, every age in it is
    // frozen and meaningless. That is a failure in its own right, not a reason
    // to trust the numbers.
    writerSilent = published.writerSilentMs > BEATS_STALE_MS;
  }

  /**
   * Storage only counts against a host that writes.
   *
   * The same code serves two of them. On the agent, a state directory it cannot
   * write to is the failure that loses every subscriber on the next deploy, and
   * it must be loud. On the website the filesystem is read-only by design, the
   * scheduler is switched off, and nothing is ever persisted — every page is
   * built from live chain and market reads.
   *
   * Applying the agent's requirement to both made the public site answer 503 to
   * every request, permanently, for a condition that could never be otherwise
   * there. The state is still reported either way; what changes is whether it
   * is treated as a fault. The flag is the one the scheduler itself reads, so
   * the two cannot disagree about which host this is.
   */
  const persists = process.env.VELTR_SCHEDULER !== "off";
  const storageOk = storage === "writable" || !persists;

  const healthy = storageOk && stalled.length === 0 && !writerSilent;

  return {
    httpStatus: healthy ? 200 : 503,
    body: {
      status: healthy ? "ok" : "degraded",
      storage,
      // "standby" is a normal, correct state — not an error.
      scheduler: lease ? "running" : "standby",
      loops,
      ...(stalled.length ? { stalled } : {}),
      ...(writerSilent ? { watchdog: "silent" } : {}),
      uptimeSeconds: Math.round(process.uptime()),
      checkedInMs: Date.now() - startedAt,
    },
  };
}
