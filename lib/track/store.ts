import { randomUUID } from "node:crypto";
import { mutateState, readState } from "../store";
import type { Target, TrackKind } from "./signals";

/**
 * Tracked targets.
 *
 * Same document, same write queue as everything else. A track is small — a
 * fingerprint and a few facts — so keeping the last reading inline costs
 * nothing and means change detection needs no second store.
 */

export type Track = {
  id: string;
  /** Telegram chat id. Scopes every read and write. */
  userId: string;
  kind: TrackKind;
  /** `owner/repo` or a URL. */
  ref: string;
  /** Fingerprint of the last successful reading; null until the first one. */
  fingerprint: string | null;
  lastSummary: string | null;
  lastFacts: Record<string, string | number | null>;
  lastCheckedAt: string | null;
  lastChangedAt: string | null;
  /** Consecutive failures. Used to back off a target that has gone away. */
  failures: number;
  intervalSec: number;
  enabled: boolean;
  createdAt: string;
};

/** A repository or a page rarely changes minute to minute; polling it so does not help. */
export const DEFAULT_INTERVAL_SEC = 15 * 60;

export const MAX_TRACKS_PER_USER = 20;

/**
 * Failures before a target is paused.
 *
 * A deleted repository or a dead domain would otherwise be fetched every cycle
 * forever, and the user would be told about it every cycle too.
 */
export const MAX_FAILURES = 5;

export async function listTracks(userId: string): Promise<Track[]> {
  const state = await readState();
  return (state.tracks ?? [])
    .filter((t) => t.userId === userId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function listAllTracks(): Promise<Track[]> {
  return (await readState()).tracks ?? [];
}

export async function findTrack(userId: string, ref: string): Promise<Track | null> {
  const wanted = ref.trim().toLowerCase();
  const tracks = await listTracks(userId);
  return tracks.find((t) => t.ref.toLowerCase() === wanted) ?? null;
}

export type AddResult = { ok: true; track: Track; existed: boolean } | { ok: false; error: string };

export async function addTrack(userId: string, target: Target): Promise<AddResult> {
  return mutateState<AddResult>((state) => {
    const tracks = state.tracks ?? [];
    const existing = tracks.find(
      (t) => t.userId === userId && t.ref.toLowerCase() === target.ref.toLowerCase()
    );

    if (existing) return { state, result: { ok: true, track: existing, existed: true } };

    if (tracks.filter((t) => t.userId === userId).length >= MAX_TRACKS_PER_USER) {
      return {
        state,
        result: { ok: false, error: `You are already tracking ${MAX_TRACKS_PER_USER} targets. Remove one first.` },
      };
    }

    const track: Track = {
      id: randomUUID(),
      userId,
      kind: target.kind,
      ref: target.ref,
      fingerprint: null,
      lastSummary: null,
      lastFacts: {},
      lastCheckedAt: null,
      lastChangedAt: null,
      failures: 0,
      intervalSec: DEFAULT_INTERVAL_SEC,
      enabled: true,
      createdAt: new Date().toISOString(),
    };

    return { state: { ...state, tracks: [...tracks, track] }, result: { ok: true, track, existed: false } };
  });
}

export async function removeTrack(userId: string, ref: string): Promise<Track | null> {
  const wanted = ref.trim().toLowerCase();

  return mutateState<Track | null>((state) => {
    const tracks = state.tracks ?? [];
    const found = tracks.find((t) => t.userId === userId && t.ref.toLowerCase() === wanted);
    if (!found) return { state, result: null };
    return { state: { ...state, tracks: tracks.filter((t) => t.id !== found.id) }, result: found };
  });
}

export async function removeAllTracks(userId: string): Promise<number> {
  return mutateState((state) => {
    const tracks = state.tracks ?? [];
    const kept = tracks.filter((t) => t.userId !== userId);
    return { state: { ...state, tracks: kept }, result: tracks.length - kept.length };
  });
}

/** Writes back what a cycle advanced, by id, against state as it is at write time. */
export async function persistTracks(updated: Track[]): Promise<void> {
  if (updated.length === 0) return;
  const byId = new Map(updated.map((t) => [t.id, t]));

  await mutateState((state) => ({
    state: { ...state, tracks: (state.tracks ?? []).map((t) => byId.get(t.id) ?? t) },
    result: undefined,
  }));
}
