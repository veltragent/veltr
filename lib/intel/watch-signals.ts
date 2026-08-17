import { readState } from "../store";
import { readBaselines } from "./baseline";
import { detectAnomalies, DEFAULT_ANOMALY, type AnomalyThresholds } from "./anomaly";
import { analyseFlow, DEFAULT_SMART_MONEY } from "./smart-money";
import { codexFlowWindow } from "../codex";
import {
  applyCooldowns,
  persistCooldowns,
  rank,
  signalFromSmartMoney,
  signalsFromAnomalies,
  wanted,
  type Signal,
  type SignalPreferences,
} from "./signals";

/**
 * Signal evaluation for the existing token watcher.
 *
 * Deliberately a separate pass rather than a change to `evaluateWatch`. The
 * threshold engine is synchronous, pure, and tested as such — it takes a market
 * reading and returns alerts with no I/O anywhere in it. Signals need provider
 * reads and recorded history, so folding them in would have made that function
 * async and dragged the network into every one of its tests.
 *
 * So the watch cycle keeps its fast path exactly as it was, and this runs beside
 * it, on a slower cadence, for the users who asked for signals.
 */

/**
 * How often signals are evaluated per token.
 *
 * Far slower than the threshold cycle, which can tick every fifteen seconds off
 * a cached price. A signal pass costs a flow read per token, and the things it
 * detects — accumulation, a volume regime change — do not appear and vanish
 * within a minute. Five minutes is frequent enough to be timely and slow enough
 * that watching fifty tokens stays affordable.
 */
export const SIGNAL_INTERVAL_MS = 5 * 60_000;

export type SignalCycleDeps = {
  loadWatchedTokens: () => Promise<Array<{ address: string; symbol: string | null; userIds: string[] }>>;
  loadPreferences: (userId: string) => Promise<SignalPreferences>;
  evaluate: (address: string, symbol: string | null) => Promise<Signal[]>;
  send: (userId: string, text: string) => Promise<boolean>;
  now: () => number;
};

export type SignalCycleReport = {
  tokensEvaluated: number;
  signalsFound: number;
  delivered: number;
  suppressed: number;
  failed: number;
};

/**
 * Everything the intelligence layer can currently say about one token.
 *
 * One flow read serves both detectors — the same window feeds the wallet
 * analysis and the buy/sell imbalance — because fetching it twice would double
 * the cost of the cycle for identical data.
 */
export async function evaluateToken(
  address: string,
  symbol: string | null,
  thresholds: AnomalyThresholds = DEFAULT_ANOMALY
): Promise<Signal[]> {
  const [flow, state] = await Promise.all([
    codexFlowWindow(address, { hours: 6 }).catch(() => ({ swaps: [], spanSec: 0, truncated: false })),
    readState().catch(() => null),
  ]);

  const smart = analyseFlow(address, symbol, flow.swaps, flow.spanSec, flow.truncated, DEFAULT_SMART_MONEY);

  const buys = flow.swaps.filter((s) => s.side === "buy").length;
  const sells = flow.swaps.filter((s) => s.side === "sell").length;
  const sized = flow.swaps.map((s) => s.valueUsd ?? 0).filter((v) => v > 0);

  const anomalies = detectAnomalies(
    {
      address,
      symbol,
      // Price and the aggregates come from the recorded series rather than a
      // fresh call: the recorder already wrote them, and the comparison is
      // against that same series anyway.
      priceUsd: flow.swaps.find((s) => s.priceUsd !== null)?.priceUsd ?? null,
      liquidityUsd: null,
      volume24hUsd: null,
      holders: null,
      buyPressurePct: buys + sells > 0 ? (buys / (buys + sells)) * 100 : null,
      largestTradeUsd: sized.length ? Math.max(...sized) : null,
      medianTradeUsd: smart.medianTradeUsd,
    },
    readBaselines(state),
    thresholds
  );

  const signals = [...signalsFromAnomalies(anomalies)];
  const smartSignal = signalFromSmartMoney(smart);
  if (smartSignal) signals.push(smartSignal);

  return rank(signals);
}

/**
 * One signal pass across every watched token.
 *
 * Deduplicated by token exactly as the threshold cycle is: a token watched by
 * fifty people is evaluated once, and only the per-user filtering and cooldown
 * differ. Never throws — the scheduler calls it forever.
 */
export async function runSignalCycle(deps: SignalCycleDeps): Promise<SignalCycleReport> {
  const report: SignalCycleReport = {
    tokensEvaluated: 0,
    signalsFound: 0,
    delivered: 0,
    suppressed: 0,
    failed: 0,
  };

  const tokens = await deps.loadWatchedTokens();
  if (tokens.length === 0) return report;

  const now = deps.now();
  const cooldownUpdates: Record<string, number> = {};
  const { renderSignal } = await import("./format");
  const state = await readState().catch(() => null);
  const existingCooldowns = state?.signalCooldowns ?? {};

  for (const token of tokens) {
    const signals = await deps.evaluate(token.address, token.symbol).catch(() => []);
    report.tokensEvaluated++;
    if (signals.length === 0) continue;
    report.signalsFound += signals.length;

    for (const userId of token.userIds) {
      const prefs = await deps.loadPreferences(userId);
      const eligible = signals.filter((s) => wanted(s, prefs));
      if (eligible.length === 0) continue;

      const { deliver, cooldowns } = applyCooldowns(
        eligible,
        userId,
        { ...existingCooldowns, ...cooldownUpdates },
        now,
        prefs.cooldownSec
      );

      report.suppressed += eligible.length - deliver.length;
      Object.assign(cooldownUpdates, cooldowns);

      // One signal per token per user per pass. The strongest is the one worth
      // sending; the rest are visible in /scan and would only be noise here.
      const top = deliver[0];
      if (!top) continue;

      const ok = await deps.send(userId, renderSignal(top));
      if (ok) report.delivered++;
      else report.failed++;
    }
  }

  if (Object.keys(cooldownUpdates).length) await persistCooldowns(cooldownUpdates);

  return report;
}

/** Wiring to the real watch store, notify path and settings. */
export async function runSignalCycleSafely(): Promise<SignalCycleReport | null> {
  try {
    const { listAllWatches } = await import("../watch/store");
    const { getSettings } = await import("../watch/store");

    return await runSignalCycle({
      loadWatchedTokens: async () => {
        const watches = await listAllWatches();
        const byToken = new Map<string, { address: string; symbol: string | null; userIds: string[] }>();

        for (const w of watches) {
          if (!w.enabled) continue;
          const key = w.tokenAddress.toLowerCase();
          const existing = byToken.get(key) ?? { address: key, symbol: w.symbol, userIds: [] };
          if (!existing.userIds.includes(w.userId)) existing.userIds.push(w.userId);
          byToken.set(key, existing);
        }
        return [...byToken.values()];
      },
      loadPreferences: async (userId) => {
        const { preferencesFrom } = await import("./preferences");
        return preferencesFrom(await getSettings(userId));
      },
      evaluate: (address, symbol) => evaluateToken(address, symbol),
      send: async (userId, text) => {
        const { mayPush } = await import("../owner");
        if (!(await mayPush(userId))) return false;
        const { sendTelegram } = await import("../notify");
        return sendTelegram(userId, text);
      },
      now: () => Math.floor(Date.now() / 1000),
    });
  } catch (error) {
    console.error("[veltr][SIGNAL] cycle failed:", error instanceof Error ? error.message : error);
    return null;
  }
}
