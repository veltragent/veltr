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
   * The figures behind that fingerprint, under the names they were observed by.
   *
   * Kept alongside the hash because a hash can only answer "identical or not",
   * and the question that matters is "different enough to interrupt someone".
   */
  lastFigures: Figures;
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
 * Levels that moved by less than this are the same level.
 *
 * A price ticking from 226.06 to 226.09 between hourly runs is not news. Without
 * a threshold every schedule fires every run, because on a live market no figure
 * is ever byte-identical twice.
 */
export const MATERIAL_CHANGE = 0.02;

/**
 * How far a rate must move, in its own units, before it counts.
 *
 * Relative comparison is the wrong instrument for a figure that is *already* a
 * change. An hourly move of -0.0621% to -0.0538% is thirteen percent relative
 * and eight thousandths of a percentage point absolute: nothing happened, and a
 * purely relative rule reports it anyway. Since a run carries several such
 * figures — premium, dominance, 24h change — and one is enough to trip the
 * whole comparison, the relative rule alone makes a schedule fire on every run
 * on a dead-quiet market, which is precisely what it exists to prevent.
 *
 * So a rate must clear both bars: proportionally significant *and* an actual
 * quarter-point move.
 */
export const MATERIAL_RATE_POINTS = 0.25;

/** Figures keyed by where they appeared, so each is compared on its own terms. */
export type Figures = Record<string, number>;

/**
 * Keys whose value is itself a change, a share or a spread.
 *
 * Matched on the name because the tools name things consistently — `premiumPct`,
 * `exchangeChangePct`, `btcDominance` — and the name is the only thing that
 * distinguishes a ratio of 0.0177 from a token that genuinely trades at
 * $0.0177. Magnitude cannot: a memecoin doubling and a spread twitching look
 * identical to a rule that only sees "small number moved a lot".
 */
const RATE_WORDS = new Set([
  "pct",
  "percent",
  "percentage",
  "ratio",
  "premium",
  "dominance",
  "change",
  "spread",
  "apy",
  "apr",
  "yield",
  "share",
  "rate",
  "delta",
]);

/**
 * Matched whole-word, not as a substring.
 *
 * `exchangePrice` contains "change" — inside "exchange" — and a substring test
 * classifies the headline price of every equity here as a rate, which then
 * silences a cheap token doubling. The words are compared after splitting the
 * key on camel-case and separators.
 */
export function isRateKey(key: string): boolean {
  return key
    .split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/)
    .some((word) => RATE_WORDS.has(word.toLowerCase()));
}

const NUMBER_PATTERN = /-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g;

/** Timestamps and ids swamp everything else and never carry meaning here. */
function meaningful(n: number): boolean {
  return Number.isFinite(n) && Math.abs(n) < 1e11;
}

function walk(value: unknown, path: string, out: Figures, depth = 0): void {
  if (depth > 6 || Object.keys(out).length > 200) return;

  if (typeof value === "number") {
    if (meaningful(value)) out[path] = value;
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, `${path}[${i}]`, out, depth + 1));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === "__proto__") continue;
      walk(child, path ? `${path}.${key}` : key, out, depth + 1);
    }
  }
}

/**
 * Extracts the figures an observation contained, with the names they came under.
 *
 * The names are the point. An earlier version read the numbers out in order and
 * threw the keys away, which made every figure look like the same kind of
 * quantity and left no way to tell a price from a percentage.
 *
 * Evidence is a rendered tool result, so it is usually JSON and the keys are
 * right there. Prose, or anything that will not parse, falls back to position.
 */
export function extractFigures(text: string): Figures {
  const out: Figures = Object.create(null) as Figures;

  const trimmed = text.trim();
  for (const candidate of trimmed.split("\n")) {
    const start = candidate.search(/[{[]/);
    if (start === -1) continue;
    try {
      walk(JSON.parse(candidate.slice(start)), "", out, 0);
    } catch {
      // Not JSON after all; the positional pass below still sees it.
    }
  }

  if (Object.keys(out).length > 0) return out;

  const found = trimmed.match(NUMBER_PATTERN) ?? [];
  found
    .map(Number)
    .filter(meaningful)
    .slice(0, 200)
    .forEach((n, i) => {
      out[`#${i}`] = n;
    });

  return out;
}

/** Did this one figure move enough to matter, given what kind of figure it is? */
export function figureMoved(key: string, a: number, b: number, threshold = MATERIAL_CHANGE): boolean {
  if (a === b) return false;

  const scale = Math.max(Math.abs(a), Math.abs(b));
  // Near zero, relative change is meaningless in both directions.
  if (scale < 1e-9) return false;

  const relative = Math.abs(b - a) / scale;
  if (relative <= threshold) return false;

  // A rate must also have actually moved, not just moved proportionally.
  if (isRateKey(key)) return Math.abs(b - a) >= MATERIAL_RATE_POINTS;

  return true;
}

/**
 * Is the new reading materially different from the old one?
 *
 * Compared by name rather than by position, so a source that returns its fields
 * in a different order is not mistaken for a source that returned different
 * numbers. A change in *which* figures came back is itself worth reporting — it
 * usually means a source dropped out or a new one answered.
 */
export function materiallyDifferent(
  before: Figures,
  after: Figures,
  threshold = MATERIAL_CHANGE
): boolean {
  const keys = Object.keys(before);
  if (keys.length !== Object.keys(after).length) return true;

  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(after, key)) return true;
    if (figureMoved(key, before[key], after[key], threshold)) return true;
  }

  return false;
}

/** Stable identity for a set of observations. */
export function fingerprintRun(figures: Figures): string {
  const canonical = Object.keys(figures)
    .sort()
    .map((k) => `${k}=${figures[k]}`)
    .join(",");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

export type RunComparison = {
  fingerprint: string;
  figures: Figures;
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

  if (Object.keys(figures).length === 0) {
    return { fingerprint: "", figures, changed: false, reason: "no-evidence" };
  }

  const fingerprint = fingerprintRun(figures);

  // A baseline recorded before figures carried their names cannot be compared
  // against one that does. Re-baseline silently rather than report a change
  // that is really just a change of representation.
  const previous = schedule.lastFigures;
  const comparable = previous !== null && typeof previous === "object" && !Array.isArray(previous);

  if (schedule.fingerprint === null || !comparable) {
    return { fingerprint, figures, changed: false, reason: "first-run" };
  }
  if (schedule.fingerprint === fingerprint) {
    return { fingerprint, figures, changed: false, reason: "no-change" };
  }

  if (Object.keys(previous).length !== Object.keys(figures).length) {
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
