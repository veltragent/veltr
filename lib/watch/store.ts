import { randomUUID } from "node:crypto";
import { readState, mutateState } from "../store";
import { fullyArmed, resyncArmState } from "./alerts";
import { DEFAULT_SETTINGS, normaliseSettings } from "./settings";
import type { TokenWatch, WatchSettings } from "./types";
import { CHAIN } from "./aggregate";

/**
 * Watchlist persistence.
 *
 * Backed by the same atomic JSON document the corporate-action watcher already
 * uses, so a watchlist survives a restart with no new infrastructure and no
 * migration step — the fields simply default to empty on a state file written
 * before they existed.
 *
 * Every read and write is scoped by Telegram chat id. There is no function here
 * that returns another user's watches or settings, which is the enforcement point
 * for "user A can never receive user B's alerts".
 */

/** One watch per user per token; more would multiply identical alerts. */
export const MAX_WATCHES_PER_USER = 50;

/**
 * Read-modify-write, serialised process-wide.
 *
 * Re-exported from the shared store rather than given its own queue: the agent
 * and the corporate-action watcher write the same document, so a queue private
 * to this module would serialise against itself while racing against theirs.
 */
export { mutateState };

/* ------------------------------------------------------------- Settings */

export async function getSettings(userId: string): Promise<WatchSettings> {
  const state = await readState();
  return normaliseSettings(state.watchSettings?.[userId]);
}

/** Settings for many users at once, for the monitoring cycle. */
export async function getSettingsFor(userIds: string[]): Promise<Map<string, WatchSettings>> {
  const state = await readState();
  const out = new Map<string, WatchSettings>();
  for (const userId of userIds) out.set(userId, normaliseSettings(state.watchSettings?.[userId]));
  return out;
}

/**
 * Applies a settings change and re-points every one of that user's watches at
 * the new thresholds.
 *
 * The re-sync is what stops a newly set threshold firing for a level the token
 * was already sitting above when it was set — an alert reporting a crossing that
 * never happened.
 */
export async function updateSettings(
  userId: string,
  patch: Partial<WatchSettings>
): Promise<WatchSettings> {
  return mutateState((state) => {
    const current = normaliseSettings(state.watchSettings?.[userId]);
    const next = normaliseSettings({ ...current, ...patch });

    const watches = (state.tokenWatches ?? []).map((watch) =>
      watch.userId === userId ? resyncArmState(watch, next) : watch
    );

    return {
      state: {
        ...state,
        tokenWatches: watches,
        watchSettings: { ...(state.watchSettings ?? {}), [userId]: next },
      },
      result: next,
    };
  });
}

export async function resetSettings(userId: string): Promise<WatchSettings> {
  return mutateState((state) => {
    const watches = (state.tokenWatches ?? []).map((watch) =>
      watch.userId === userId ? resyncArmState(watch, DEFAULT_SETTINGS) : watch
    );
    const settings = { ...(state.watchSettings ?? {}) };
    delete settings[userId];

    return {
      state: { ...state, tokenWatches: watches, watchSettings: settings },
      result: { ...DEFAULT_SETTINGS },
    };
  });
}

/* ------------------------------------------------------------ Watchlist */

export async function listWatches(userId: string): Promise<TokenWatch[]> {
  const state = await readState();
  return (state.tokenWatches ?? [])
    .filter((w) => w.userId === userId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function findWatch(userId: string, tokenAddress: string): Promise<TokenWatch | null> {
  const target = tokenAddress.toLowerCase();
  const state = await readState();
  return (
    (state.tokenWatches ?? []).find(
      (w) => w.userId === userId && w.tokenAddress.toLowerCase() === target
    ) ?? null
  );
}

/** Every watch in the system, for the monitoring cycle only. */
export async function listAllWatches(): Promise<TokenWatch[]> {
  const state = await readState();
  return state.tokenWatches ?? [];
}

export type AddWatchResult =
  | { ok: true; watch: TokenWatch; alreadyWatched: boolean }
  | { ok: false; error: string };

export async function addWatch(input: {
  userId: string;
  tokenAddress: string;
  symbol: string | null;
  name: string | null;
  pairAddress: string | null;
  price: number | null;
  marketCap: number | null;
  liquidity: number | null;
  volume24h: number | null;
}): Promise<AddWatchResult> {
  const address = input.tokenAddress.toLowerCase();

  return mutateState<AddWatchResult>((state) => {
    const watches = state.tokenWatches ?? [];
    const existing = watches.find(
      (w) => w.userId === input.userId && w.tokenAddress.toLowerCase() === address
    );

    if (existing) {
      // Re-watching refreshes the snapshot and rebases the percentage thresholds
      // on today's price, which is what someone typing /watch again is asking for.
      const refreshed: TokenWatch = {
        ...existing,
        symbol: input.symbol ?? existing.symbol,
        name: input.name ?? existing.name,
        pairAddress: input.pairAddress ?? existing.pairAddress,
        baselinePrice: input.price ?? existing.baselinePrice,
        lastPrice: input.price ?? existing.lastPrice,
        lastMarketCap: input.marketCap ?? existing.lastMarketCap,
        lastLiquidity: input.liquidity ?? existing.lastLiquidity,
        lastVolume: input.volume24h ?? existing.lastVolume,
        lastCheckedAt: new Date().toISOString(),
        lastAlertAt: null,
        armed: fullyArmed(),
        enabled: true,
      };

      return {
        state: {
          ...state,
          tokenWatches: watches.map((w) => (w.id === existing.id ? refreshed : w)),
        },
        result: { ok: true, watch: refreshed, alreadyWatched: true },
      };
    }

    if (watches.filter((w) => w.userId === input.userId).length >= MAX_WATCHES_PER_USER) {
      return {
        state,
        result: {
          ok: false,
          error: `You are already watching ${MAX_WATCHES_PER_USER} tokens. Remove one with /unwatch first.`,
        },
      };
    }

    const now = new Date().toISOString();
    const watch: TokenWatch = {
      id: randomUUID(),
      userId: input.userId,
      chain: CHAIN,
      tokenAddress: address,
      symbol: input.symbol,
      name: input.name,
      pairAddress: input.pairAddress,
      baselinePrice: input.price,
      lastPrice: input.price,
      lastMarketCap: input.marketCap,
      lastLiquidity: input.liquidity,
      lastVolume: input.volume24h,
      lastCheckedAt: now,
      lastAlertAt: null,
      armed: fullyArmed(),
      enabled: true,
      createdAt: now,
    };

    return {
      state: { ...state, tokenWatches: [...watches, watch] },
      result: { ok: true, watch, alreadyWatched: false },
    };
  });
}

export async function removeWatch(userId: string, tokenAddress: string): Promise<TokenWatch | null> {
  const target = tokenAddress.toLowerCase();

  return mutateState<TokenWatch | null>((state) => {
    const watches = state.tokenWatches ?? [];
    const removed = watches.find(
      (w) => w.userId === userId && w.tokenAddress.toLowerCase() === target
    );
    if (!removed) return { state, result: null };

    return {
      state: { ...state, tokenWatches: watches.filter((w) => w.id !== removed.id) },
      result: removed,
    };
  });
}

/** Drops every watch belonging to one user — used by /stop. */
export async function removeAllWatches(userId: string): Promise<number> {
  return mutateState((state) => {
    const watches = state.tokenWatches ?? [];
    const kept = watches.filter((w) => w.userId !== userId);
    return { state: { ...state, tokenWatches: kept }, result: watches.length - kept.length };
  });
}

/**
 * Writes back the watches a monitoring cycle advanced.
 *
 * Applied by id against the state as it is at write time, so a watch added or
 * removed while the cycle was fetching is not resurrected or clobbered by a
 * snapshot taken before it existed.
 */
export async function persistCycle(updated: TokenWatch[]): Promise<void> {
  if (updated.length === 0) return;
  const byId = new Map(updated.map((w) => [w.id, w]));

  await mutateState((state) => ({
    state: {
      ...state,
      tokenWatches: (state.tokenWatches ?? []).map((w) => byId.get(w.id) ?? w),
    },
    result: undefined,
  }));
}
