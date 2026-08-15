import { kvAvailable, kvGet, kvIncr, kvSet } from "./kv";
import { INSTANCE_ID } from "./lease";

/**
 * Knowing the agent stopped.
 *
 * Two mechanisms, because they answer different questions and neither covers
 * the other.
 *
 * A loop can die while the process lives. Every loop here is a `for(;;)` that
 * awaits something; one unhandled rejection ends that loop and nothing else,
 * so the bot keeps replying while alerts quietly stop forever. Nothing outside
 * the process can see this — from any distance it looks perfectly healthy. It
 * is caught from the inside, by each loop saying when it last completed a pass
 * and a watchdog noticing when one stops saying it.
 *
 * A process cannot report its own death. So the second mechanism is the
 * opposite: a beacon written to the shared store with a short expiry, whose
 * *absence* is the signal. Nothing has to be running for it to expire, which is
 * exactly the property needed — anything that can read the store, including the
 * website on a different host, can tell the agent has stopped checking in.
 */

export type LoopName = "telegram" | "watch" | "tokens" | "tracks" | "schedules" | "backups";

/**
 * How long a loop may go quiet before it is considered stuck.
 *
 * Generous multiples of each loop's own period: a pass that runs long, a slow
 * provider, or one retry must not raise an alarm. What these catch is a loop
 * that has stopped entirely, which is the failure worth waking someone for.
 */
const TOLERANCE_MS: Record<LoopName, number> = {
  telegram: 5 * 60_000,
  watch: 10 * 60_000,
  tokens: 10 * 60_000,
  tracks: 20 * 60_000,
  schedules: 20 * 60_000,
  backups: 90 * 60_000,
};

const beats = new Map<LoopName, number>();

/** Called by a loop when it finishes a pass. */
export function beat(loop: LoopName, at = Date.now()): void {
  beats.set(loop, at);
}

/** Called when a loop starts, so it is watched from then on and not before. */
export function watchLoopHealth(loop: LoopName): void {
  beat(loop);
}

export type Stall = { loop: LoopName; silentForMs: number; toleranceMs: number };

/**
 * Age of every loop's last pass, as this process knows it.
 *
 * Empty in a process that runs no loops, which is most of them — see
 * `publishBeats`.
 */
export function loopAges(now = Date.now()): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [loop, last] of beats) out[loop] = Math.round((now - last) / 1000);
  return out;
}

/* ------------------------------------------------- Across processes */

/**
 * The loops run in one process; the health endpoint answers in another.
 *
 * Next.js serves request handlers from worker processes separate from the one
 * that started the scheduler — the same split `store.ts` documents, and the
 * reason a plain in-memory map is invisible to `/api/health`. Reported straight
 * from memory, the stall check was dead code: production showed every loop
 * running and `loops: {}` in the same breath.
 *
 * So the watchdog writes them where the other process can read them. On the
 * volume rather than through the shared store, because both processes are on
 * the same host and a file costs nothing — a health endpoint that spent a
 * network round trip per call would be a new runaway in place of the old one.
 */
const HEARTBEAT_FILE = "heartbeat.json";

/** Past this, the writer itself has stopped, which is its own failure. */
export const BEATS_STALE_MS = 5 * 60_000;

type BeatsFile = { instance: string; at: string; beats: Record<string, string> };

export async function publishBeats(now = new Date()): Promise<void> {
  const { writeFile, rename, mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const { dataFile } = await import("./paths");

  const path = dataFile(HEARTBEAT_FILE);
  const payload: BeatsFile = {
    instance: INSTANCE_ID,
    at: now.toISOString(),
    beats: Object.fromEntries([...beats].map(([loop, at]) => [loop, new Date(at).toISOString()])),
  };

  try {
    await mkdir(dirname(path), { recursive: true });
    // Same atomic write the state document uses: a health check reading a
    // half-written file would report a failure that is not happening.
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(payload), "utf8");
    await rename(tmp, path);
  } catch {
    // A volume that cannot be written is already reported by the health check.
  }
}

export type PublishedBeats =
  | { known: false }
  | { known: true; instance: string; writerSilentMs: number; ages: Record<string, number>; stalled: Stall[] };

export async function readPublishedBeats(now = Date.now()): Promise<PublishedBeats> {
  const { readFile } = await import("node:fs/promises");
  const { dataFile } = await import("./paths");

  let parsed: BeatsFile;
  try {
    parsed = JSON.parse(await readFile(dataFile(HEARTBEAT_FILE), "utf8")) as BeatsFile;
  } catch {
    return { known: false };
  }

  const ages: Record<string, number> = {};
  const stalled: Stall[] = [];

  for (const [loop, at] of Object.entries(parsed.beats ?? {})) {
    const silentForMs = now - new Date(at).getTime();
    ages[loop] = Math.round(silentForMs / 1000);
    const toleranceMs = TOLERANCE_MS[loop as LoopName];
    if (toleranceMs && silentForMs > toleranceMs) stalled.push({ loop: loop as LoopName, silentForMs, toleranceMs });
  }

  return {
    known: true,
    instance: parsed.instance,
    writerSilentMs: now - new Date(parsed.at).getTime(),
    ages,
    stalled,
  };
}

/**
 * Loops that have stopped reporting.
 *
 * Only loops that have started are considered — an unwatched loop is one that
 * was never meant to run on this instance, and treating "never started" as
 * "stopped" would alarm on every deployment that disables something.
 */
export function stalledLoops(now = Date.now()): Stall[] {
  const out: Stall[] = [];
  for (const [loop, last] of beats) {
    const silentForMs = now - last;
    const toleranceMs = TOLERANCE_MS[loop];
    if (silentForMs > toleranceMs) out.push({ loop, silentForMs, toleranceMs });
  }
  return out;
}

/* ------------------------------------------------------------- Beacon */

const BEACON = "alive";

/**
 * How long the beacon outlives the process that wrote it.
 *
 * Short enough that a death is noticed quickly, long enough that one slow tick
 * or a brief store outage is not mistaken for one.
 */
export const BEACON_TTL_MS = 3 * 60_000;
const BEACON_INTERVAL_MS = 60_000;

export type Beacon = { instance: string; at: string; pid: number };

export async function publishBeacon(now = new Date()): Promise<void> {
  if (!kvAvailable()) return;
  const beacon: Beacon = { instance: INSTANCE_ID, at: now.toISOString(), pid: process.pid };
  await kvSet(BEACON, JSON.stringify(beacon), BEACON_TTL_MS).catch(() => {});
}

export async function readBeacon(): Promise<Beacon | null> {
  if (!kvAvailable()) return null;
  const raw = await kvGet(BEACON).catch(() => null);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Beacon;
  } catch {
    return null;
  }
}

/** For anything reporting on the agent from outside it. */
export type Liveness =
  | { known: false }
  | { known: true; instance: string; lastSeenMs: number; alive: boolean };

export async function liveness(now = Date.now()): Promise<Liveness> {
  const beacon = await readBeacon();
  if (!beacon) return { known: false };

  const lastSeenMs = now - new Date(beacon.at).getTime();
  return { known: true, instance: beacon.instance, lastSeenMs, alive: lastSeenMs < BEACON_TTL_MS };
}

/* --------------------------------------------------- Restarts at boot */

const RESTART_WINDOW_MS = 30 * 60_000;
const CRASH_LOOP_THRESHOLD = 3;

export type BootFinding =
  | { kind: "first-start" }
  | { kind: "clean-start" }
  | { kind: "restart"; replaced: string; agoMs: number; countInWindow: number }
  | { kind: "crash-loop"; replaced: string; agoMs: number; countInWindow: number };

/**
 * What this boot means.
 *
 * A beacon still warm from a *different* instance says the process it belonged
 * to did not shut down cleanly — a clean stop releases things; a crash leaves
 * them to expire. One of those is a deploy. Several in half an hour is a crash
 * loop, which from outside looks identical to a service that is simply up,
 * because between crashes it genuinely is.
 */
export async function classifyBoot(now = new Date()): Promise<BootFinding> {
  if (!kvAvailable()) return { kind: "clean-start" };

  const previous = await readBeacon();
  await publishBeacon(now);

  if (!previous) return { kind: "first-start" };
  if (previous.instance === INSTANCE_ID) return { kind: "clean-start" };

  const agoMs = now.getTime() - new Date(previous.at).getTime();
  const countInWindow = (await kvIncr("restarts", RESTART_WINDOW_MS)) ?? 1;

  if (countInWindow >= CRASH_LOOP_THRESHOLD) {
    return { kind: "crash-loop", replaced: previous.instance, agoMs, countInWindow };
  }
  return { kind: "restart", replaced: previous.instance, agoMs, countInWindow };
}

export { BEACON_INTERVAL_MS };
