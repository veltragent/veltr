import { cached } from "./cache";

/**
 * Forward calendar of announced stock splits, from Nasdaq's public API.
 *
 * This closes the product's worst gap. On-chain, a split is only visible once
 * `newUIMultiplier` is committed — a median of about ten minutes before it takes
 * effect, which is too short for a person to act on. Traditional markets
 * announce the same split weeks ahead. Reading the announcement turns a
 * ten-minute alarm into weeks of notice.
 *
 * No credential required. Chosen over FMP and Polygon for exactly that reason:
 * FMP gates the calendar's date range behind a paid plan, and its free window
 * returned a single already-past entry.
 */
const NASDAQ = "https://api.nasdaq.com/api/calendar/splits";

// Nasdaq rejects requests without a browser user agent.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export type AnnouncedSplit = {
  symbol: string;
  ratio: string;
  /** Multiplier the split applies, e.g. "4 : 1" -> 4. */
  factor: number | null;
  executionDate: string;
  announcedDate: string | null;
  daysUntil: number | null;
};

type NasdaqRow = {
  symbol: string;
  ratio: string;
  payableDate?: string;
  executionDate?: string;
  announcedDate?: string;
};

/**
 * Parses Nasdaq's ratio strings, which arrive in several shapes:
 * "4 : 1", "1.5:1", "1 : 15" (a reverse split).
 */
export function parseRatio(ratio: string): number | null {
  const match = ratio.match(/([\d.]+)\s*:\s*([\d.]+)/);
  if (!match) return null;
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  return numerator / denominator;
}

function toIso(usDate: string | undefined): string | null {
  if (!usDate) return null;
  // Nasdaq returns M/D/YYYY.
  const m = usDate.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return usDate;
  return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

async function fetchWindow(date: string): Promise<NasdaqRow[]> {
  try {
    const res = await fetch(`${NASDAQ}?date=${date}`, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return [];
    const json = await res.json();
    return (json?.data?.rows ?? []) as NasdaqRow[];
  } catch {
    return [];
  }
}

/**
 * Builds a forward calendar by sampling several anchor dates.
 *
 * Nasdaq returns a window around the requested date rather than an open-ended
 * range, so a handful of anchors spaced across the coming months is how the
 * horizon gets covered.
 */
export async function fetchAnnouncedSplits(): Promise<AnnouncedSplit[]> {
  return cached("nasdaq-splits", 30 * 60_000, async () => {
    const today = new Date();
    const anchors: string[] = [];
    for (let weeks = 0; weeks <= 12; weeks += 2) {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() + weeks * 7);
      anchors.push(d.toISOString().slice(0, 10));
    }

    const batches = await Promise.all(anchors.map(fetchWindow));

    const seen = new Map<string, AnnouncedSplit>();
    for (const rows of batches) {
      for (const row of rows) {
        const executionDate = toIso(row.executionDate ?? row.payableDate);
        if (!executionDate) continue;

        const key = `${row.symbol}-${executionDate}`;
        if (seen.has(key)) continue;

        const days = Math.round(
          (new Date(executionDate).getTime() - Date.now()) / 86_400_000
        );

        seen.set(key, {
          symbol: row.symbol,
          ratio: row.ratio,
          factor: parseRatio(row.ratio),
          executionDate,
          announcedDate: toIso(row.announcedDate),
          daysUntil: Number.isFinite(days) ? days : null,
        });
      }
    }

    return [...seen.values()].sort((a, b) => a.executionDate.localeCompare(b.executionDate));
  });
}

export type TokenSplitWarning = AnnouncedSplit & {
  tokenAddress: string;
  /** Fraction of pooled value arbitrage extracts if providers stay in the pool. */
  lpLossFraction: number;
};

/**
 * Matches announced splits against the stock tokens that exist on-chain.
 *
 * This is the whole point: a split announced for a ticker that has no token is
 * irrelevant here, and a split announced for one that does is a dated warning
 * for every liquidity provider in that pool.
 */
export function matchSplitsToTokens(
  splits: AnnouncedSplit[],
  tokens: { symbol: string; address: string }[]
): TokenSplitWarning[] {
  const bySymbol = new Map(tokens.map((t) => [t.symbol.toUpperCase(), t.address]));

  return splits
    .filter((s) => s.daysUntil !== null && s.daysUntil >= 0)
    .flatMap((split) => {
      const address = bySymbol.get(split.symbol.toUpperCase());
      if (!address) return [];
      const factor = split.factor ?? 1;
      const loss = factor > 0 ? 1 - (2 * Math.sqrt(factor)) / (1 + factor) : 0;
      return [{ ...split, tokenAddress: address, lpLossFraction: loss }];
    });
}
