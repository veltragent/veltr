import { LIMITS, truncate } from "./budget";
import { redactValue } from "./redact";
import type { Evidence } from "./types";

/**
 * The evidence ledger.
 *
 * Every fact a mission is allowed to state must be traceable to an entry here,
 * and every entry here was produced by a tool call that actually happened. That
 * is the whole anti-hallucination mechanism: not an instruction asking the model
 * to be truthful, but a rule that discards any claim whose citation does not
 * resolve.
 *
 * URLs get the same treatment. A model asked for a source will happily produce a
 * plausible one, so the only URLs that survive into output are those a tool
 * returned — collected here at the moment the result arrived.
 */

/** Matches an http(s) URL inside a JSON-rendered tool result. */
const URL_PATTERN = /https?:\/\/[^\s"'<>)\]}\\]+/g;

export function extractUrls(text: string, limit = 12): string[] {
  const found = text.match(URL_PATTERN) ?? [];
  const cleaned = found
    // Trailing punctuation is part of the prose, not the address.
    .map((url) => url.replace(/[.,;:]+$/, ""))
    .filter((url) => url.length < 400);
  return [...new Set(cleaned)].slice(0, limit);
}

export type RecordInput = {
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
  ok: boolean;
};

/**
 * Turns a tool result into a ledger entry.
 *
 * Redaction happens here, on the way in, rather than on the way out. Once a
 * credential is in the transcript it has already been sent to a third-party
 * model; redacting it at the point of display would be theatre.
 */
export function toEvidence(id: string, input: RecordInput, at: string = new Date().toISOString()): Evidence {
  const rendered = redactValue(input.result);

  return {
    id,
    tool: input.tool,
    args: input.args,
    ok: input.ok,
    summary: truncate(rendered),
    urls: extractUrls(rendered),
    at,
  };
}

/** Next id in sequence, continuing past whatever the ledger already holds. */
export function nextEvidenceId(existing: Evidence[]): string {
  let highest = 0;
  for (const entry of existing) {
    const match = /^e(\d+)$/.exec(entry.id);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `e${highest + 1}`;
}

/**
 * Appends, keeping the ledger bounded.
 *
 * When it overflows, failed observations are dropped before successful ones and
 * the oldest go first — a mission that has been running a while should forget the
 * lookup that returned nothing before it forgets the price it found.
 */
export function append(ledger: Evidence[], entry: Evidence): Evidence[] {
  const next = [...ledger, entry];
  if (next.length <= LIMITS.maxEvidence) return next;

  const overflow = next.length - LIMITS.maxEvidence;
  const droppable = next.filter((e) => !e.ok).slice(0, overflow);

  if (droppable.length >= overflow) {
    const dropped = new Set(droppable.map((e) => e.id));
    return next.filter((e) => !dropped.has(e.id));
  }

  return next.slice(overflow);
}

/**
 * Keeps only citations that resolve.
 *
 * A model citing "e7" when the ledger stops at e4 is not making a small mistake;
 * it is describing an observation that never happened. The invented ids are
 * dropped and the caller decides what a claim with nothing left behind it is
 * worth.
 */
export function resolveCitations(ledger: Evidence[], cited: unknown): string[] {
  if (!Array.isArray(cited)) return [];
  const known = new Set(ledger.map((e) => e.id));
  return [...new Set(cited.map((id) => String(id)).filter((id) => known.has(id)))];
}

/** Only URLs some tool actually returned may appear in output. */
export function knownUrls(ledger: Evidence[]): Set<string> {
  const urls = new Set<string>();
  for (const entry of ledger) for (const url of entry.urls) urls.add(url);
  return urls;
}

/**
 * Removes URLs the mission never saw.
 *
 * A fabricated citation is worse than no citation: it looks verifiable, so it is
 * believed and not checked. An invented link is replaced rather than deleted so
 * the sentence around it does not silently change meaning.
 */
export function stripUnknownUrls(text: string, ledger: Evidence[]): string {
  const allowed = knownUrls(ledger);
  return text.replace(URL_PATTERN, (match) => {
    const cleaned = match.replace(/[.,;:]+$/, "");
    if (allowed.has(cleaned)) return match;
    return "[unverified link removed]";
  });
}

/**
 * The ledger as the model sees it: ids, tools, outcomes and content.
 *
 * Rendered shorter than it is stored. The full summary is kept for the record,
 * but a prompt carrying forty entries at full length crowds out the model's own
 * output budget — observed live as a decision truncated mid-JSON, which threw
 * away four good observations. The stored ledger is the archive; this is the
 * working view.
 */
export function renderLedger(ledger: Evidence[], perEntryChars = 700): string {
  if (ledger.length === 0) return "(no observations yet)";

  return ledger
    .map((entry) => {
      const args = Object.keys(entry.args ?? {}).length ? ` ${JSON.stringify(entry.args)}` : "";
      const head = `[${entry.id}] ${entry.tool}${args} — ${entry.ok ? "ok" : "FAILED"}`;
      return `${head}\n${truncate(entry.summary, perEntryChars)}`;
    })
    .join("\n\n");
}

/** Successful observations only — what a conclusion may actually rest on. */
export function usableEvidence(ledger: Evidence[]): Evidence[] {
  return ledger.filter((e) => e.ok);
}
