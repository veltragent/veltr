import { codexFlowWindow } from "../codex";
import { clamp, confidencePct, ramp } from "./score";

/**
 * Which tokens are being traded by the same wallets.
 *
 * The claim this makes is deliberately narrow: that a set of addresses appears
 * in both tokens' recent flow. It does not claim those addresses belong to the
 * same person, that one token's move caused the other's, or that anyone is
 * rotating capital on purpose. Common funding analysis — following where wallets
 * were first funded from — would support a stronger claim, and is not done here
 * because tracing funding for hundreds of addresses is far beyond what the
 * available endpoints will serve per query.
 *
 * Overlap is still the useful half. When the same wallets show up buying two
 * thin tokens within the same window, that is worth seeing, whatever the reason.
 */

export type Overlap = {
  a: { address: string; symbol: string | null; wallets: number };
  b: { address: string; symbol: string | null; wallets: number };
  /** Wallets present in both windows. */
  shared: string[];
  /** Shared as a share of the smaller set — the honest denominator. */
  overlapPct: number | null;
  /** Wallets that traded both within an hour of each other. */
  nearSimultaneous: number;
  /** Wallets that bought both rather than merely touching both. */
  sharedBuyers: number;
  /** 0–100. */
  strength: number;
  confidence: number;
  windowHours: number;
  /** Stated on every result: an address is not an identity. */
  caveat: string;
};

export const CAVEAT =
  "Overlap means the same addresses traded both tokens. It does not establish common ownership, coordination, or that one token's move affected the other.";

/** Trades below this are dust and would inflate every overlap with router noise. */
const MIN_TRADE_USD = 50;

type Side = Map<string, { bought: boolean; at: number }>;

function walletsOf(swaps: Awaited<ReturnType<typeof codexFlowWindow>>["swaps"]): Side {
  const out: Side = new Map();
  for (const s of swaps) {
    if (!s.maker || (s.valueUsd ?? 0) < MIN_TRADE_USD) continue;
    const existing = out.get(s.maker);
    out.set(s.maker, {
      bought: (existing?.bought ?? false) || s.side === "buy",
      at: Math.max(existing?.at ?? 0, s.timestamp),
    });
  }
  return out;
}

/** Pure, so the whole relationship calculation is testable without a network. */
export function compareFlows(
  a: { address: string; symbol: string | null; wallets: Side },
  b: { address: string; symbol: string | null; wallets: Side },
  windowHours: number,
  nearWindowSec = 3600
): Overlap {
  const shared: string[] = [];
  let nearSimultaneous = 0;
  let sharedBuyers = 0;

  for (const [wallet, left] of a.wallets) {
    const right = b.wallets.get(wallet);
    if (!right) continue;
    shared.push(wallet);
    if (Math.abs(left.at - right.at) <= nearWindowSec) nearSimultaneous++;
    if (left.bought && right.bought) sharedBuyers++;
  }

  /*
   * Denominator is the smaller side.
   *
   * Against the union, a token with three traders overlapping fully with one
   * that has three thousand would score near zero — when in fact every wallet in
   * the small token is also in the large one, which is the interesting case.
   */
  const smaller = Math.min(a.wallets.size, b.wallets.size);
  const overlapPct = smaller > 0 ? (shared.length / smaller) * 100 : null;

  /*
   * Strength leans on the qualified counts rather than the raw one. Two wallets
   * that bought both tokens within the hour say far more than twenty that
   * happened to touch each at some point in six hours.
   */
  const strength = clamp(
    (ramp(overlapPct, 0, 60) ?? 0) * 0.4 +
      (ramp(sharedBuyers, 0, 10) ?? 0) * 0.35 +
      (ramp(nearSimultaneous, 0, 8) ?? 0) * 0.25
  );

  return {
    a: { address: a.address, symbol: a.symbol, wallets: a.wallets.size },
    b: { address: b.address, symbol: b.symbol, wallets: b.wallets.size },
    shared,
    overlapPct,
    nearSimultaneous,
    sharedBuyers,
    strength: Math.round(strength),
    // Confidence scales with how many wallets there were to compare at all.
    confidence: confidencePct(Math.min(smaller / 40, 1)),
    windowHours,
    caveat: CAVEAT,
  };
}

/** Compares two tokens' recent flow. Two provider reads, both cached. */
export async function tokenRelationship(
  a: { address: string; symbol: string | null },
  b: { address: string; symbol: string | null }
): Promise<Overlap> {
  const [left, right] = await Promise.all([
    codexFlowWindow(a.address, { hours: 6 }).catch(() => ({ swaps: [], spanSec: 0, truncated: false })),
    codexFlowWindow(b.address, { hours: 6 }).catch(() => ({ swaps: [], spanSec: 0, truncated: false })),
  ]);

  const hours = Math.min(left.spanSec, right.spanSec) / 3600;

  return compareFlows(
    { ...a, wallets: walletsOf(left.swaps) },
    { ...b, wallets: walletsOf(right.swaps) },
    hours
  );
}

/**
 * The tokens most related to one, out of a candidate set.
 *
 * Bounded hard. Each candidate costs a flow read, so this is capped at a handful
 * rather than run across the chain — a full pairwise matrix would be thousands
 * of provider calls for one command.
 */
export const MAX_CANDIDATES = 6;

/**
 * Quote assets, excluded from candidacy.
 *
 * Overlap with these is structural rather than informative: every pool on the
 * chain is priced in one of them, so every token "shares wallets" with USDG and
 * WETH by construction. Left in, they crowded out the top of the results and
 * turned a genuine finding into a restatement of how an AMM works.
 */
export const QUOTE_SYMBOLS = new Set(["USDG", "WETH", "ETH", "USDC", "USDT", "DAI", "WBTC"]);

export async function relatedTokens(
  subject: { address: string; symbol: string | null },
  candidates: Array<{ address: string; symbol: string | null }>
): Promise<Overlap[]> {
  const pool = candidates
    .filter(
      (c) =>
        c.address.toLowerCase() !== subject.address.toLowerCase() &&
        !QUOTE_SYMBOLS.has((c.symbol ?? "").toUpperCase())
    )
    .slice(0, MAX_CANDIDATES);

  const base = await codexFlowWindow(subject.address, { hours: 6 }).catch(() => ({
    swaps: [],
    spanSec: 0,
    truncated: false,
  }));
  const subjectWallets = walletsOf(base.swaps);
  if (subjectWallets.size === 0) return [];

  const results = await Promise.all(
    pool.map(async (c) => {
      const flow = await codexFlowWindow(c.address, { hours: 6 }).catch(() => ({
        swaps: [],
        spanSec: 0,
        truncated: false,
      }));
      return compareFlows(
        { ...subject, wallets: subjectWallets },
        { ...c, wallets: walletsOf(flow.swaps) },
        Math.min(base.spanSec, flow.spanSec) / 3600
      );
    })
  );

  return results.filter((r) => r.shared.length > 0).sort((x, y) => y.strength - x.strength);
}
