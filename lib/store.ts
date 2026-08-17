import { readFile, writeFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { dataFile } from "./paths";
import type { TokenWatch, WatchSettings } from "./watch/types";
import type { Mission } from "./agent/types";
import type { Track } from "./track/store";
import type { Lease } from "./lease";
import type { Schedule } from "./agent/schedule";
import type { Series as TokenSeries } from "./intel/baseline";

/**
 * File-backed state for the watcher.
 *
 * Deliberately boring: the watcher needs to remember what it last saw so it can
 * tell a *change* from a *reading*, and that is a few kilobytes of data. Writes
 * are atomic (temp file + rename) so a crash mid-write cannot corrupt state.
 *
 * Requires a persistent filesystem — on a serverless host this resets on every
 * cold start. Move to Postgres or Redis before deploying anywhere ephemeral.
 */
/** Resolved per call so VELTR_DATA_DIR can point at a mounted volume. */
const storePath = () => dataFile("watcher-state.json");

export type Subscription = {
  id: string;
  /** Wallet whose positions are watched, or null for chain-wide alerts. */
  address: string | null;
  /** Delivery channel identifier, e.g. a Telegram chat id. */
  channel: "telegram";
  destination: string;
  /** Only notify when |deltaPct| meets this threshold. */
  minDeltaPct: number;
  createdAt: string;
  /**
   * Whether this user receives Veltr's chain-wide intelligence alerts.
   *
   * Undefined means on. Written that way deliberately: every subscriber who
   * existed before this feature should receive them without a migration, and
   * treating absence as opt-out would have silently excluded exactly the people
   * who have been using the bot longest.
   *
   * These are separate from personal watch alerts and from the daily brief.
   * Turning them off must not touch either.
   */
  globalAlerts?: boolean;
  /**
   * Set when Telegram says this chat can no longer be written to.
   *
   * A blocked bot or a deleted account returns 403 forever, so retrying is a
   * guaranteed-failing request on every broadcast. Recorded rather than deleted:
   * the row is what proves they once subscribed, and a user who unblocks the bot
   * is cleared on their next message.
   */
  undeliverableSince?: string | null;
};

export type DetectedChange = {
  id: string;
  detectedAt: string;
  token: string;
  symbol: string;
  kind: "multiplier-applied" | "action-scheduled" | "action-cleared";
  from: number;
  to: number;
  deltaPct: number;
  effectiveAt: number | null;
  notified: boolean;
};

export type WatcherState = {
  /** address -> last observed uiMultiplier (as a plain number). */
  lastMultiplier: Record<string, number>;
  /** address -> last observed pending newUIMultiplier, when one was queued. */
  lastPending: Record<string, number | null>;
  /** Corporate-action log ids already seen, so replays are not re-announced. */
  seenActionIds: string[];
  changes: DetectedChange[];
  subscriptions: Subscription[];
  lastRunAt: string | null;
  lastBlock: string | null;
  /** Telegram long-poll cursor, so the same message never registers twice. */
  lastTelegramUpdateId: number | null;
  lastBriefSentOn: string | null;
  /**
   * Per-user token watchlists and their alert settings.
   *
   * Added after the corporate-action watcher, so both default to empty and a
   * state file written before this feature loads unchanged. Kept in the same
   * file rather than a second store because every writer here already
   * read-modify-writes the whole document — a parallel file would need its own
   * atomicity story for no gain.
   */
  tokenWatches: TokenWatch[];
  /** Telegram chat id -> that user's settings. Never shared between users. */
  watchSettings: Record<string, WatchSettings>;
  /**
   * Autonomous missions.
   *
   * Persisted because a mission waiting for approval has to survive a restart —
   * the approval can arrive hours later, in a different process. Records are
   * bounded on write; this file is state, not an archive.
   */
  missions: Mission[];
  /**
   * Chat id of the operator, learned from VELTR_OWNER_USERNAME.
   *
   * Telegram will not resolve a private username to an id for a bot, so it is
   * captured the first time the owner sends a message and kept here so a restart
   * does not lose it — and with it, the ability to restrict pushes.
   */
  ownerChatId: string | null;
  /**
   * Targets under change monitoring — repositories and pages.
   *
   * Each carries the fingerprint of its last reading, which is what makes
   * "notify only on change" a property of the data rather than a judgement
   * asked of a model.
   */
  tracks: Track[];
  /**
   * Named single-writer leases, by lease name.
   *
   * Only the background scheduler uses one today: exactly one process may run
   * the Telegram long-poll and the alert loops, because two of them steal each
   * other's updates and send every alert twice.
   */
  leases: Record<string, Lease>;
  /**
   * Recurring missions. Each run is a full mission, so these are few, slow and
   * silent unless the figures they observe actually move.
   */
  schedules: Schedule[];
  /**
   * Rolling metric history per token, recorded by the intelligence loop.
   *
   * Kept here because no provider on this chain sells it: there is no endpoint
   * for last week's liquidity or holder count, so "is this unusual" can only be
   * answered against observations we made ourselves. Bounded per token — see
   * lib/intel/baseline.ts — so this stays state rather than becoming an archive.
   */
  intelBaselines: Record<string, TokenSeries>;
  /**
   * When each signal kind last fired, per user and per token.
   *
   * Separate from the watch cooldown because a signal is not a threshold
   * crossing: the same accumulation can stay true for hours, and re-arming on a
   * value retreating does not apply to it. Keyed so one user's silence never
   * suppresses another's alert.
   */
  signalCooldowns: Record<string, number>;
  /**
   * What has already gone out chain-wide, and when.
   *
   * Holds two kinds of mark: one per broadcast event identity, which makes a
   * re-detection of the same event a no-op, and one per token, which enforces
   * quiet between alerts about the same thing. Bounded on write — see
   * lib/intel/broadcast.ts.
   */
  broadcastMarks: Record<string, number>;
};

const EMPTY: WatcherState = {
  lastMultiplier: {},
  lastPending: {},
  seenActionIds: [],
  changes: [],
  subscriptions: [],
  lastRunAt: null,
  lastBlock: null,
  lastTelegramUpdateId: null,
  lastBriefSentOn: null,
  tokenWatches: [],
  watchSettings: {},
  missions: [],
  ownerChatId: null,
  tracks: [],
  leases: {},
  schedules: [],
  intelBaselines: {},
  signalCooldowns: {},
  broadcastMarks: {},
};

let memo: WatcherState | null = null;
let memoMtimeMs = 0;

/**
 * Reads state, reloading whenever the file on disk is newer than the copy in
 * memory.
 *
 * The mtime check is not optional: the background scheduler and the HTTP route
 * handlers can run in separate worker processes, so a plain memo makes request
 * handlers serve state frozen at their own first read while the scheduler
 * writes fresh data no one ever sees.
 */
export async function readState(): Promise<WatcherState> {
  let mtimeMs = 0;
  try {
    mtimeMs = (await stat(storePath())).mtimeMs;
  } catch {
    // No file yet — fall through to the empty baseline.
  }

  if (memo && mtimeMs <= memoMtimeMs) return memo;

  try {
    const raw = await readFile(storePath(), "utf8");
    memo = { ...EMPTY, ...(JSON.parse(raw) as Partial<WatcherState>) };
    memoMtimeMs = mtimeMs;
  } catch {
    memo = memo ?? { ...EMPTY };
  }
  return memo;
}

export async function writeState(state: WatcherState): Promise<void> {
  memo = state;
  await mkdir(dirname(storePath()), { recursive: true });
  const tmp = `${storePath()}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await rename(tmp, storePath());
  try {
    memoMtimeMs = (await stat(storePath())).mtimeMs;
  } catch {
    memoMtimeMs = Date.now();
  }
}

/** Keeps the change log from growing without bound on a long-running process. */
export function trimChanges(changes: DetectedChange[], limit = 500): DetectedChange[] {
  return changes.slice(0, limit);
}

/**
 * Serialises read-modify-write across the whole process.
 *
 * Several independent writers share this one document — the corporate-action
 * watcher, the Telegram loop, the token monitor and the agent. Without a single
 * queue, two overlapping updates each read the same base and the second write
 * discards the first, which shows up as a watch that vanishes or a mission that
 * forgets it was approved.
 *
 * One queue for every writer is the point: a second queue elsewhere would
 * serialise against itself and race against this one, which is indistinguishable
 * from having none.
 */
let writeQueue: Promise<unknown> = Promise.resolve();

export function mutateState<T>(
  apply: (state: WatcherState) => { state: WatcherState; result: T }
): Promise<T> {
  const run = writeQueue.then(async () => {
    const current = await readState();
    const { state, result } = apply(current);
    await writeState(state);
    return result;
  });
  // The chain must survive a rejection, or every later write inherits it.
  writeQueue = run.catch(() => undefined);
  return run;
}
