import { mutateState } from "../store";
import type { Anomaly, AnomalyReport } from "./anomaly";
import type { SmartMoneyRead } from "./smart-money";

/**
 * One vocabulary for everything the intelligence layer can say.
 *
 * Every detector — anomaly, flow, corporate action — produces a Signal, and the
 * delivery path knows only about Signals. That is what lets the watch engine,
 * the daily brief and the AI tools all consume new detectors without any of
 * them being changed when one is added.
 *
 * Signals carry confidence separately from strength on purpose. "Volume is
 * eight sigma above normal, and we have two hours of history" is a real finding
 * with a real caveat, and collapsing those into one number loses the half a
 * reader needs to decide whether to act.
 */

export type SignalKind =
  | "smart_money"
  | "volume_spike"
  | "liquidity_change"
  | "whale_activity"
  | "momentum"
  | "holder_growth"
  | "risk_change"
  | "anomaly"
  | "new_pool"
  | "token_rotation"
  | "security_change";

export const SIGNAL_KINDS: SignalKind[] = [
  "smart_money",
  "volume_spike",
  "liquidity_change",
  "whale_activity",
  "momentum",
  "holder_growth",
  "risk_change",
  "anomaly",
  "new_pool",
  "token_rotation",
  "security_change",
];

export const SIGNAL_LABELS: Record<SignalKind, string> = {
  smart_money: "Smart Money",
  volume_spike: "Volume Spike",
  liquidity_change: "Liquidity Change",
  whale_activity: "Whale Activity",
  momentum: "Momentum",
  holder_growth: "Holder Growth",
  risk_change: "Risk Change",
  anomaly: "Anomaly",
  new_pool: "New Pool",
  token_rotation: "Token Rotation",
  security_change: "Security",
};

export type Signal = {
  kind: SignalKind;
  address: string;
  symbol: string | null;
  /** Short headline, e.g. "SMART MONEY ACCUMULATION". */
  title: string;
  /** 0–100 — how pronounced. */
  strength: number;
  /** 0–95 — how well evidenced. Never 100; see score.ts. */
  confidence: number;
  /** Checkable facts behind it. Rendered as-is; never model-written. */
  facts: string[];
  /** Unix seconds. */
  at: number;
};

/* ------------------------------------------------------------ Derivation */

const ANOMALY_TO_SIGNAL: Record<Anomaly["kind"], SignalKind> = {
  volume_spike: "volume_spike",
  price_move: "momentum",
  liquidity_surge: "liquidity_change",
  liquidity_drain: "liquidity_change",
  buy_pressure: "anomaly",
  sell_pressure: "anomaly",
  holder_growth: "holder_growth",
  whale_trade: "whale_activity",
};

const money = (v: number) => `$${Math.round(Math.abs(v)).toLocaleString()}`;

/** Turns a smart-money read into a signal, or nothing when it says nothing. */
export function signalFromSmartMoney(read: SmartMoneyRead, now = Math.floor(Date.now() / 1000)): Signal | null {
  if (read.verdict !== "accumulation" && read.verdict !== "distribution") return null;

  const side = read.verdict === "accumulation" ? read.accumulating : read.distributing;

  return {
    kind: "smart_money",
    address: read.address,
    symbol: read.symbol,
    title: read.verdict === "accumulation" ? "SMART MONEY ACCUMULATION" : "SMART MONEY DISTRIBUTION",
    // Wallet agreement is what makes this more than one trader's opinion.
    strength: Math.min(100, 40 + side.length * 12),
    confidence: read.confidence,
    facts: [
      `${side.length} of ${read.wallets.length} notable wallets ${read.verdict === "accumulation" ? "accumulated" : "sold"}`,
      `Net flow ${read.netFlowUsd >= 0 ? "+" : "−"}${money(read.netFlowUsd)} across ${read.activeWallets} active wallets`,
      `Window ${read.windowHours.toFixed(1)}h${read.truncated ? " (older trades not read)" : ""}`,
    ],
    at: now,
  };
}

export function signalsFromAnomalies(
  report: AnomalyReport,
  now = Math.floor(Date.now() / 1000)
): Signal[] {
  return report.anomalies.map((a) => ({
    kind: ANOMALY_TO_SIGNAL[a.kind],
    address: report.address,
    symbol: report.symbol,
    title: a.kind.replace(/_/g, " ").toUpperCase(),
    strength: a.score,
    confidence: a.confidence,
    facts: [
      a.detail,
      a.sigma !== null ? `${Math.abs(a.sigma).toFixed(1)}σ from this token's own median` : null,
      report.hasBaseline ? `Compared against ${report.samples} recorded readings` : "No recorded history yet",
    ].filter((f): f is string => f !== null),
    at: now,
  }));
}

/* -------------------------------------------------------------- Cooldown */

/**
 * Per-user, per-token, per-kind silence.
 *
 * Distinct from the watch engine's threshold re-arm, which restores itself when
 * a value retreats back through a band. A signal has no band to retreat through
 * — accumulation can simply stay true for hours — so the only thing that stops
 * it repeating every cycle is time.
 */
export const DEFAULT_SIGNAL_COOLDOWN_SEC = 6 * 3600;

export const cooldownKey = (userId: string, address: string, kind: SignalKind) =>
  `${userId}:${address.toLowerCase()}:${kind}`;

/** Pure: which signals may be delivered, and the cooldown map after delivering them. */
export function applyCooldowns(
  signals: Signal[],
  userId: string,
  existing: Record<string, number>,
  now: number,
  cooldownSec: number
): { deliver: Signal[]; cooldowns: Record<string, number> } {
  const cooldowns = { ...existing };
  const deliver: Signal[] = [];

  for (const s of signals) {
    const key = cooldownKey(userId, s.address, s.kind);
    const last = cooldowns[key];
    if (typeof last === "number" && now - last < cooldownSec) continue;
    deliver.push(s);
    cooldowns[key] = now;
  }

  return { deliver, cooldowns };
}

/**
 * How many cooldown entries are kept.
 *
 * The map lives in the state document, which is written whole, so it is trimmed
 * rather than allowed to accumulate one entry per user per token per kind
 * forever. Oldest first — an entry older than the longest cooldown cannot
 * suppress anything.
 */
export const MAX_COOLDOWN_ENTRIES = 2000;

export async function persistCooldowns(next: Record<string, number>): Promise<void> {
  await mutateState((state) => {
    const merged = { ...(state.signalCooldowns ?? {}), ...next };
    const keys = Object.keys(merged);

    if (keys.length > MAX_COOLDOWN_ENTRIES) {
      const byAge = keys.sort((a, b) => merged[b] - merged[a]);
      for (const stale of byAge.slice(MAX_COOLDOWN_ENTRIES)) delete merged[stale];
    }

    return { state: { ...state, signalCooldowns: merged }, result: undefined };
  });
}

/* ------------------------------------------------------------ Filtering */

export type SignalPreferences = {
  /** Signals below this confidence are never delivered. */
  minConfidence: number;
  /** Kinds the user wants. Empty means all of them. */
  kinds: SignalKind[];
  cooldownSec: number;
};

export const DEFAULT_SIGNAL_PREFERENCES: SignalPreferences = {
  minConfidence: 60,
  kinds: [],
  cooldownSec: DEFAULT_SIGNAL_COOLDOWN_SEC,
};

export function wanted(signal: Signal, prefs: SignalPreferences): boolean {
  if (signal.confidence < prefs.minConfidence) return false;
  if (prefs.kinds.length > 0 && !prefs.kinds.includes(signal.kind)) return false;
  return true;
}

/** Strongest first, then best evidenced — the order a reader should see them. */
export function rank(signals: Signal[]): Signal[] {
  return [...signals].sort((a, b) => b.strength - a.strength || b.confidence - a.confidence);
}
