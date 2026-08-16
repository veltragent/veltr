import { cached } from "./cache";
import { buildRadarSnapshot } from "./tokens";
import { fetchEquityQuote } from "./market";
import { fetchMarketStatus } from "./stocks";

/**
 * Premium for every stock token on the chain.
 *
 * The on-chain price comes from the snapshot that is already loaded, so the only
 * new work is one equity quote per ticker. Ninety-five sequential fetches would
 * take minutes, so they run with bounded concurrency — bounded rather than
 * unbounded because firing ninety-five simultaneous requests at an
 * unauthenticated endpoint is how a source starts refusing you.
 */

const CONCURRENCY = 10;

/**
 * Tickers whose underlying is not a listed US equity. A quote provider will
 * happily return a price for SPCX, but SpaceX is private — that price belongs to
 * a different instrument, and a premium computed against it is fiction.
 */
export const UNLISTED_UNDERLYING = new Set(["SPCX"]);

/**
 * Depth a pool needs before its price is worth comparing to a share.
 *
 * A premium is a claim about what the market pays. In a constant-product pool
 * holding $10,000, a $250 trade moves the price five percent — so below this,
 * the "premium" is one small trade, not a market, and reporting it as a spread
 * invites someone to act on nothing.
 *
 * Measured, not guessed: of the fifty-six tokens with a pool, twenty-two hold
 * less than this and several hold a few hundred dollars. Those were producing
 * the widest numbers on the board — NVTS at +56% on $390 of liquidity, POET at
 * +43% on $140 with no trades at all — which put dust at the top of a page
 * whose whole purpose is to show real dislocation. SNDK, genuinely 25% below
 * its share, holds $455k and is unaffected.
 */
export const MIN_POOL_LIQUIDITY_USD = 10_000;

export type WallRow = {
  symbol: string;
  name: string;
  address: string;
  iconUrl: string | null;
  holders: number;
  multiplier: number;
  tokenPriceUsd: number | null;
  equityPriceUsd: number | null;
  premiumPct: number | null;
  marketCapUsd: number | null;
  volume24hUsd: number | null;
  unlisted: boolean;
};

export type PremiumWall = {
  rows: WallRow[];
  marketOpen: boolean;
  stats: {
    tracked: number;
    priced: number;
    averagePremiumPct: number | null;
    medianAbsPremiumPct: number | null;
    widest: WallRow | null;
    tightest: WallRow | null;
    aboveCount: number;
    belowCount: number;
  };
  generatedAt: string;
};

async function mapWithLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      out[index] = await fn(items[index]);
    }
  });

  await Promise.all(workers);
  return out;
}

export async function buildPremiumWall(): Promise<PremiumWall> {
  return cached(
    "premium-wall",
    60_000,
    async () => {
      const [snapshot, status] = await Promise.all([
        buildRadarSnapshot(),
        fetchMarketStatus().catch(() => null),
      ]);

      const rows = await mapWithLimit(snapshot.tokens, CONCURRENCY, async (t): Promise<WallRow> => {
        const unlisted = UNLISTED_UNDERLYING.has(t.symbol.toUpperCase());
        const equity = unlisted ? null : await fetchEquityQuote(t.symbol).catch(() => null);

        const tokenPrice = t.priceUsd;
        const equityPrice = equity?.price ?? null;

        return {
          symbol: t.symbol,
          name: t.name,
          address: t.address,
          iconUrl: t.iconUrl,
          holders: t.holders,
          multiplier: t.multiplier,
          tokenPriceUsd: tokenPrice,
          equityPriceUsd: equityPrice,
          /**
           * A premium needs a market price, not just a price.
           *
           * Thirty-eight of the ninety-five tokens trade in no indexed pool at
           * all. The only price they have is Blockscout's, and sampled against
           * the shares themselves it lands within a few percent every time —
           * because it is derived from them. A "premium" computed from that is
           * very nearly the share divided by itself: it says nothing about what
           * anyone would pay on chain, and where the derivation goes wrong it
           * says something false and loud. CRWD, whose entire raw supply is one
           * token, was being published at a premium of +291%.
           *
           * So the gap is only reported where there is a pool to have set the
           * price. The token price is still shown; what is withheld is the
           * comparison, which is the number that would have been believed.
           */
          premiumPct:
            !unlisted &&
            t.priceSource === "dex" &&
            (t.liquidityUsd ?? 0) >= MIN_POOL_LIQUIDITY_USD &&
            tokenPrice !== null &&
            equityPrice !== null &&
            equityPrice > 0
              ? (tokenPrice / equityPrice - 1) * 100
              : null,
          marketCapUsd: t.marketCap,
          volume24hUsd: t.volume24h,
          unlisted,
        };
      });

      const priced = rows.filter((r) => r.premiumPct !== null);
      const sortedByAbs = [...priced].sort(
        (a, b) => Math.abs(b.premiumPct!) - Math.abs(a.premiumPct!)
      );
      const absValues = priced.map((r) => Math.abs(r.premiumPct!)).sort((a, b) => a - b);

      return {
        rows: rows.sort((a, b) => {
          // Priced rows first, widest dislocation at the top — the reason
          // someone opened this page.
          if (a.premiumPct === null && b.premiumPct === null) return b.holders - a.holders;
          if (a.premiumPct === null) return 1;
          if (b.premiumPct === null) return -1;
          return Math.abs(b.premiumPct) - Math.abs(a.premiumPct);
        }),
        marketOpen: status?.isOpen ?? false,
        stats: {
          tracked: rows.length,
          priced: priced.length,
          averagePremiumPct:
            priced.length > 0 ? priced.reduce((s, r) => s + r.premiumPct!, 0) / priced.length : null,
          medianAbsPremiumPct:
            absValues.length > 0
              ? absValues.length % 2
                ? absValues[(absValues.length - 1) / 2]
                : (absValues[absValues.length / 2 - 1] + absValues[absValues.length / 2]) / 2
              : null,
          widest: sortedByAbs[0] ?? null,
          tightest: sortedByAbs[sortedByAbs.length - 1] ?? null,
          aboveCount: priced.filter((r) => r.premiumPct! > 0).length,
          belowCount: priced.filter((r) => r.premiumPct! < 0).length,
        },
        generatedAt: new Date().toISOString(),
      };
    },
    (v) => v.rows.length > 0
  );
}
