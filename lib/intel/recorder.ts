import { codexTopTokens } from "../codex";
import { listAllWatches } from "../watch/store";
import { recordSamples, type Sample } from "./baseline";
import { CHAIN_KEY } from "./pulse";

/**
 * Records what the market looked like, so that later it can be compared.
 *
 * This is the loop that makes anomaly detection possible at all. No provider
 * serving this chain sells history — there is no endpoint for last hour's
 * liquidity or yesterday's holder count — so a baseline exists only if something
 * writes one down. That is this.
 *
 * Cost is one ranked-listing call per tick, already cached and already used by
 * /chain and /pulse, plus one state write. It deliberately does not fetch
 * per-token detail: that would be one call per token per tick and would dominate
 * the entire product's provider budget to populate a table.
 */

/**
 * How often a reading is taken.
 *
 * Ten minutes against the two-day retention in baseline.ts gives roughly 288
 * samples per token, which is enough for a median and a spread to mean
 * something while keeping the state document small. Faster would sample the
 * same cached provider response repeatedly and record noise as if it were
 * observation.
 */
export const RECORD_INTERVAL_MS = 10 * 60_000;

/**
 * How many tokens carry history.
 *
 * The busiest by volume, plus everything any user actually watches — so a token
 * someone cares about is never missing a baseline just because it is quiet.
 */
export const TOP_N = 60;

export type RecordReport = {
  tokens: number;
  fromWatchlists: number;
  ranAt: string;
};

export async function recordBaselineTick(): Promise<RecordReport | null> {
  const { tokens } = await codexTopTokens("volume24", TOP_N);
  if (tokens.length === 0) return null;

  const now = Math.floor(Date.now() / 1000);
  const readings = tokens.map((t) => ({
    address: t.address,
    symbol: t.symbol,
    sample: {
      t: now,
      p: t.priceUsd,
      l: t.liquidityUsd,
      v: t.volume24Usd,
      h: t.holders,
    } satisfies Sample,
  }));

  /*
   * Watched tokens that fell outside the top list still need history, because
   * they are precisely the ones a user will ask about. They are already in the
   * ranked response most of the time; this only records the ones that are not,
   * and costs nothing extra when the sets overlap.
   */
  const watched = await listAllWatches().catch(() => []);
  const have = new Set(readings.map((r) => r.address.toLowerCase()));
  const missing = [...new Set(watched.map((w) => w.tokenAddress.toLowerCase()))].filter(
    (a) => !have.has(a)
  );

  // Chain-wide aggregate, so /pulse can report a trend rather than a level.
  const totalLiquidity = tokens.reduce((s, t) => s + (t.liquidityUsd ?? 0), 0);
  const totalVolume = tokens.reduce((s, t) => s + (t.volume24Usd ?? 0), 0);

  readings.push({
    address: CHAIN_KEY,
    symbol: "CHAIN",
    sample: { t: now, p: null, l: totalLiquidity || null, v: totalVolume || null, h: null },
  });

  await recordSamples(readings);

  return { tokens: readings.length, fromWatchlists: missing.length, ranAt: new Date().toISOString() };
}

/** Never throws — the scheduler calls this forever. */
export async function recordBaselineSafely(): Promise<RecordReport | null> {
  try {
    return await recordBaselineTick();
  } catch (error) {
    console.error("[veltr][INTEL] baseline record failed:", error instanceof Error ? error.message : error);
    return null;
  }
}
