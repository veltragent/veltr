import { randomUUID } from "node:crypto";
import { buildRadarSnapshot } from "./tokens";
import { publicClient } from "./chain";
import { readState, writeState, trimChanges, type DetectedChange } from "./store";

const EPS = 1e-12;

export type WatchResult = {
  ranAt: string;
  blockNumber: string | null;
  tokensChecked: number;
  changes: DetectedChange[];
  firstRun: boolean;
};

/**
 * One watcher pass.
 *
 * Compares the live multiplier state of every stock token against what was
 * observed last pass, and records three distinct transitions:
 *
 *  - `action-scheduled`   a pending multiplier appeared — the warning window opens
 *  - `multiplier-applied` the live multiplier moved — exposure just changed
 *  - `action-cleared`     a pending action disappeared without being applied
 *
 * The first pass establishes a baseline and deliberately emits nothing; without
 * this, every token would be reported as "changed" on initial deployment.
 */
export async function runWatch(): Promise<WatchResult> {
  const [snapshot, blockNumber, state] = await Promise.all([
    // Uncached: this pass is what detects a corporate action, and reusing a
    // reading taken up to half a minute ago would delay exactly the signal the
    // watcher exists to produce.
    buildRadarSnapshot({ fresh: true }),
    publicClient.getBlockNumber().catch(() => null),
    readState(),
  ]);

  const knownCount = Object.keys(state.lastMultiplier).length;

  /**
   * A pass that sees no tokens is a failed read, not an empty chain.
   *
   * Writing that result would erase the baseline, and the next pass would then
   * treat itself as the first — suppressing every change it found. A real
   * multiplier move during that window would go unreported. So a degenerate
   * snapshot is discarded rather than persisted.
   */
  if (snapshot.tokens.length === 0 && knownCount > 0) {
    console.warn("[veltr] watch pass returned no tokens; keeping previous baseline");
    return {
      ranAt: new Date().toISOString(),
      blockNumber: blockNumber?.toString() ?? null,
      tokensChecked: 0,
      changes: [],
      firstRun: false,
    };
  }

  const firstRun = knownCount === 0;
  const detected: DetectedChange[] = [];
  const now = new Date().toISOString();

  const nextMultiplier: Record<string, number> = {};
  const nextPending: Record<string, number | null> = {};

  for (const token of snapshot.tokens) {
    const key = token.address.toLowerCase();
    nextMultiplier[key] = token.multiplier;

    const hasPending =
      token.pendingMultiplier !== null &&
      Math.abs(token.pendingMultiplier - token.multiplier) > EPS;
    nextPending[key] = hasPending ? token.pendingMultiplier : null;

    if (firstRun) continue;

    const prevMultiplier = state.lastMultiplier[key];
    const prevPending = state.lastPending[key] ?? null;

    if (prevMultiplier !== undefined && Math.abs(token.multiplier - prevMultiplier) > EPS) {
      detected.push({
        id: randomUUID(),
        detectedAt: now,
        token: token.address,
        symbol: token.symbol,
        kind: "multiplier-applied",
        from: prevMultiplier,
        to: token.multiplier,
        deltaPct: prevMultiplier === 0 ? 0 : (token.multiplier / prevMultiplier - 1) * 100,
        effectiveAt: token.effectiveAt,
        notified: false,
      });
    }

    const pendingNow = nextPending[key];
    if (pendingNow !== null && prevPending === null) {
      detected.push({
        id: randomUUID(),
        detectedAt: now,
        token: token.address,
        symbol: token.symbol,
        kind: "action-scheduled",
        from: token.multiplier,
        to: pendingNow,
        deltaPct: token.multiplier === 0 ? 0 : (pendingNow / token.multiplier - 1) * 100,
        effectiveAt: token.effectiveAt,
        notified: false,
      });
    } else if (pendingNow === null && prevPending !== null) {
      // Cleared without the live multiplier moving — the action was withdrawn.
      const applied = detected.some(
        (d) => d.token.toLowerCase() === key && d.kind === "multiplier-applied"
      );
      if (!applied) {
        detected.push({
          id: randomUUID(),
          detectedAt: now,
          token: token.address,
          symbol: token.symbol,
          kind: "action-cleared",
          from: prevPending,
          to: token.multiplier,
          deltaPct: 0,
          effectiveAt: null,
          notified: false,
        });
      }
    }
  }

  await writeState({
    ...state,
    lastMultiplier: nextMultiplier,
    lastPending: nextPending,
    changes: trimChanges([...detected, ...state.changes]),
    lastRunAt: now,
    lastBlock: blockNumber?.toString() ?? state.lastBlock,
  });

  return {
    ranAt: now,
    blockNumber: blockNumber?.toString() ?? null,
    tokensChecked: snapshot.tokens.length,
    changes: detected,
    firstRun,
  };
}
