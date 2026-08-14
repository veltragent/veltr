import type { ChatMessage } from "../llm";
import { callFingerprint, truncate } from "./budget";

/**
 * Orchestration for the interactive agent loop.
 *
 * The loop it serves was written to be correct rather than fast, and it shows in
 * three places: every tool ran one after another even when nothing depended on
 * anything, every tool result stayed in the transcript at full size for every
 * remaining round, and a simple question was given the same budget as a
 * repository investigation.
 *
 * These are pure functions so each decision is testable without a model.
 */

/* ----------------------------------------------------------- Depth */

export type Depth = "fast" | "normal" | "deep";

export type DepthPlan = {
  depth: Depth;
  /** Tool-calling rounds allowed before the loop must conclude. */
  maxRounds: number;
  /** Tool schemas offered per round. */
  toolBudget: number;
  /**
   * Output ceiling for the model.
   *
   * Scaled with depth because a fixed 900 truncated real answers: an eight-round
   * repository analysis ran out mid-word, which reads as a crash rather than as
   * a limit. A lookup never approaches its ceiling, so the larger budget costs
   * nothing on the paths that do not need it.
   */
  responseTokens: number;
};

/**
 * Work that needs no tools at all.
 *
 * Arithmetic, greetings, thanks. These resolve on the first turn anyway — the
 * point of naming them is to stop offering a large tool surface for a question
 * that will not use one.
 */
const TRIVIAL =
  /^\s*(hi|hey|hello|halo|hai|yo|sup|thanks|thank you|makasih|thx|ok(ay)?|siap|good (morning|afternoon|evening))\b[\s!.?]*$|^\s*(what(?:'s| is)|whats|how much is|berapa)?\s*[\d\s+\-*/^().]+=?\s*\??\s*$/i;

/**
 * Work that genuinely needs several rounds.
 *
 * Each of these implies a chain — find the thing, then read it, then relate it
 * to something else — and capping that at five rounds truncates the answer
 * rather than the cost.
 */
const DEEP_SIGNALS = [
  /\b(architect\w*|arsitektur)\b/i,
  /\b(investigate|investigasi|debug|diagnos\w*|root cause|why (is|does|are|did)|kenapa|mengapa)\b/i,
  /\b(repo|repository|codebase|code ?base)\b/i,
  /\b(refactor|redesign|migrate|implement|build (this|the) feature|production[- ]ready)\b/i,
  /\b(compare|bandingkan|versus|trade[- ]?offs?)\b/i,
  /\b(audit|review|security|vulnerab\w*|race condition|edge case)\b/i,
  /\b(explain (how|why)|walk me through|jelaskan (bagaimana|kenapa))\b/i,
];

/**
 * Chooses how much budget a request gets.
 *
 * An attachment forces at least NORMAL: the file has to be read before anything
 * can be said about it, and that is a round on its own.
 */
export function classifyDepth(question: string, options: { hasAttachment?: boolean } = {}): DepthPlan {
  const text = question.trim();

  if (!options.hasAttachment && TRIVIAL.test(text)) {
    return { depth: "fast", maxRounds: 2, toolBudget: 8, responseTokens: 500 };
  }

  const deepHits = DEEP_SIGNALS.filter((pattern) => pattern.test(text)).length;

  /**
   * Length is a weak signal alone but a good tie-breaker.
   *
   * Calibrated against what people actually type: a lookup is around twenty
   * characters ("what is NVDA trading at"), so anything several times that has
   * structure to it — clauses, a condition, a second question.
   */
  const longform = text.length > 140;

  if (deepHits >= 2 || (deepHits >= 1 && longform) || (deepHits >= 1 && options.hasAttachment)) {
    return { depth: "deep", maxRounds: 8, toolBudget: 20, responseTokens: 1_600 };
  }

  return { depth: "normal", maxRounds: 5, toolBudget: 16, responseTokens: 900 };
}

/* ------------------------------------------------- Call partitioning */

export type PendingCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};

export type Partitioned = {
  /** Safe to run at once: they only read. */
  reads: PendingCall[];
  /** Run one at a time, in the order the model asked for them. */
  acts: PendingCall[];
};

/**
 * Splits a round into what may run concurrently and what may not.
 *
 * Reads are independent by definition, so running them in sequence is latency
 * paid for nothing — three lookups at 800ms each cost 2.4s serially and 800ms
 * together.
 *
 * Actions are kept sequential deliberately. Two of them can touch the same
 * state — two `set_alert_scope` calls in flight race each other, and the winner
 * is whichever HTTP response arrives second. Order is cheap here; a corrupted
 * subscription is not.
 */
export function partitionCalls(calls: PendingCall[], actionTools: Set<string>): Partitioned {
  const reads: PendingCall[] = [];
  const acts: PendingCall[] = [];

  for (const call of calls) {
    if (actionTools.has(call.name)) acts.push(call);
    else reads.push(call);
  }

  return { reads, acts };
}

/* ------------------------------------------------------ Deduplication */

/**
 * Remembers what a request has already asked for.
 *
 * A loop that reads the same file in round two and again in round four pays
 * twice, waits twice, and learns nothing the second time. Scoped to one request:
 * across requests the underlying caches already handle freshness.
 */
export class CallMemo {
  private readonly seen = new Map<string, unknown>();

  key(name: string, args: Record<string, unknown>): string {
    return callFingerprint(name, args);
  }

  get(name: string, args: Record<string, unknown>): unknown | undefined {
    return this.seen.get(this.key(name, args));
  }

  remember(name: string, args: Record<string, unknown>, result: unknown): void {
    this.seen.set(this.key(name, args), result);
  }

  get size(): number {
    return this.seen.size;
  }
}

/* ------------------------------------------------- Context compression */

/** Full size for the round just completed; the model is reasoning about it now. */
export const RECENT_RESULT_CHARS = 8_000;

/**
 * Older rounds keep only enough to remember what was learned.
 *
 * A 24,000-character source file read in round one stayed at full size in the
 * transcript for every later round. Four rounds later that is the same file
 * charged four times, crowding out the results that are actually driving the
 * current decision.
 */
export const OLDER_RESULT_CHARS = 900;

/**
 * Shrinks tool output already in the transcript.
 *
 * Only messages with role "tool" are touched, and never the most recent round:
 * compressing what the model is about to reason about would trade cost for
 * correctness, which is the wrong direction.
 *
 * Returns a new array — the caller's transcript is not mutated, so a compression
 * bug cannot destroy the conversation it was meant to make cheaper.
 */
export function compressHistory(
  messages: ChatMessage[],
  options: { keepRecent?: number; recentChars?: number; olderChars?: number } = {}
): ChatMessage[] {
  const keepRecent = options.keepRecent ?? 1;
  const recentChars = options.recentChars ?? RECENT_RESULT_CHARS;
  const olderChars = options.olderChars ?? OLDER_RESULT_CHARS;

  // Index of the tool messages, newest last.
  const toolIndexes: number[] = [];
  messages.forEach((message, i) => {
    if (message.role === "tool") toolIndexes.push(i);
  });

  if (toolIndexes.length === 0) return messages;

  const recent = new Set(toolIndexes.slice(-keepRecent));

  return messages.map((message, i) => {
    if (message.role !== "tool" || typeof message.content !== "string") return message;
    const limit = recent.has(i) ? recentChars : olderChars;
    if (message.content.length <= limit) return message;
    return { ...message, content: truncate(message.content, limit) };
  });
}

/** Characters saved by compression, for the log line. */
export function transcriptSize(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0), 0);
}
