import { kvAvailable, kvGet, kvIncr, kvIncrBy, kvSet } from "./kv";

/**
 * A ceiling on what the model is allowed to cost in a day.
 *
 * Until missions ran on a schedule, spend was bounded by something reliable:
 * a person had to ask. Per-mission limits — iterations, tool calls — capped any
 * single answer, and nothing could start on its own. Recurring missions removed
 * that property. Five schedules per user on a fifteen-minute floor is work that
 * arrives whether or not anyone is awake, and no per-mission ceiling can see the
 * total.
 *
 * What is counted is tokens and calls, because those are the numbers the
 * gateways actually return. A dollar figure would have to be invented — the
 * chain routes across several providers whose prices are not published to this
 * process — and an invented number on a spending report is worse than no number,
 * because it will be believed. Set VELTR_USD_PER_MTOK to have an estimate
 * rendered, and it is labelled an estimate.
 *
 * Counted in the shared store, for the same reason provider budgets are: two
 * replicas each politely staying under the ceiling spend twice the ceiling, and
 * every process involved believes it behaved.
 */

/** Autonomous work stops here — the things nobody is waiting for yield first. */
export const SOFT_CEILING_TOKENS = Number(process.env.VELTR_DAILY_TOKEN_SOFT ?? 1_500_000);

/** Everything stops here. */
export const HARD_CEILING_TOKENS = Number(process.env.VELTR_DAILY_TOKEN_HARD ?? 2_500_000);

/** Work that runs on a timer, versus work a person is waiting for. */
export type SpendKind = "autonomous" | "interactive";

const DAY_MS = 24 * 60 * 60 * 1000;

function today(now: Date): string {
  return now.toISOString().slice(0, 10);
}

const tokenKey = (day: string) => `spend:tokens:${day}`;
const callKey = (day: string) => `spend:calls:${day}`;
const noticeKey = (day: string, level: string) => `spend:told:${day}:${level}`;

/**
 * Process-local mirror.
 *
 * Kept so a store outage does not silently remove the ceiling altogether. It
 * undercounts across replicas — which is exactly the flaw the shared counter
 * exists to fix — but undercounting is a better failure than not counting.
 */
let localDay = "";
let localTokens = 0;
let localCalls = 0;

function localAdd(day: string, tokens: number): number {
  if (day !== localDay) {
    localDay = day;
    localTokens = 0;
    localCalls = 0;
  }
  localTokens += tokens;
  localCalls += 1;
  return localTokens;
}

export type Usage = { promptTokens: number; completionTokens: number };

/**
 * Reads usage off a gateway response.
 *
 * Providers that report it are believed. For those that do not, the text is
 * measured at four characters per token — deliberately crude, and deliberately
 * still counted: a gateway that reports nothing would otherwise be free, and the
 * cheapest way to blow through a ceiling is to route everything through the one
 * provider the meter cannot see.
 */
export function usageFrom(json: unknown, sentChars: number, receivedChars: number): Usage {
  const usage = (json as { usage?: Record<string, unknown> } | null)?.usage;
  const prompt = Number(usage?.prompt_tokens ?? usage?.input_tokens);
  const completion = Number(usage?.completion_tokens ?? usage?.output_tokens);

  if (Number.isFinite(prompt) && Number.isFinite(completion) && prompt + completion > 0) {
    return { promptTokens: prompt, completionTokens: completion };
  }
  return {
    promptTokens: Math.ceil(sentChars / 4),
    completionTokens: Math.ceil(receivedChars / 4),
  };
}

export type SpendToday = {
  day: string;
  tokens: number;
  calls: number;
  /** True when the count came from the shared store rather than this process. */
  shared: boolean;
};

export async function spendToday(now = new Date()): Promise<SpendToday> {
  const day = today(now);
  if (!kvAvailable()) {
    return { day, tokens: day === localDay ? localTokens : 0, calls: day === localDay ? localCalls : 0, shared: false };
  }
  const [tokens, calls] = await Promise.all([kvGet(tokenKey(day)), kvGet(callKey(day))]);
  return { day, tokens: Number(tokens ?? 0), calls: Number(calls ?? 0), shared: true };
}

/**
 * Records what a call cost. Never throws — metering must not break answering.
 */
export async function recordSpend(usage: Usage, now = new Date()): Promise<void> {
  const day = today(now);
  const tokens = Math.max(0, Math.round(usage.promptTokens + usage.completionTokens));
  localAdd(day, tokens);

  if (!kvAvailable()) return;
  try {
    // Two days, so a counter written just before midnight is still readable for
    // a report the following morning.
    await Promise.all([
      kvIncr(callKey(day), 2 * DAY_MS),
      kvIncrBy(tokenKey(day), tokens, 2 * DAY_MS),
    ]);
  } catch {
    // Already counted locally; a store hiccup must not surface as a failed answer.
  }
}

export type Verdict =
  | { allowed: true }
  | { allowed: false; level: "soft" | "hard"; tokens: number; ceiling: number };

/**
 * May a call be made?
 *
 * The soft ceiling stops work that arrives on a timer while leaving a person who
 * is waiting for an answer with a working product. The hard ceiling stops
 * everything, because a limit that only ever applies to the machine is not a
 * limit on the bill.
 */
export async function spendAllows(kind: SpendKind, now = new Date()): Promise<Verdict> {
  const { tokens } = await spendToday(now);

  if (tokens >= HARD_CEILING_TOKENS) {
    return { allowed: false, level: "hard", tokens, ceiling: HARD_CEILING_TOKENS };
  }
  if (kind === "autonomous" && tokens >= SOFT_CEILING_TOKENS) {
    return { allowed: false, level: "soft", tokens, ceiling: SOFT_CEILING_TOKENS };
  }
  return { allowed: true };
}

/**
 * Tells the owner a ceiling was reached, once.
 *
 * Once per level per day: a refusal happens on every subsequent call, and a
 * message per refusal would be its own kind of runaway.
 */
export async function announceOnce(level: "soft" | "hard", text: string, now = new Date()): Promise<boolean> {
  const day = today(now);
  if (kvAvailable()) {
    const key = noticeKey(day, level);
    if (await kvGet(key)) return false;
    await kvSet(key, "1", 2 * DAY_MS);
  } else {
    if (announced.has(`${day}:${level}`)) return false;
    announced.add(`${day}:${level}`);
  }

  const { notifyOwner } = await import("./owner");
  return notifyOwner(text);
}

const announced = new Set<string>();

/** A spending report a person can read. */
export function describeSpend(spend: SpendToday): string {
  const perMillion = Number(process.env.VELTR_USD_PER_MTOK ?? "");
  const estimate =
    Number.isFinite(perMillion) && perMillion > 0
      ? `\nRough cost: $${((spend.tokens / 1_000_000) * perMillion).toFixed(2)} — an estimate from VELTR_USD_PER_MTOK, not a bill.`
      : "";

  const pct = Math.round((spend.tokens / HARD_CEILING_TOKENS) * 100);

  return [
    `Model usage for ${spend.day}${spend.shared ? "" : " (this instance only — no shared store)"}`,
    "",
    `${spend.tokens.toLocaleString()} tokens across ${spend.calls.toLocaleString()} calls`,
    `${pct}% of the daily ceiling (${HARD_CEILING_TOKENS.toLocaleString()})`,
    `Scheduled work pauses at ${SOFT_CEILING_TOKENS.toLocaleString()}.${estimate}`,
  ].join("\n");
}
