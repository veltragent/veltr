/**
 * Reconciles what the answer claims against what actually happened.
 *
 * A model that has been told it can send files will, when the sending step
 * silently does nothing, report the file as sent. The user reads "your file has
 * been created and sent", finds nothing, and asks where it is — which is the
 * worst failure this product can have, because every other number the bot
 * reports now has to be doubted too.
 *
 * Fixing the underlying tool removes the cause. This removes the *class*: no
 * claim of delivery survives unless a document actually left the process.
 */

/** Extensions the bot produces. Narrow on purpose — "3.5 million" is not a file. */
const EXTENSIONS =
  "html|htm|md|markdown|txt|csv|json|js|mjs|ts|tsx|jsx|py|css|scss|xml|yaml|yml|svg|sql|sh";

const FILENAME = new RegExp(`\\b([\\w.-]+\\.(?:${EXTENSIONS}))\\b`, "i");

/**
 * Completed-delivery wording, in both languages the bot is actually used in.
 *
 * Deliberately past tense. "I can build you an HTML page" is an offer and must
 * not be flagged; "the file has been created" is a claim about the world.
 */
const CLAIMS: RegExp[] = [
  // English: created / generated / written / sent / attached / delivered / ready
  /\b(?:has been|have been|i(?:'ve| have))\s+(?:\w+\s+){0,3}?(?:created|generated|written|produced|sent|delivered|attached|uploaded)\b/i,
  /\b(?:created|generated|wrote|written|produced|sent|delivered|attached|uploaded)\s+(?:the\s+|a\s+|your\s+)?file\b/i,
  /\bfile\s+is\s+(?:now\s+)?(?:ready|attached|sent|created)\b/i,
  // Indonesian: sudah/telah … dibuat/dikirim/terkirim/jadi
  /\b(?:sudah|telah)\b[^.!?\n]{0,80}?\b(?:dibuat|dikirim|terkirim|dibikin|selesai|jadi)\b/i,
  /\b(?:dibuat|dikirim|terkirim)\s+(?:dan|&)\s+(?:dikirim|dibuat)\b/i,
];

export type ClaimCheck = { claimed: boolean; filename: string | null };

/**
 * Does this answer assert that a file was produced or delivered?
 *
 * A filename alone is not a claim — the bot legitimately names files it is about
 * to write, or that the user sent. A completion verb alone is not a claim either;
 * plenty of other things get "created". Both together are.
 */
export function claimsFileDelivery(text: string): ClaimCheck {
  const filenameMatch = FILENAME.exec(text);
  const filename = filenameMatch?.[1] ?? null;

  const asserts = CLAIMS.some((pattern) => pattern.test(text));
  if (!asserts) return { claimed: false, filename };

  // A completion claim with no filename anywhere is about something else —
  // an alert that was created, a scope that was set.
  //
  // The trailing \w* is not optional: Indonesian attaches clitics to the noun,
  // so "filenya" and "dokumennya" are the ordinary way to say it and a closing
  // word boundary would miss both.
  const mentionsFile = filename !== null || /\b(?:file|dokumen|berkas|document)\w*/i.test(text);

  return { claimed: mentionsFile, filename };
}

export type Reconciliation = {
  /** The answer as it should be sent. */
  answer: string;
  /** Filename salvaged and actually delivered, if recovery succeeded. */
  recovered: string | null;
  /** True when the answer had to be corrected because nothing was delivered. */
  corrected: boolean;
};

export type ReconcileDeps = {
  getGenerated: (chatId: string) => { content: string; language: string | null } | null;
  sendDocument: (chatId: string, filename: string, content: string) => Promise<boolean>;
};

async function liveDeps(): Promise<ReconcileDeps> {
  const [{ getGenerated }, { sendDocument, safeFilename }] = await Promise.all([
    import("./attachments"),
    import("./files"),
  ]);
  return {
    getGenerated,
    sendDocument: (chatId, filename, content) => sendDocument(chatId, safeFilename(filename), content),
  };
}

/** Reasonable name when the answer claimed a file without naming one. */
function fallbackName(language: string | null): string {
  const map: Record<string, string> = {
    html: "index.html",
    markdown: "document.md",
    md: "document.md",
    csv: "data.csv",
    json: "data.json",
    typescript: "script.ts",
    javascript: "script.js",
    python: "script.py",
  };
  return map[(language ?? "").toLowerCase()] ?? "veltr-output.txt";
}

const CORRECTION =
  "\n\n⚠️ Correction: no file was actually sent — that step did not run, and the message above was wrong to say otherwise. Ask again and I will produce it properly.";

/**
 * Makes the answer true.
 *
 * Two outcomes, in order of preference. If the content genuinely exists — the
 * generation step ran and only the delivery step was skipped — it is sent, and
 * the claim becomes accurate. Otherwise the claim is contradicted in the same
 * message, because a user who has been told they have a file must not have to
 * discover otherwise on their own.
 */
export async function reconcileFileClaims(
  answer: string,
  chatId: string | null | undefined,
  deliveredFilenames: string[],
  overrides?: Partial<ReconcileDeps>
): Promise<Reconciliation> {
  // Something was delivered; the claim is supported.
  if (deliveredFilenames.length > 0) return { answer, recovered: null, corrected: false };

  const check = claimsFileDelivery(answer);
  if (!check.claimed) return { answer, recovered: null, corrected: false };

  const deps = { ...(await liveDeps()), ...overrides };

  if (chatId) {
    const stored = deps.getGenerated(chatId);
    if (stored?.content?.trim()) {
      const filename = check.filename ?? fallbackName(stored.language);
      const sent = await deps.sendDocument(chatId, filename, stored.content);
      if (sent) {
        console.warn(
          `[veltr] delivery claim recovered: sent ${filename} the answer said had already gone`
        );
        return { answer, recovered: filename, corrected: false };
      }
    }
  }

  console.error(
    `[veltr] UNSUPPORTED DELIVERY CLAIM corrected${check.filename ? ` (${check.filename})` : ""} — no document left the process`
  );
  return { answer: answer + CORRECTION, recovered: null, corrected: true };
}

/** Filenames a tool actually delivered, read from its result. */
export function deliveredFilename(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const record = result as { sent?: unknown; filename?: unknown; error?: unknown };
  if (record.error) return null;
  if (record.sent !== true) return null;
  return typeof record.filename === "string" ? record.filename : null;
}
