import { createHash } from "node:crypto";
import type { Mission } from "./types";

/**
 * Recurring missions.
 *
 * A mission answers a question once. A schedule asks the same question on a
 * cadence — and the hard part is not running it again, it is deciding whether
 * the new answer is worth interrupting someone for.
 *
 * The obvious approach fails: compare the new summary to the last one and report
 * when they differ. A model phrases the same facts differently every time, so
 * that reports a change on essentially every run, which is the same as no filter
 * at all. This is the identical trap the page tracker hit, and it is solved the
 * same way — deterministically, on the observations rather than the prose.
 *
 * So a run is compared by the *figures its evidence contained*. If the numbers
 * a mission saw are materially the same as last time, it stays quiet.
 */

export type Schedule = {
  id: string;
  ownerId: string;
  objective: string;
  /** Seconds between runs. */
  intervalSec: number;
  /** Fingerprint of the last run's observations. */
  fingerprint: string | null;
  /**
   * The figures behind that fingerprint.
   *
   * Kept alongside the hash because a hash can only answer "identical or not",
   * and the question that matters is "different enough to interrupt someone".
   */
  lastFigures: number[];
  lastSummary: string | null;
  lastRunAt: string | null;
  lastChangedAt: string | null;
  /** Consecutive runs that produced nothing usable. */
  failures: number;
  enabled: boolean;
  createdAt: string;
};

/** A mission is not cheap; anything under this would spend the model budget fast. */
export const MIN_INTERVAL_SEC = 15 * 60;
export const DEFAULT_INTERVAL_SEC = 60 * 60;
export const MAX_SCHEDULES_PER_USER = 5;

/** Runs that fail before a schedule is paused rather than retried forever. */
export const MAX_FAILURES = 5;

/**
 * Numbers that moved by less than this are the same number.
 *
 * A price ticking from 226.06 to 226.09 between hourly runs is not news. Without
 * a threshold every schedule fires every run, because on a live market no figure
 * is ever byte-identical twice.
 */
export const MATERIAL_CHANGE = 0.02;

/**
 * Extracts the figures an observation contained.
 *
 * Deliberately crude — it reads numbers out of the rendered evidence rather than
 * understanding it. That is enough: what matters is whether the quantities a
 * mission saw have moved, not what they were called.
 */
export function extractFigures(text: string): number[] {
  const found = text.match(/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g) ?? [];
  return found
    .map(Number)
    .filter((n) => Number.isFinite(n))
    // Timestamps and ids swamp everything else and never carry meaning here.
    .filter((n) => Math.abs(n) < 1e11)
    .slice(0, 200);
}

/**
 * Is the new reading materially different from the old one?
 *
 * Compared pairwise in order, which holds because a schedule runs the same
 * objective against the same tools and gets its evidence back in the same shape.
 * A change in *how many* figures came back is itself a change worth reporting —
 * it usually means a source dropped out or a new one answered.
 */
export function materiallyDifferent(
  before: number[],
  after: number[],
  threshold = MATERIAL_CHANGE
): boolean {
  if (before.length !== after.length) return true;

  for (let i = 0; i < before.length; i++) {
    const a = before[i];
    const b = after[i];
    if (a === b) continue;

    // Relative comparison, except near zero where relative change is meaningless.
    const scale = Math.max(Math.abs(a), Math.abs(b));
    if (scale < 1e-9) continue;
    if (Math.abs(b - a) / scale > threshold) return true;
  }

  return false;
}

/** Stable identity for a set of observations. */
export function fingerprintRun(figures: number[]): string {
  return createHash("sha256").update(figures.join(",")).digest("hex").slice(0, 16);
}

export type RunComparison = {
  fingerprint: string;
  figures: number[];
  /** True when this run should be reported to the owner. */
  changed: boolean;
  reason: "first-run" | "no-change" | "figures-moved" | "shape-changed" | "no-evidence";
};

/**
 * Decides whether a completed mission is worth reporting.
 *
 * The first run of a schedule never notifies. It establishes what "normal" looks
 * like, exactly as the first reading of a tracked page does — telling someone
 * their brand-new schedule has "changed" is meaningless.
 */
export function compareRun(schedule: Schedule, mission: Mission): RunComparison {
  const evidence = mission.evidence.filter((e) => e.ok).map((e) => e.summary).join("\n");
  const figures = extractFigures(evidence);

  if (figures.length === 0) {
    return { fingerprint: "", figures, changed: false, reason: "no-evidence" };
  }

  const fingerprint = fingerprintRun(figures);

  if (schedule.fingerprint === null) {
    return { fingerprint, figures, changed: false, reason: "first-run" };
  }
  if (schedule.fingerprint === fingerprint) {
    return { fingerprint, figures, changed: false, reason: "no-change" };
  }

  const previous = schedule.lastFigures ?? [];
  if (previous.length !== figures.length) {
    return { fingerprint, figures, changed: true, reason: "shape-changed" };
  }
  if (materiallyDifferent(previous, figures)) {
    return { fingerprint, figures, changed: true, reason: "figures-moved" };
  }

  // The hash moved but nothing moved enough to matter — the common case on a
  // live market, and the whole reason this is not a hash comparison.
  return { fingerprint, figures, changed: false, reason: "no-change" };
}

export function isDue(schedule: Schedule, now: Date): boolean {
  if (!schedule.enabled) return false;
  if (!schedule.lastRunAt) return true;
  const elapsed = now.getTime() - new Date(schedule.lastRunAt).getTime();
  if (elapsed < 0) return true;
  return elapsed >= schedule.intervalSec * 1000;
}
