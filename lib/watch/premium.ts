import { readPremium, resolveMarketOpen } from "../market";
import { UNLISTED_UNDERLYING } from "../premium-wall";
import { buildRadarSnapshot } from "../tokens";

/**
 * Premium readings for the watch cycle.
 *
 * The pool providers do not report premium — it is the token price measured
 * against the price of the actual share, which needs a second feed. That feed
 * is per symbol and rate-limited, and this cycle can tick every fifteen
 * seconds, so the whole file is arranged around asking for as few quotes as
 * possible.
 *
 * The largest saving is free: when the equity market is shut there is nothing
 * to compare against but the last close, no premium alert can fire, and so no
 * quote is read at all. That removes the cost overnight, at weekends and on
 * holidays — most of the week.
 */

export type PremiumReadingLite = {
  premiumPct: number | null;
  /** The share price it was measured against, so an alert can show its working. */
  equityPriceUsd: number | null;
  /** The equity market was shut, so the reference price is a stale close. */
  isStale: boolean;
};

export type PremiumDeps = {
  marketOpen: () => Promise<boolean>;
  resolveSymbol: (address: string) => Promise<string | null>;
  read: (symbol: string, address: string) => Promise<{ premiumPct: number | null; equityPriceUsd: number | null }>;
};

async function defaultDeps(): Promise<PremiumDeps> {
  return {
    marketOpen: resolveMarketOpen,
    resolveSymbol: async (address) => {
      // Cached for 30s and shared with the website, so this costs nothing.
      const snapshot = await buildRadarSnapshot();
      const match = snapshot.tokens.find((t) => t.address.toLowerCase() === address.toLowerCase());
      if (!match) return null;

      /**
       * A ticker whose underlying is not a listed US equity has no premium.
       *
       * A quote provider will happily return a price for SPCX, but SpaceX is
       * private — that price belongs to a different instrument entirely, and an
       * alert fired on it would be telling someone about a spread against a
       * security that is not the one they are holding.
       */
      if (UNLISTED_UNDERLYING.has(match.symbol.toUpperCase())) return null;

      return match.symbol;
    },
    read: (symbol, address) => readPremium(symbol, address),
  };
}

/**
 * Reads the premium for each address that someone is watching it on.
 *
 * Addresses that are not tokenised stocks are absent from the result rather
 * than present with a null — there is no premium for a token with no underlying,
 * and saying "unknown" would invite a caller to retry it every cycle forever.
 */
export async function fetchPremiums(
  addresses: string[],
  overrides: Partial<PremiumDeps> = {}
): Promise<Map<string, PremiumReadingLite>> {
  const deps: PremiumDeps = { ...(await defaultDeps()), ...overrides };
  const out = new Map<string, PremiumReadingLite>();
  if (addresses.length === 0) return out;

  const open = await deps.marketOpen().catch(() => false);

  if (!open) {
    // Marked stale without reading a single quote. The condition engine treats
    // stale as "do not fire and do not re-arm", so the alert resumes cleanly at
    // the open instead of firing on a spread that was never tradeable.
    for (const address of addresses) {
      out.set(address.toLowerCase(), { premiumPct: null, equityPriceUsd: null, isStale: true });
    }
    return out;
  }

  for (const address of addresses) {
    const key = address.toLowerCase();
    try {
      const symbol = await deps.resolveSymbol(key);
      if (!symbol) continue;

      const reading = await deps.read(symbol, key);
      out.set(key, { premiumPct: reading.premiumPct, equityPriceUsd: reading.equityPriceUsd, isStale: false });
    } catch {
      // One unreadable quote must not cost the rest of the cycle its alerts.
      continue;
    }
  }

  return out;
}
