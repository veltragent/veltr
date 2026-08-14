import { describeChange, readSignal, type Signal, type Target } from "./signals";
import { listAllTracks, persistTracks, MAX_FAILURES, type Track } from "./store";

/**
 * The change monitor.
 *
 * One centralised cycle, like the token watcher, and for the same reasons:
 * adding a track starts no timer, identical targets are fetched once, and a
 * restart resumes everything from disk.
 *
 * The rule that matters is that a notification requires a *changed
 * fingerprint*. Not a model's opinion that something looks different, not a new
 * timestamp on the same content — a different hash of the same normalised text.
 * The first reading establishes a baseline and never notifies, because a target
 * you have just started watching has not changed.
 */

export type TrackDeps = {
  loadTracks: () => Promise<Track[]>;
  read: (target: Target) => ReturnType<typeof readSignal>;
  persist: (tracks: Track[]) => Promise<void>;
  send: (userId: string, text: string) => Promise<boolean>;
  now: () => Date;
};

export type TrackReport = {
  ranAt: string;
  due: number;
  /** Distinct targets fetched — what actually costs a request. */
  fetched: number;
  changed: number;
  failed: number;
  sent: number;
  /** Tracks paused after repeated failure. */
  paused: number;
};

async function defaultDeps(): Promise<TrackDeps> {
  return {
    loadTracks: listAllTracks,
    read: readSignal,
    persist: persistTracks,
    send: async (userId, text) => {
      // A change notification is a push, so it obeys the owner restriction.
      const { mayPush } = await import("../owner");
      if (!(await mayPush(userId))) return false;
      const { sendTelegram } = await import("../notify");
      return sendTelegram(userId, text);
    },
    now: () => new Date(),
  };
}

export function isDue(track: Track, now: Date): boolean {
  if (!track.enabled) return false;
  if (!track.lastCheckedAt) return true;
  const elapsed = now.getTime() - new Date(track.lastCheckedAt).getTime();
  if (elapsed < 0) return true;
  return elapsed >= track.intervalSec * 1000;
}

const label = (track: Track) => (track.kind === "repo" ? track.ref : new URL(track.ref).hostname);

function renderChange(track: Track, detail: string, signal: Signal): string {
  return [
    `🔔 ${track.kind === "repo" ? "Repository" : "Page"} changed`,
    "",
    label(track),
    "",
    detail,
    "",
    track.kind === "repo" ? `https://github.com/${track.ref}` : track.ref,
    "",
    `Previously seen ${track.lastChangedAt ? `changing ${track.lastChangedAt.slice(0, 16).replace("T", " ")}` : "when you started tracking it"}.`,
    signal.summary ? `Now: ${signal.summary}` : "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * One monitoring pass.
 *
 * Never throws: the scheduler calls this forever, and an exception escaping here
 * would take out every track at once.
 */
export async function runTrackCycle(overrides: Partial<TrackDeps> = {}): Promise<TrackReport> {
  const deps: TrackDeps = { ...(await defaultDeps()), ...overrides };
  const now = deps.now();
  const report: TrackReport = {
    ranAt: now.toISOString(),
    due: 0,
    fetched: 0,
    changed: 0,
    failed: 0,
    sent: 0,
    paused: 0,
  };

  const tracks = await deps.loadTracks();
  const due = tracks.filter((t) => isDue(t, now));
  report.due = due.length;
  if (due.length === 0) return report;

  // Two people tracking the same repository is one request, read once and
  // evaluated against each of their stored fingerprints.
  const targets = new Map<string, Target>();
  for (const track of due) targets.set(`${track.kind}:${track.ref}`, { kind: track.kind, ref: track.ref });

  const readings = new Map<string, Awaited<ReturnType<typeof readSignal>>>();
  for (const [key, target] of targets) {
    readings.set(key, await deps.read(target));
    report.fetched++;
  }

  const updated: Track[] = [];
  const notifications: { userId: string; text: string }[] = [];

  for (const track of due) {
    const reading = readings.get(`${track.kind}:${track.ref}`);
    if (!reading) continue;

    if (!reading.ok) {
      report.failed++;
      const failures = track.failures + 1;
      const paused = failures >= MAX_FAILURES;
      if (paused) report.paused++;

      // The check is recorded even on failure, so a broken target backs off
      // rather than being retried every tick.
      updated.push({ ...track, failures, enabled: !paused, lastCheckedAt: now.toISOString() });
      console.warn(`[veltr][TRACK] ${label(track)} failed (${failures}/${MAX_FAILURES}): ${reading.error}`);
      continue;
    }

    const signal = reading.signal;
    const next: Track = {
      ...track,
      failures: 0,
      fingerprint: signal.fingerprint,
      lastSummary: signal.summary,
      lastFacts: signal.facts,
      lastCheckedAt: now.toISOString(),
    };

    // First reading: a baseline, not a change. Notifying here would tell the
    // user their brand-new track had already changed.
    if (track.fingerprint === null) {
      updated.push(next);
      continue;
    }

    if (track.fingerprint === signal.fingerprint) {
      updated.push(next);
      continue;
    }

    report.changed++;
    next.lastChangedAt = now.toISOString();
    updated.push(next);

    const detail = describeChange(
      { kind: track.kind, ref: track.ref },
      { fingerprint: track.fingerprint, summary: track.lastSummary ?? "", facts: track.lastFacts },
      signal
    );

    notifications.push({ userId: track.userId, text: renderChange(track, detail, signal) });
    console.log(`[veltr][TRACK] change detected ${label(track)} for ${track.userId}`);
  }

  await deps.persist(updated);

  for (const notification of notifications) {
    if (await deps.send(notification.userId, notification.text)) report.sent++;
  }

  return report;
}

export async function runTrackCycleSafely(): Promise<TrackReport | null> {
  try {
    return await runTrackCycle();
  } catch (error) {
    console.error("[veltr][TRACK] cycle failed:", error instanceof Error ? error.message : error);
    return null;
  }
}
