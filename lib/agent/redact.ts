/**
 * Secret redaction.
 *
 * A mission persists tool results to disk and shows them to a language model,
 * and some of those tools carry credentials — a GitHub token in an error body, a
 * private key in a misconfigured environment. Redaction happens on the way *in*
 * to the ledger rather than on the way out to the user, because once a secret is
 * in the transcript it has already been sent to a third-party model.
 *
 * Two layers, because either alone is insufficient: known values from the
 * environment catch our own credentials wherever they appear, and shape matching
 * catches credentials belonging to someone else that arrive in a payload.
 */

export const REDACTED = "[redacted]";

/** Only a name-to-value map is needed; typing it loosely keeps tests honest. */
export type EnvLike = Record<string, string | undefined>;

/**
 * Environment variables whose values must never appear in output.
 *
 * Matched by name suffix so a key added later is covered without editing this
 * list — the failure mode of an allowlist here is a leaked secret.
 */
const SECRET_NAME_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|PRIVATE)$/;

/** Below this length a value is not a credential and would redact ordinary text. */
const MIN_SECRET_LENGTH = 12;

function environmentSecrets(env: EnvLike): string[] {
  const values: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < MIN_SECRET_LENGTH) continue;
    if (SECRET_NAME_PATTERN.test(name)) values.push(value);
  }
  // Longest first, so a key that contains another as a prefix is fully removed.
  return values.sort((a, b) => b.length - a.length);
}

/**
 * Credential shapes that identify themselves.
 *
 * Deliberately narrow. A pattern loose enough to catch every possible secret
 * also catches contract addresses and transaction hashes, and a ledger with the
 * evidence redacted out of it is worse than useless — it is misleading.
 */
const PATTERNS: [RegExp, string][] = [
  // EVM private key: 64 hex characters. An address is 40, so this cannot collide.
  [/\b0x[a-fA-F0-9]{64}\b/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, REDACTED],
  [/\btvly-[A-Za-z0-9_-]{16,}\b/g, REDACTED],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g, `Bearer ${REDACTED}`],
  // Query-string credentials: keep the parameter name, lose the value.
  [/([?&](?:api_?key|token|secret|password)=)[^&\s"']+/gi, `$1${REDACTED}`],
];

/**
 * Removes credentials from a string.
 *
 * A private key is 64 hex characters and a transaction hash is also 64 hex
 * characters, so this will redact a transaction hash. That is the correct trade:
 * a hash is recoverable from the chain, a leaked key is not recoverable from
 * anything.
 */
export function redact(input: string, env: EnvLike = process.env): string {
  let output = input;

  for (const secret of environmentSecrets(env)) {
    // Split/join rather than a constructed RegExp: a key can contain characters
    // that are regex metacharacters, and escaping them is one more thing to get
    // wrong.
    output = output.split(secret).join(REDACTED);
  }

  for (const [pattern, replacement] of PATTERNS) {
    output = output.replace(pattern, replacement);
  }

  return output;
}

/** Redacts anything, by rendering it first. Cycles become "[unserialisable]". */
export function redactValue(value: unknown, env: EnvLike = process.env): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  } catch {
    text = "[unserialisable]";
  }
  return redact(text, env);
}
