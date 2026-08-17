import { mutateState } from "../store";

/**
 * Rolling metric history, recorded by us.
 *
 * This module exists because of a gap, not a preference. Anomaly detection needs
 * to know what normal looks like, and nothing serving this chain sells history:
 * Blockscout reports a holder count but not last week's, Codex reports liquidity
 * but not its trend, and its event feed reaches roughly two and a half hours back
 * before paging costs more than the answer is worth.
 *
 * So the only honest baseline is one we accumulate. A metric is compared against
 * its own recent distribution rather than a number somebody picked: "volume is
 * four standard deviations above this token's own median" survives a token whose
 * normal volume is a thousand dollars and one whose normal is a million, which no
 * fixed threshold does.
 *
 * The cost of that is a cold start. A token first seen an hour ago has no
 * distribution, and every function here reports that rather than inventing one —
 * `sufficient` is false and callers must degrade instead of asserting.
 */

/** One observation of one token. */
export type Sample = {
  /** Unix seconds. */
  t: number;
  /** Price in USD. */
  p: number | null;
  /** Liquidity in USD. */
  l: number | null;
  /** Rolling 24h volume in USD. */
  v: number | null;
  /** Holder count. */
  h: number | null;
};

export type Series = { address: string; symbol: string | null; samples: Sample[] };

/**
 * How much history is kept per token.
 *
 * At one sample every ten minutes this is about two days, which is the span that
 * matters for "is this unusual for this token" while staying small enough that
 * the whole set of watched tokens fits in a state document that gets written
 * whole. Anything longer belongs in a time-series store, not here.
 */
export const MAX_SAMPLES = 288;

/**
 * Samples needed before a comparison is allowed to mean anything.
 *
 * Twelve at a ten-minute cadence is two hours. Below that the median and spread
 * are dominated by whichever few readings happened to land, and an "anomaly"
 * would mostly be detecting its own lack of data.
 */
export const MIN_SAMPLES = 12;

export type BaselineStore = Record<string, Series>;

/* ----------------------------------------------------------- Statistics */

export function median(values: number[]): number | null {
  const clean = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (clean.length === 0) return null;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
}

/**
 * Median absolute deviation, scaled to be comparable to a standard deviation.
 *
 * Used instead of a standard deviation because the thing being measured is
 * outliers, and a standard deviation is moved by the very spike it is supposed to
 * be measuring against. One 50× volume print raises the mean and the deviation
 * together, so the spike scores as ordinary. The median barely moves, which is
 * the entire reason for choosing it.
 *
 * The 1.4826 factor makes MAD equal σ for normally distributed data, so a
 * threshold expressed in "sigmas" keeps its usual meaning.
 */
export function mad(values: number[]): number | null {
  const m = median(values);
  if (m === null) return null;
  const deviations = values.filter((v) => Number.isFinite(v)).map((v) => Math.abs(v - m));
  const raw = median(deviations);
  return raw === null ? null : raw * 1.4826;
}

export type Deviation = {
  /** How far the current value sits from the median, in robust sigmas. */
  sigma: number | null;
  /** Percent change against the median. */
  pct: number | null;
  median: number | null;
  /** False when there is not enough history to judge. Callers must respect this. */
  sufficient: boolean;
  samples: number;
};

const INSUFFICIENT = (samples: number): Deviation => ({
  sigma: null,
  pct: null,
  median: null,
  sufficient: false,
  samples,
});

/**
 * Where a current reading sits against a token's own recent history.
 *
 * Returns nulls with `sufficient: false` rather than zeros when history is thin.
 * A zero would read as "perfectly normal" and is the most dangerous possible
 * answer here: it would silence a real anomaly on a token we simply had not been
 * watching long enough to know.
 */
export function deviation(history: number[], current: number | null): Deviation {
  const clean = history.filter((v): v is number => Number.isFinite(v));
  if (current === null || !Number.isFinite(current)) return INSUFFICIENT(clean.length);
  if (clean.length < MIN_SAMPLES) return INSUFFICIENT(clean.length);

  const m = median(clean);
  const spread = mad(clean);
  if (m === null) return INSUFFICIENT(clean.length);

  const pct = m !== 0 ? ((current - m) / Math.abs(m)) * 100 : null;

  /*
   * A spread of zero is a flat metric, not a certainty.
   *
   * Dividing by it gives Infinity, which would make any change at all — one
   * dollar of volume on a token that has traded nothing — the largest anomaly
   * the system can report. Flat history with a change is reported as a
   * percentage move and no sigma.
   */
  const sigma = spread && spread > 0 ? (current - m) / spread : null;

  return { sigma, pct, median: m, sufficient: true, samples: clean.length };
}

/* -------------------------------------------------------------- Storage */

/**
 * Ceiling on how many tokens carry history.
 *
 * The state document is read, modified and written whole, so this bounds the
 * file rather than the concept. Tokens are dropped oldest-observation-first,
 * which keeps whatever is actively being watched and lets a token nobody has
 * asked about in two days fall out.
 */
export const MAX_TRACKED_TOKENS = 150;

/**
 * Adds one observation per token and trims to the window.
 *
 * Merges into whatever is on disk rather than replacing it: the recorder and the
 * on-demand paths both write here, and a blind overwrite would drop the history
 * of every token the current caller did not happen to be looking at.
 */
export async function recordSamples(
  readings: Array<{ address: string; symbol: string | null; sample: Sample }>
): Promise<void> {
  if (readings.length === 0) return;

  await mutateState((state) => {
    const store: BaselineStore = { ...(state.intelBaselines ?? {}) };

    for (const { address, symbol, sample } of readings) {
      const key = address.toLowerCase();
      const existing = store[key];
      const samples = [...(existing?.samples ?? []), sample].slice(-MAX_SAMPLES);
      store[key] = { address: key, symbol: symbol ?? existing?.symbol ?? null, samples };
    }

    const keys = Object.keys(store);
    if (keys.length > MAX_TRACKED_TOKENS) {
      const byRecency = keys.sort(
        (a, b) => (store[b].samples.at(-1)?.t ?? 0) - (store[a].samples.at(-1)?.t ?? 0)
      );
      for (const stale of byRecency.slice(MAX_TRACKED_TOKENS)) delete store[stale];
    }

    return { state: { ...state, intelBaselines: store }, result: undefined };
  });
}

export function seriesFrom(store: BaselineStore | undefined, address: string): Series | null {
  return store?.[address.toLowerCase()] ?? null;
}

/** Pulls one metric out of a series, oldest first, dropping gaps. */
export function metric(series: Series | null, field: keyof Omit<Sample, "t">): number[] {
  if (!series) return [];
  return series.samples.map((s) => s[field]).filter((v): v is number => v !== null && Number.isFinite(v));
}

/**
 * Change over a window, measured against the oldest sample inside it.
 *
 * Separate from `deviation` because the two answer different questions. This one
 * is "how much has it moved since an hour ago", which is what a reader wants in a
 * sentence; deviation is "is that unusual for this token", which is what decides
 * whether to say anything at all.
 */
export function changeOver(
  series: Series | null,
  field: keyof Omit<Sample, "t">,
  windowSec: number,
  now = Math.floor(Date.now() / 1000)
): { pct: number | null; from: number | null; to: number | null; spanSec: number | null } {
  const none = { pct: null, from: null, to: null, spanSec: null };
  if (!series || series.samples.length < 2) return none;

  const inWindow = series.samples.filter((s) => s.t >= now - windowSec && s[field] !== null);
  if (inWindow.length < 2) return none;

  const from = inWindow[0][field] as number;
  const to = inWindow[inWindow.length - 1][field] as number;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === 0) {
    return { pct: null, from, to, spanSec: inWindow[inWindow.length - 1].t - inWindow[0].t };
  }

  return {
    pct: ((to - from) / Math.abs(from)) * 100,
    from,
    to,
    spanSec: inWindow[inWindow.length - 1].t - inWindow[0].t,
  };
}

export function readBaselines(state: { intelBaselines?: BaselineStore } | null): BaselineStore {
  return state?.intelBaselines ?? {};
}
