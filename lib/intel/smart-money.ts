import { codexFlowWindow, type CodexSwap } from "../codex";
import { blend, clamp, confidencePct, ramp, type Score } from "./score";

/**
 * Wallet scoring and accumulation detection.
 *
 * The brief asked not to call a wallet "smart money" without grounds, and the
 * data available here sets a hard limit on what can be grounded. The event feed
 * reaches roughly two and a half hours back before paging costs more than the
 * answer is worth, so this module can see *current behaviour* and cannot see
 * *track record*. Realised profit, win rate over months, whether a wallet has
 * been early before — none of that is obtainable at a price this bot can pay per
 * query, and none of it is claimed.
 *
 * What is left is still worth having, but it is a narrower claim, and the naming
 * follows the claim rather than the marketing: these are ACTIVE wallets ranked by
 * how they are trading right now, not proven winners. The output says
 * "accumulating" — an observation — rather than "smart", which would be a verdict
 * the evidence does not support.
 */

/** Trades below this are dust and mostly noise from routers and bots. */
export const MIN_TRADE_USD = 50;

/**
 * A wallet needs at least this many trades in the window to be scored.
 *
 * One trade is not behaviour. It is also the single most common way a scoring
 * system fools itself: the largest buy in a window is always somebody's first
 * and only trade, and ranking on it surfaces a stranger every time.
 */
export const MIN_TRADES = 2;

export type WalletActivity = {
  address: string;
  buys: number;
  sells: number;
  buyUsd: number;
  sellUsd: number;
  /** Positive when the wallet is a net buyer over the window. */
  netUsd: number;
  largestUsd: number;
  firstSeen: number;
  lastSeen: number;
};

export type ScoredWallet = WalletActivity & {
  score: Score;
  /** What the score is actually saying, in one word. */
  stance: "accumulating" | "distributing" | "mixed";
};

/** Groups a flow window into per-wallet behaviour. */
export function aggregateWallets(swaps: CodexSwap[]): WalletActivity[] {
  const byWallet = new Map<string, WalletActivity>();

  for (const s of swaps) {
    if (!s.maker || s.valueUsd === null || s.valueUsd < MIN_TRADE_USD) continue;
    if (s.side !== "buy" && s.side !== "sell") continue;

    const existing = byWallet.get(s.maker) ?? {
      address: s.maker,
      buys: 0,
      sells: 0,
      buyUsd: 0,
      sellUsd: 0,
      netUsd: 0,
      largestUsd: 0,
      firstSeen: s.timestamp,
      lastSeen: s.timestamp,
    };

    if (s.side === "buy") {
      existing.buys++;
      existing.buyUsd += s.valueUsd;
    } else {
      existing.sells++;
      existing.sellUsd += s.valueUsd;
    }

    existing.netUsd = existing.buyUsd - existing.sellUsd;
    existing.largestUsd = Math.max(existing.largestUsd, s.valueUsd);
    existing.firstSeen = Math.min(existing.firstSeen, s.timestamp);
    existing.lastSeen = Math.max(existing.lastSeen, s.timestamp);

    byWallet.set(s.maker, existing);
  }

  return [...byWallet.values()];
}

/**
 * How notable a wallet's current behaviour is, relative to the others trading.
 *
 * Scored against the window's own distribution rather than fixed dollar
 * amounts, so the same code works on a token where $500 is a large trade and one
 * where it is noise. `medianTradeUsd` is what makes that relative.
 */
export function scoreWallet(w: WalletActivity, medianTradeUsd: number): ScoredWallet {
  const trades = w.buys + w.sells;

  // Size, measured in multiples of what a typical trade in this token looks like.
  const sizeRatio = medianTradeUsd > 0 ? Math.abs(w.netUsd) / medianTradeUsd : null;
  const size = sizeRatio === null ? null : ramp(Math.log10(Math.max(sizeRatio, 0.1)), 0, 2);

  // Conviction: one-directional trading scores above churning both ways.
  const gross = w.buyUsd + w.sellUsd;
  const directional = gross > 0 ? (Math.abs(w.netUsd) / gross) * 100 : null;

  // Repetition. Buying repeatedly is a decision; buying once may be a transfer.
  const persistence = ramp(trades, MIN_TRADES, 8);

  const score = blend([
    { label: "size", score: size, weight: 3 },
    { label: "conviction", score: directional, weight: 2 },
    { label: "persistence", score: persistence, weight: 2 },
  ]);

  const stance: ScoredWallet["stance"] =
    directional !== null && directional < 25 ? "mixed" : w.netUsd > 0 ? "accumulating" : "distributing";

  return { ...w, score, stance };
}

export type SmartMoneyRead = {
  address: string;
  symbol: string | null;
  /** Wallets that met the bar, strongest first. */
  wallets: ScoredWallet[];
  accumulating: ScoredWallet[];
  distributing: ScoredWallet[];
  /** Net USD across every scored wallet. */
  netFlowUsd: number;
  buyUsd: number;
  sellUsd: number;
  /** Distinct wallets that traded at all in the window. */
  activeWallets: number;
  medianTradeUsd: number | null;
  /** Hours the window actually covered — the honest span, not the one asked for. */
  windowHours: number;
  /** True when older trades exist that were not read. */
  truncated: boolean;
  verdict: "accumulation" | "distribution" | "balanced" | "insufficient";
  confidence: number;
};

export type SmartMoneyThresholds = {
  /** Wallets scoring at or above this are reported. */
  minWalletScore: number;
  /** Wallets needed on one side before a verdict is called. */
  minWallets: number;
  /** Net flow, in dollars, below which a lean is not worth reporting. */
  minNetUsd: number;
};

export const DEFAULT_SMART_MONEY: SmartMoneyThresholds = {
  minWalletScore: 55,
  minWallets: 2,
  minNetUsd: 5_000,
};

/**
 * Reads current wallet behaviour in one token.
 *
 * `verdict` is deliberately conservative and has an "insufficient" state that is
 * used often. A window with four trades in it can be described but not
 * concluded from, and saying so is the difference between an intelligence
 * product and a random number generator with confident formatting.
 */
export async function readSmartMoney(
  address: string,
  symbol: string | null,
  thresholds: SmartMoneyThresholds = DEFAULT_SMART_MONEY
): Promise<SmartMoneyRead> {
  const window = await codexFlowWindow(address, { hours: 6 });
  return analyseFlow(address, symbol, window.swaps, window.spanSec, window.truncated, thresholds);
}

/** The pure half, so the whole verdict path is testable without a network. */
export function analyseFlow(
  address: string,
  symbol: string | null,
  swaps: CodexSwap[],
  spanSec: number,
  truncated: boolean,
  thresholds: SmartMoneyThresholds = DEFAULT_SMART_MONEY
): SmartMoneyRead {
  const sized = swaps
    .filter((s) => s.valueUsd !== null && s.valueUsd >= MIN_TRADE_USD)
    .map((s) => s.valueUsd as number)
    .sort((a, b) => a - b);

  const medianTradeUsd = sized.length ? sized[Math.floor(sized.length / 2)] : null;

  const activity = aggregateWallets(swaps).filter((w) => w.buys + w.sells >= MIN_TRADES);
  const scored = activity
    .map((w) => scoreWallet(w, medianTradeUsd ?? 0))
    .filter((w) => w.score.value !== null)
    .sort((a, b) => (b.score.value ?? 0) - (a.score.value ?? 0));

  const notable = scored.filter((w) => (w.score.value ?? 0) >= thresholds.minWalletScore);
  const accumulating = notable.filter((w) => w.stance === "accumulating");
  const distributing = notable.filter((w) => w.stance === "distributing");

  const buyUsd = scored.reduce((s, w) => s + w.buyUsd, 0);
  const sellUsd = scored.reduce((s, w) => s + w.sellUsd, 0);
  const netFlowUsd = buyUsd - sellUsd;

  const distinct = new Set(swaps.map((s) => s.maker).filter(Boolean)).size;

  /*
   * Confidence is built from how much the window actually contained, not from
   * how clear the answer looks. A one-sided read off six trades is a weak
   * finding that happens to be tidy, and presenting it at high confidence is
   * exactly the failure this whole module is written to avoid.
   */
  const evidence = blend([
    { label: "trades", score: ramp(sized.length, 5, 60), weight: 3 },
    { label: "wallets", score: ramp(distinct, 3, 25), weight: 2 },
    { label: "window", score: ramp(spanSec / 3600, 0.5, 6), weight: 1 },
  ]);

  /*
   * A verdict needs the wallet count and the money to agree.
   *
   * Net flow alone is not enough: one large buyer against six sellers nets
   * positive and is not accumulation, it is one buyer. Requiring the side to
   * also outnumber the other is what stops a single wallet being reported as a
   * crowd — which was the first thing this produced when it only checked the
   * dollar total.
   */
  let verdict: SmartMoneyRead["verdict"] = "insufficient";
  if (evidence.value !== null && evidence.value >= 30 && Math.abs(netFlowUsd) >= thresholds.minNetUsd) {
    const buyersLead = accumulating.length >= thresholds.minWallets && accumulating.length > distributing.length;
    const sellersLead = distributing.length >= thresholds.minWallets && distributing.length > accumulating.length;

    if (buyersLead && netFlowUsd > 0) verdict = "accumulation";
    else if (sellersLead && netFlowUsd < 0) verdict = "distribution";
    else verdict = "balanced";
  } else if (sized.length > 0) {
    verdict = "balanced";
  }

  // A verdict off a partial window is real but less certain than a complete one.
  const confidence = confidencePct(((evidence.value ?? 0) / 100) * (truncated ? 0.85 : 1));

  return {
    address: address.toLowerCase(),
    symbol,
    wallets: notable.slice(0, 8),
    accumulating,
    distributing,
    netFlowUsd,
    buyUsd,
    sellUsd,
    activeWallets: distinct,
    medianTradeUsd,
    windowHours: spanSec / 3600,
    truncated,
    verdict: sized.length === 0 ? "insufficient" : verdict,
    confidence: sized.length === 0 ? 0 : clamp(confidence, 0, 95),
  };
}
