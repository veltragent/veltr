import type { Mission } from "./types";

/**
 * Cost control.
 *
 * An autonomous loop is a loop that can decide to keep going, which makes every
 * ceiling here a spending limit rather than a tuning parameter. The model tier
 * this agent runs on bills per call and several tools bill per call behind that,
 * so a mission that reasons its way into thirty rounds costs real money and
 * produces no better answer than one that stopped at four.
 */

export const LIMITS = {
  /** Full OBSERVE→DECIDE cycles. The hard stop against an agent talking to itself. */
  maxIterations: 6,
  /** Tool calls across the whole mission, regardless of how they are distributed. */
  maxToolCalls: 20,
  /** Tool calls the model may request in one observation round. */
  maxCallsPerRound: 4,
  /** Attempts per tool call, including the first. */
  maxAttempts: 2,
  /** One tool call. */
  toolTimeoutMs: 45_000,
  /** One mission, wall clock. Long enough for six rounds of real work. */
  missionTimeoutMs: 5 * 60_000,
  /** Characters of tool output kept per evidence entry. */
  evidenceChars: 1_800,
  /** Evidence entries retained; the oldest reads are dropped first. */
  maxEvidence: 40,
  /** Missions retained on disk per owner. */
  maxMissionsPerOwner: 20,
} as const;

export type BudgetVerdict = { ok: true } | { ok: false; reason: string };

/**
 * May the mission run another cycle?
 *
 * Checked before observing rather than after, so an exhausted mission concludes
 * from what it has instead of spending one more call to discover it is out of
 * budget.
 */
export function checkBudget(mission: Mission, now: Date = new Date()): BudgetVerdict {
  if (mission.iterations >= LIMITS.maxIterations) {
    return { ok: false, reason: `Reached the ${LIMITS.maxIterations}-iteration ceiling.` };
  }
  if (mission.toolCalls >= LIMITS.maxToolCalls) {
    return { ok: false, reason: `Reached the ${LIMITS.maxToolCalls}-tool-call ceiling.` };
  }
  if (now.getTime() >= new Date(mission.deadlineAt).getTime()) {
    return { ok: false, reason: "Ran out of time." };
  }
  return { ok: true };
}

/** Tool calls still available, so a round can be trimmed rather than truncated mid-flight. */
export function remainingToolCalls(mission: Mission): number {
  return Math.max(0, LIMITS.maxToolCalls - mission.toolCalls);
}

/**
 * Identity of a tool call, for deduplication.
 *
 * Object key order is not stable across JSON round-trips, so keys are sorted —
 * without that, the same call reached by two paths produces two different
 * fingerprints and the deduplication silently does nothing.
 */
export function callFingerprint(tool: string, args: Record<string, unknown>): string {
  const entries = Object.entries(args ?? {})
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `${tool}(${JSON.stringify(entries)})`;
}

/**
 * Trims a tool result to what is worth keeping.
 *
 * Long results are not just expensive — they push the evidence that matters out
 * of the model's attention. Truncation is marked so neither the model nor a
 * reader mistakes a cut-off list for a complete one.
 */
export function truncate(text: string, limit: number = LIMITS.evidenceChars): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…[truncated ${text.length - limit} chars]`;
}

/**
 * Runs a promise under a timeout.
 *
 * The underlying work is not cancelled — an HTTP request in flight cannot be
 * recalled — so this bounds how long the mission waits, not how long the tool
 * runs. Pretending otherwise would make the guarantee a lie.
 */
export async function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  label: string
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<{ ok: false; error: string }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: `${label} timed out after ${ms}ms` }), ms);
  });

  try {
    const value = await Promise.race([work.then((v) => ({ ok: true as const, value: v })), timeout]);
    return value;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
