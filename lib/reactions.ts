/**
 * Picks a reaction that fits what was asked.
 *
 * A fixed emoji on every message is decoration and stops being read after a
 * day. One that matches the request is a signal — it says the message was
 * understood, not merely received, and it arrives before any work begins.
 *
 * Only emoji from Telegram's bot-allowed reaction set are used; anything else
 * is rejected by the API.
 */

type Rule = { test: RegExp; emoji: string };

/**
 * Ordered: the first match wins, so narrow intents sit above broad ones.
 * "show me the AAPL chart" must react as a chart request, not as a question.
 */
const RULES: Rule[] = [
  // Acting on funds — the heaviest thing the bot does.
  { test: /\b(exit|withdraw|defend|close|collect)\b.*\bposition\b|\bposition\b.*\b(exit|withdraw|defend|close)\b/i, emoji: "⚡" },

  // File work.
  { test: /\b(write|create|make|build|generate|turn this into|convert)\b.*\b(file|page|html|md|markdown|csv|json|script|landing|report|doc)\b/i, emoji: "✍" },
  { test: /\b(clean|refactor|tidy|rewrite|fix|debug|improve)\b/i, emoji: "👨‍💻" },
  { test: /\b(bug|error|broken|not working|fails?)\b/i, emoji: "🤨" },

  // Charts and prices.
  { test: /\bchart\b|\bgraph\b|\bshow me\b.*\b(price|chart)\b/i, emoji: "👀" },
  { test: /\b(price|worth|trading at|how much|premium|cost)\b/i, emoji: "💯" },

  // Research.
  { test: /\b(search|find|research|look up|latest|news|announce|rumou?r)\b/i, emoji: "🤓" },
  { test: /\b(repo|repository|github|source code|contract)\b/i, emoji: "👨‍💻" },

  // Reasoning requests.
  { test: /\bwhy\b|\bexplain\b|\bhow does\b|\bwhat causes\b/i, emoji: "🤔" },
  { test: /\bcompare\b|\bversus\b|\bvs\b|\bwhich\b/i, emoji: "🤔" },

  // Social.
  { test: /^(hi|hey|hello|halo|hai|yo|sup|good (morning|evening|afternoon))\b/i, emoji: "🤝" },
  { test: /\b(thanks|thank you|makasih|thx|nice|great|awesome|mantap|keren)\b/i, emoji: "🫡" },
  { test: /\b(help|what can you do|commands?)\b/i, emoji: "🤝" },
];

/** Broad enough to cover anything unmatched without looking like a mistake. */
const DEFAULT_EMOJI = "👀";

export function reactionFor(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return DEFAULT_EMOJI;

  for (const rule of RULES) {
    if (rule.test.test(trimmed)) return rule.emoji;
  }
  return DEFAULT_EMOJI;
}

/** A document upload is always the same intent, whatever the caption says. */
export const FILE_RECEIVED_EMOJI = "👀";

/* ---------------------------------------------------------------- Timing */

/**
 * How long to wait before reacting. Zero: the reaction goes out the moment the
 * message is read, before any work on the reply begins.
 *
 * This was once half a second, on the theory that a reaction landing in the same
 * instant reads as a webhook firing rather than as attention. In use the trade
 * went the other way: what the pause actually buys is a second of silence right
 * where the user is looking for a sign the thing is alive, and the emoji already
 * carries the signal of having been read, since it reflects what was understood
 * rather than merely that something arrived.
 *
 * The pause is still available — set VELTR_REACT_DELAY_MS — for anyone who wants
 * it back.
 */
const DEFAULT_DELAY_MS = 0;

/** Spread added on top of the base, so the pause is not a metronome. */
const DEFAULT_JITTER_MS = 700;

/**
 * Ceiling. A reaction arriving after the answer has already been sent is not a
 * slower acknowledgement, it is a confusing one — so the setting cannot be
 * turned into something that outlives the reply.
 */
export const MAX_REACTION_DELAY_MS = 5_000;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  // A typo must not silently disable the pause or stretch it to a minute.
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.min(value, MAX_REACTION_DELAY_MS);
}

/**
 * Milliseconds to wait before sending the auto-reaction.
 *
 * Setting `VELTR_REACT_DELAY_MS=0` restores the original instant behaviour;
 * `VELTR_REACT_JITTER_MS=0` makes the pause fixed rather than varied.
 *
 * `random` is injected so the range is testable without sampling.
 */
export function reactionDelayMs(random: () => number = Math.random): number {
  const base = envInt("VELTR_REACT_DELAY_MS", DEFAULT_DELAY_MS);
  if (base === 0) return 0;

  const jitter = envInt("VELTR_REACT_JITTER_MS", DEFAULT_JITTER_MS);
  const total = base + (jitter > 0 ? random() * jitter : 0);

  return Math.min(Math.round(total), MAX_REACTION_DELAY_MS);
}
