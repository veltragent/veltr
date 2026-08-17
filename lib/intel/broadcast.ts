import { mutateState, type Subscription } from "../store";
import type { Signal } from "./signals";

/**
 * Chain-wide alerts.
 *
 * Every subscriber receives these by default, which makes restraint the whole
 * design. A personal watch alert was asked for — the user named a token and set
 * a threshold, and noise is their own doing. A global alert was not asked for,
 * so the bar is not "is this true" but "would a reasonable person want their
 * phone to buzz for this".
 *
 * Four gates, in order, each of which can only reject:
 *
 *   quality   — is the finding strong and well-evidenced enough to be worth it
 *   novelty   — has this exact event already been broadcast
 *   cooldown  — has this token said something similar too recently
 *   delivery  — one queue, rate limited, permanent failures recorded
 *
 * The thresholds are deliberately far stricter than the personal ones. A watch
 * alert can fire at a user's own 1% threshold; nothing reaches every subscriber
 * below high confidence and a genuine departure from normal.
 */

/* --------------------------------------------------------- Eligibility */

/**
 * Minimum confidence for a broadcast.
 *
 * Well above the personal signal default of 60. A finding that is probably true
 * is fine when someone asked to watch that token; it is not fine when it goes to
 * everyone, because at that volume "probably" becomes "regularly wrong".
 */
export const GLOBAL_MIN_CONFIDENCE = 80;

/** Minimum strength — how pronounced the move is, separate from how sure we are. */
export const GLOBAL_MIN_STRENGTH = 75;

/**
 * Kinds that may ever go out chain-wide.
 *
 * Momentum and holder growth are deliberately excluded. Both are real signals
 * and both are common enough that broadcasting them would train people to
 * ignore the ones that matter. They remain available on /signals, where a user
 * opted in per token.
 */
export const BROADCASTABLE: Signal["kind"][] = [
  "smart_money",
  "volume_spike",
  "liquidity_change",
  "whale_activity",
  "anomaly",
  "risk_change",
  "security_change",
];

export type Eligibility = { ok: true } | { ok: false; reason: string };

/**
 * The quality gate.
 *
 * Returns a reason on rejection so a decision is auditable in the log — "why did
 * nobody hear about that" is a question this has to be able to answer.
 */
export function eligible(signal: Signal): Eligibility {
  if (!BROADCASTABLE.includes(signal.kind)) {
    return { ok: false, reason: `${signal.kind} is not broadcastable` };
  }
  if (signal.confidence < GLOBAL_MIN_CONFIDENCE) {
    return { ok: false, reason: `confidence ${signal.confidence} below ${GLOBAL_MIN_CONFIDENCE}` };
  }
  if (signal.strength < GLOBAL_MIN_STRENGTH) {
    return { ok: false, reason: `strength ${signal.strength} below ${GLOBAL_MIN_STRENGTH}` };
  }
  if (signal.facts.length === 0) {
    // A signal with no checkable facts is a claim. Those do not go out.
    return { ok: false, reason: "no supporting facts" };
  }
  return { ok: true };
}

/* ---------------------------------------------------------- Deduplication */

/**
 * Window used to build a signal's identity.
 *
 * The same accumulation stays true for hours and is re-detected every cycle. The
 * identity therefore includes the hour it happened in, so re-detections of one
 * event collapse to one broadcast while a genuinely new event an hour later is
 * allowed through. Two workers detecting it simultaneously also collapse, which
 * is what stops a duplicate replica double-sending.
 */
export const DEDUP_WINDOW_SEC = 3600;

export function signalIdentity(signal: Signal, windowSec = DEDUP_WINDOW_SEC): string {
  const bucket = Math.floor(signal.at / windowSec);
  return `${signal.address}:${signal.kind}:${bucket}`;
}

/**
 * How long one token stays quiet after any broadcast about it.
 *
 * Applies across kinds. A token that spikes on volume, then on liquidity, then
 * on whale activity within ten minutes is one event being described three ways,
 * and sending all three is how a useful alert stream becomes noise.
 */
export const PER_TOKEN_COOLDOWN_SEC = 4 * 3600;

const tokenKey = (address: string) => `broadcast:token:${address.toLowerCase()}`;
const eventKey = (identity: string) => `broadcast:event:${identity}`;

export type BroadcastGate =
  | { send: true; marks: Record<string, number> }
  | { send: false; reason: string };

/**
 * Novelty and cooldown, as one pure decision.
 *
 * Takes the existing marks and returns the ones to write, so the caller can
 * persist once for a whole cycle rather than per signal — and so this whole
 * path is testable without a store.
 */
export function gate(
  signal: Signal,
  marks: Record<string, number>,
  now: number,
  perTokenCooldownSec = PER_TOKEN_COOLDOWN_SEC
): BroadcastGate {
  const identity = signalIdentity(signal);

  if (marks[eventKey(identity)] !== undefined) {
    return { send: false, reason: "already broadcast" };
  }

  const lastForToken = marks[tokenKey(signal.address)];
  if (typeof lastForToken === "number" && now - lastForToken < perTokenCooldownSec) {
    const mins = Math.round((perTokenCooldownSec - (now - lastForToken)) / 60);
    return { send: false, reason: `token cooling down for another ${mins}m` };
  }

  return {
    send: true,
    marks: { [eventKey(identity)]: now, [tokenKey(signal.address)]: now },
  };
}

/** Bounded, because this lives in the state document. */
export const MAX_MARKS = 1000;

export async function persistMarks(next: Record<string, number>): Promise<void> {
  if (Object.keys(next).length === 0) return;

  await mutateState((state) => {
    const merged = { ...(state.broadcastMarks ?? {}), ...next };
    const keys = Object.keys(merged);
    if (keys.length > MAX_MARKS) {
      const byAge = keys.sort((a, b) => merged[b] - merged[a]);
      for (const stale of byAge.slice(MAX_MARKS)) delete merged[stale];
    }
    return { state: { ...state, broadcastMarks: merged }, result: undefined };
  });
}

/* ------------------------------------------------------------- Recipients */

/** Undefined means on — see the field comment on Subscription. */
export const wantsGlobalAlerts = (s: Subscription): boolean =>
  s.globalAlerts !== false && !s.undeliverableSince;

export function recipientsOf(subscriptions: Subscription[]): string[] {
  const seen = new Set<string>();
  for (const s of subscriptions) {
    if (s.channel !== "telegram") continue;
    if (!wantsGlobalAlerts(s)) continue;
    // One row per chat id even if the same chat subscribed twice.
    seen.add(s.destination);
  }
  return [...seen];
}

/* --------------------------------------------------------------- Delivery */

/**
 * Messages per second.
 *
 * Telegram's documented ceiling for broadcast traffic is around thirty a
 * second, and exceeding it earns a 429 with a retry_after that applies to the
 * whole bot — including replies to people who are actively talking to it. Well
 * under the limit is the right side to err on.
 */
export const SENDS_PER_SECOND = 20;

export type BroadcastDeps = {
  send: (chatId: string, text: string) => Promise<import("../notify").DeliveryOutcome>;
  markUndeliverable: (chatId: string, reason: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
};

export type BroadcastResult = {
  attempted: number;
  sent: number;
  failed: number;
  /** Chats recorded as permanently unreachable this run. */
  removed: number;
  throttled: number;
};

/**
 * Sends one message to many chats, pacing itself.
 *
 * Sequential with a delay rather than parallel: a broadcast is not latency
 * sensitive, and the failure mode of going fast is a bot-wide rate limit that
 * breaks the interactive path for everyone.
 */
export async function broadcast(
  chatIds: string[],
  text: string,
  deps: BroadcastDeps
): Promise<BroadcastResult> {
  const result: BroadcastResult = { attempted: 0, sent: 0, failed: 0, removed: 0, throttled: 0 };
  const gapMs = Math.ceil(1000 / SENDS_PER_SECOND);

  for (const chatId of chatIds) {
    result.attempted++;
    const outcome = await deps.send(chatId, text);

    if (outcome.ok) {
      result.sent++;
    } else if (outcome.permanent) {
      result.removed++;
      await deps.markUndeliverable(chatId, outcome.reason);
    } else {
      result.failed++;
      if (outcome.retryAfterSec !== null) {
        result.throttled++;
        /*
         * Honour the retry window and try this recipient once more. Telegram's
         * retry_after applies to the bot, so continuing at pace would fail every
         * remaining send too — waiting is faster than pressing on.
         */
        await deps.sleep(outcome.retryAfterSec * 1000);
        const retry = await deps.send(chatId, text);
        if (retry.ok) {
          result.sent++;
          result.failed--;
        } else if (retry.permanent) {
          result.removed++;
          result.failed--;
          await deps.markUndeliverable(chatId, retry.reason);
        }
      }
    }

    await deps.sleep(gapMs);
  }

  return result;
}

/** Records a chat as unreachable so later broadcasts skip it. */
export async function markUndeliverable(chatId: string, reason: string): Promise<void> {
  console.warn(`[veltr][BROADCAST] ${chatId} unreachable: ${reason}`);
  await mutateState((state) => ({
    state: {
      ...state,
      subscriptions: state.subscriptions.map((s) =>
        s.destination === chatId ? { ...s, undeliverableSince: new Date().toISOString() } : s
      ),
    },
    result: undefined,
  }));
}

/**
 * Clears the unreachable mark.
 *
 * Called when a user sends a message: they demonstrably can reach the bot, so
 * whatever made them unreachable is over. Without this, anyone who blocked and
 * later unblocked would stay silently excluded forever.
 */
export async function clearUndeliverable(chatId: string): Promise<void> {
  await mutateState((state) => {
    const affected = state.subscriptions.some(
      (s) => s.destination === chatId && s.undeliverableSince
    );
    if (!affected) return { state, result: undefined };

    return {
      state: {
        ...state,
        subscriptions: state.subscriptions.map((s) =>
          s.destination === chatId ? { ...s, undeliverableSince: null } : s
        ),
      },
      result: undefined,
    };
  });
}
