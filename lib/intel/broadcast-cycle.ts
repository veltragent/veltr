import { readState } from "../store";
import { codexTopTokens } from "../codex";
import { readBaselines, seriesFrom } from "./baseline";
import { evaluateToken } from "./watch-signals";
import { rank, type Signal } from "./signals";
import {
  broadcast,
  eligible,
  gate,
  markUndeliverable,
  persistMarks,
  recipientsOf,
} from "./broadcast";
import { renderSignal } from "./format";

/**
 * Finds what is worth telling everyone about, and tells them once.
 *
 * The candidate set is deliberately narrow: only tokens that already have
 * recorded history, because a chain-wide alert asserting something is unusual
 * has to be measured against what usual looks like. A token first seen ten
 * minutes ago cannot clear that bar and is not evaluated — which also keeps the
 * cycle's cost proportional to what is being tracked rather than to the size of
 * the chain.
 */

/**
 * How often the chain is swept.
 *
 * Slower than the per-user signal cycle. A global alert is a rarer, higher-bar
 * event, and evaluating flow for every tracked token is the most expensive thing
 * the intelligence layer does.
 */
export const BROADCAST_INTERVAL_MS = 15 * 60_000;

/**
 * Tokens examined per sweep.
 *
 * Each costs a flow read. Ranked by volume, so the ones capable of producing an
 * event anybody cares about are the ones looked at.
 */
export const CANDIDATES = 25;

/** Ceiling on broadcasts per sweep, whatever the market is doing. */
export const MAX_PER_CYCLE = 2;

export type BroadcastCycleReport = {
  candidates: number;
  signalsFound: number;
  eligible: number;
  broadcast: number;
  recipients: number;
  sent: number;
  removed: number;
  rejections: string[];
};

export type BroadcastCycleDeps = {
  candidateTokens: () => Promise<Array<{ address: string; symbol: string | null }>>;
  evaluate: (address: string, symbol: string | null) => Promise<Signal[]>;
  loadRecipients: () => Promise<string[]>;
  loadMarks: () => Promise<Record<string, number>>;
  saveMarks: (marks: Record<string, number>) => Promise<void>;
  send: (chatIds: string[], text: string) => Promise<{ sent: number; removed: number }>;
  now: () => number;
};

/** Pure enough to test end to end: every dependency is injected. */
export async function runBroadcastCycle(deps: BroadcastCycleDeps): Promise<BroadcastCycleReport> {
  const report: BroadcastCycleReport = {
    candidates: 0,
    signalsFound: 0,
    eligible: 0,
    broadcast: 0,
    recipients: 0,
    sent: 0,
    removed: 0,
    rejections: [],
  };

  const tokens = await deps.candidateTokens();
  report.candidates = tokens.length;
  if (tokens.length === 0) return report;

  const found: Signal[] = [];
  for (const token of tokens) {
    const signals = await deps.evaluate(token.address, token.symbol).catch(() => []);
    found.push(...signals);
  }
  report.signalsFound = found.length;

  // Strongest first, so a per-cycle ceiling keeps the best rather than the
  // first token that happened to be evaluated.
  const ranked = rank(found);

  const passing: Signal[] = [];
  for (const signal of ranked) {
    const verdict = eligible(signal);
    if (verdict.ok) passing.push(signal);
    else report.rejections.push(`${signal.symbol ?? signal.address.slice(0, 8)} ${signal.kind}: ${verdict.reason}`);
  }
  report.eligible = passing.length;
  if (passing.length === 0) return report;

  const marks = await deps.loadMarks();
  const pending: Signal[] = [];
  const newMarks: Record<string, number> = {};
  const now = deps.now();

  for (const signal of passing) {
    if (pending.length >= MAX_PER_CYCLE) break;
    const decision = gate(signal, { ...marks, ...newMarks }, now);
    if (!decision.send) {
      report.rejections.push(`${signal.symbol ?? signal.address.slice(0, 8)} ${signal.kind}: ${decision.reason}`);
      continue;
    }
    pending.push(signal);
    Object.assign(newMarks, decision.marks);
  }

  if (pending.length === 0) return report;

  const recipients = await deps.loadRecipients();
  report.recipients = recipients.length;

  /*
   * Marks are written before delivery, not after.
   *
   * A crash midway through a broadcast would otherwise leave the event unmarked,
   * and the next sweep would send the whole thing again to everyone who already
   * received it. Sending to some and marking it done is the better failure: the
   * alternative duplicates for the majority to serve the minority.
   */
  await deps.saveMarks(newMarks);

  for (const signal of pending) {
    report.broadcast++;
    // Unsolicited: the recipient never named this token, so the message has to
    // say why it arrived and how to stop it.
    const outcome = await deps.send(recipients, renderSignal(signal, { unsolicited: true }));
    report.sent += outcome.sent;
    report.removed += outcome.removed;
  }

  return report;
}

/** Wiring to the real providers, store and Telegram. */
export async function runBroadcastCycleSafely(): Promise<BroadcastCycleReport | null> {
  try {
    return await runBroadcastCycle({
      candidateTokens: async () => {
        const [{ tokens }, state] = await Promise.all([
          codexTopTokens("volume24", CANDIDATES),
          readState().catch(() => null),
        ]);
        const baselines = readBaselines(state);

        // Only tokens with recorded history: an "unusual" claim needs a usual.
        return tokens
          .filter((t) => seriesFrom(baselines, t.address) !== null)
          .map((t) => ({ address: t.address, symbol: t.symbol }));
      },
      evaluate: (address, symbol) => evaluateToken(address, symbol),
      loadRecipients: async () => {
        const state = await readState();
        const { allowedRecipients } = await import("../owner");
        // Honours the owner restriction the rest of the push path already uses.
        return allowedRecipients(recipientsOf(state.subscriptions));
      },
      loadMarks: async () => (await readState()).broadcastMarks ?? {},
      saveMarks: persistMarks,
      send: async (chatIds, text) => {
        const { deliver } = await import("../notify");
        const result = await broadcast(chatIds, text, {
          send: deliver,
          markUndeliverable,
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        });
        console.log(
          `[veltr][BROADCAST] attempted=${result.attempted} sent=${result.sent} failed=${result.failed} removed=${result.removed} throttled=${result.throttled}`
        );
        return { sent: result.sent, removed: result.removed };
      },
      now: () => Math.floor(Date.now() / 1000),
    });
  } catch (error) {
    console.error("[veltr][BROADCAST] cycle failed:", error instanceof Error ? error.message : error);
    return null;
  }
}
