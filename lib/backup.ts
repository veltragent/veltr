import { gunzipSync, gzipSync } from "node:zlib";
import { kvAvailable, kvGet, kvSet } from "./kv";
import { readState, writeState, type WatcherState } from "./store";

/**
 * Off-host copies of the one document everything lives in.
 *
 * Subscribers, watchlists, alert settings, missions, schedules and the owner id
 * are a single JSON file on a single mounted volume. A copy on that same volume
 * would survive a bad write and nothing else, which is not the failure worth
 * insuring against — losing the volume loses every user, and there is no second
 * source to rebuild them from. So the copy goes to the shared store, which is
 * already configured, already proven, and on a different machine.
 *
 * The dangerous operation here is not the backup, it is the *next* one. A
 * process that boots against an empty volume and immediately snapshots what it
 * sees will overwrite the last good copy with nothing, turning a recoverable
 * incident into a permanent one. Everything below is arranged around refusing
 * that write.
 */

const LATEST = "backup:latest";
const RING_SIZE = 6;
const ringKey = (n: number) => `backup:ring:${n}`;

/** Upstash rejects a large request; compressed state is a few kilobytes. */
const MAX_BACKUP_BYTES = 400_000;

export type Snapshot = {
  at: string;
  /** What the copy contains, so a restore can be judged before it is trusted. */
  counts: Census;
  /** gzipped JSON, base64 — state is mostly repeated keys and compresses hard. */
  gz: string;
};

/** The things whose loss would actually matter, counted. */
export type Census = {
  subscriptions: number;
  tokenWatches: number;
  schedules: number;
  missions: number;
  tracks: number;
  hasOwner: boolean;
};

export function census(state: WatcherState): Census {
  return {
    subscriptions: state.subscriptions?.length ?? 0,
    tokenWatches: state.tokenWatches?.length ?? 0,
    schedules: state.schedules?.length ?? 0,
    missions: state.missions?.length ?? 0,
    tracks: state.tracks?.length ?? 0,
    hasOwner: Boolean(state.ownerChatId),
  };
}

/** Nothing anybody would miss. */
export function isEmpty(c: Census): boolean {
  return (
    c.subscriptions === 0 &&
    c.tokenWatches === 0 &&
    c.schedules === 0 &&
    c.tracks === 0 &&
    !c.hasOwner
  );
}

/**
 * Would writing `next` over `previous` destroy something?
 *
 * A backup is only worth having if it cannot be silently emptied. Growth and
 * ordinary churn are fine; what is refused is the shape of an accident — the
 * population going to zero, or falling off a cliff, which is what a wiped
 * volume or a half-initialised boot looks like from here.
 */
export function wouldLoseData(previous: Census | null, next: Census): boolean {
  if (!previous) return false;
  if (isEmpty(next) && !isEmpty(previous)) return true;

  const before = previous.subscriptions + previous.tokenWatches + previous.tracks;
  const after = next.subscriptions + next.tokenWatches + next.tracks;
  if (before === 0) return false;

  // Losing more than half the population between two snapshots is not churn.
  return after < before / 2;
}

function encode(state: WatcherState): string {
  return gzipSync(Buffer.from(JSON.stringify(state), "utf8")).toString("base64");
}

function decode(gz: string): WatcherState {
  return JSON.parse(gunzipSync(Buffer.from(gz, "base64")).toString("utf8")) as WatcherState;
}

export async function readLatest(): Promise<Snapshot | null> {
  const raw = await kvGet(LATEST);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Snapshot;
  } catch {
    return null;
  }
}

export type BackupOutcome =
  | { ok: true; bytes: number; counts: Census }
  | { ok: false; reason: "unavailable" | "refused" | "too-large" | "error"; detail?: string };

/**
 * Takes one copy, keeping a short history.
 *
 * `force` is for the case where the refusal is wrong — an owner who really has
 * removed everyone and wants that recorded.
 */
export async function backupNow(options: { force?: boolean } = {}): Promise<BackupOutcome> {
  if (!kvAvailable()) return { ok: false, reason: "unavailable" };

  try {
    const state = await readState();
    const counts = census(state);
    const previous = await readLatest();

    if (!options.force && wouldLoseData(previous?.counts ?? null, counts)) {
      console.warn(
        `[veltr][BACKUP] refused — would replace ${JSON.stringify(previous?.counts)} with ${JSON.stringify(counts)}`
      );
      return { ok: false, reason: "refused" };
    }

    const gz = encode(state);
    const snapshot: Snapshot = { at: new Date().toISOString(), counts, gz };
    const body = JSON.stringify(snapshot);

    if (body.length > MAX_BACKUP_BYTES) {
      return { ok: false, reason: "too-large", detail: `${Math.round(body.length / 1024)}KB` };
    }

    // The ring first: if the process dies between the two writes, the older
    // generation is still whole and `latest` still points at the previous good
    // copy rather than at a slot that was overwritten for nothing.
    const slot = Math.floor(Date.now() / (60 * 60 * 1000)) % RING_SIZE;
    await kvSet(ringKey(slot), body, 8 * 24 * 60 * 60 * 1000);
    await kvSet(LATEST, body, 30 * 24 * 60 * 60 * 1000);

    return { ok: true, bytes: body.length, counts };
  } catch (error) {
    return { ok: false, reason: "error", detail: error instanceof Error ? error.message : String(error) };
  }
}

export type RestoreOutcome =
  | { ok: true; from: string; counts: Census }
  | { ok: false; reason: "unavailable" | "no-backup" | "not-needed" | "error"; detail?: string };

/**
 * Puts a copy back, but only into a hole.
 *
 * Deliberately not a general restore: run automatically, the only safe trigger
 * is local state that holds nothing, because anything else means overwriting
 * live data with something older. A volume that came back empty is exactly that
 * hole, and it is the case this whole file exists for.
 */
export async function restoreIfEmpty(): Promise<RestoreOutcome> {
  if (!kvAvailable()) return { ok: false, reason: "unavailable" };

  try {
    const current = census(await readState());
    if (!isEmpty(current)) return { ok: false, reason: "not-needed" };

    const snapshot = await readLatest();
    if (!snapshot) return { ok: false, reason: "no-backup" };
    if (isEmpty(snapshot.counts)) return { ok: false, reason: "no-backup" };

    await writeState(decode(snapshot.gz));
    console.warn(
      `[veltr][BACKUP] local state was empty — restored the copy taken at ${snapshot.at}: ${JSON.stringify(snapshot.counts)}`
    );
    return { ok: true, from: snapshot.at, counts: snapshot.counts };
  } catch (error) {
    return { ok: false, reason: "error", detail: error instanceof Error ? error.message : String(error) };
  }
}

/** Renders a census for a person rather than a log. */
export function describeCensus(c: Census): string {
  return [
    `${c.subscriptions} subscriber${c.subscriptions === 1 ? "" : "s"}`,
    `${c.tokenWatches} watch${c.tokenWatches === 1 ? "" : "es"}`,
    `${c.schedules} schedule${c.schedules === 1 ? "" : "s"}`,
    `${c.tracks} track${c.tracks === 1 ? "" : "s"}`,
  ].join(", ");
}
