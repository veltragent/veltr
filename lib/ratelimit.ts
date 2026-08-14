/**
 * Rate limiting and budget control for paid endpoints.
 *
 * /api/agent is public and every call spends real credit, so it is protected on
 * two axes: a per-caller sliding window (stops one visitor hammering it) and a
 * global daily ceiling (stops the whole internet draining the budget in an
 * afternoon). The global cap is the one that actually protects the money.
 *
 * In-memory, so limits are per-instance. Move to Redis before scaling out.
 */
type Window = { hits: number[]; };

const callers = new Map<string, Window>();

let globalDay = "";
let globalCount = 0;

export type LimitVerdict =
  | { allowed: true; remaining: number; globalRemaining: number }
  | { allowed: false; reason: string; retryAfterSeconds: number };

const PER_CALLER_LIMIT = Number(process.env.VELTR_AGENT_RATE_LIMIT ?? 8);
const PER_CALLER_WINDOW_MS = 60_000;
const GLOBAL_DAILY_LIMIT = Number(process.env.VELTR_AGENT_DAILY_LIMIT ?? 400);

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Best-effort caller identity behind a proxy. */
export function callerKey(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "local";
}

export function checkLimit(key: string): LimitVerdict {
  const now = Date.now();

  if (globalDay !== today()) {
    globalDay = today();
    globalCount = 0;
  }

  if (globalCount >= GLOBAL_DAILY_LIMIT) {
    const midnight = new Date();
    midnight.setUTCHours(24, 0, 0, 0);
    return {
      allowed: false,
      reason: "Daily agent budget reached. Deterministic answers remain available.",
      retryAfterSeconds: Math.ceil((midnight.getTime() - now) / 1000),
    };
  }

  const window = callers.get(key) ?? { hits: [] };
  window.hits = window.hits.filter((t) => now - t < PER_CALLER_WINDOW_MS);

  if (window.hits.length >= PER_CALLER_LIMIT) {
    const oldest = window.hits[0];
    return {
      allowed: false,
      reason: `Rate limit: ${PER_CALLER_LIMIT} questions per minute.`,
      retryAfterSeconds: Math.max(1, Math.ceil((PER_CALLER_WINDOW_MS - (now - oldest)) / 1000)),
    };
  }

  window.hits.push(now);
  callers.set(key, window);
  globalCount++;

  // Bound memory on a long-running process.
  if (callers.size > 5000) {
    for (const [k, v] of callers) {
      if (v.hits.every((t) => now - t >= PER_CALLER_WINDOW_MS)) callers.delete(k);
    }
  }

  return {
    allowed: true,
    remaining: PER_CALLER_LIMIT - window.hits.length,
    globalRemaining: GLOBAL_DAILY_LIMIT - globalCount,
  };
}

/**
 * Separate ceiling for the code tier.
 *
 * File generation runs on Opus with a ~6.9k-token overhead per call, so each one
 * costs roughly ten cents. A model that loops — generate, inspect, regenerate —
 * would spend the account down in an afternoon without this.
 */
let codeDay = "";
let codeCount = 0;

const CODE_DAILY_LIMIT = Number(process.env.VELTR_CODE_DAILY_LIMIT ?? 150);

export function checkCodeBudget(): { allowed: true; remaining: number } | { allowed: false; reason: string } {
  if (codeDay !== today()) {
    codeDay = today();
    codeCount = 0;
  }

  if (codeCount >= CODE_DAILY_LIMIT) {
    return {
      allowed: false,
      reason: `Daily code-generation budget reached (${CODE_DAILY_LIMIT} calls). It resets at 00:00 UTC.`,
    };
  }

  codeCount++;
  return { allowed: true, remaining: CODE_DAILY_LIMIT - codeCount };
}

export function codeBudgetStatus() {
  if (codeDay !== today()) return { used: 0, limit: CODE_DAILY_LIMIT, day: today() };
  return { used: codeCount, limit: CODE_DAILY_LIMIT, day: codeDay };
}

export function budgetStatus() {
  if (globalDay !== today()) return { used: 0, limit: GLOBAL_DAILY_LIMIT, day: today() };
  return { used: globalCount, limit: GLOBAL_DAILY_LIMIT, day: globalDay };
}
