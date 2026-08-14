import type { FileContent } from "./files";

/**
 * The file a chat most recently sent.
 *
 * Held in memory rather than written to disk: an uploaded document is context
 * for the next question, not a record worth keeping, and persisting user files
 * turns a chat feature into a data-retention question nobody asked for.
 *
 * Single-instance, like the rest of the scheduler state.
 */
type Entry = { content: FileContent; receivedAt: number };

const store = new Map<string, Entry>();

/** Long enough to ask several questions about a file, short enough to forget. */
const TTL_MS = 60 * 60_000;
const MAX_CHATS = 200;

export function rememberAttachment(chatId: string, content: FileContent): void {
  store.set(chatId, { content, receivedAt: Date.now() });

  // Bound memory: drop whatever expired, then the oldest if still over.
  if (store.size > MAX_CHATS) {
    const now = Date.now();
    for (const [id, entry] of store) {
      if (now - entry.receivedAt > TTL_MS) store.delete(id);
    }
    while (store.size > MAX_CHATS) {
      const oldest = [...store.entries()].sort((a, b) => a[1].receivedAt - b[1].receivedAt)[0];
      if (!oldest) break;
      store.delete(oldest[0]);
    }
  }
}

export function getAttachment(chatId: string): FileContent | null {
  const entry = store.get(chatId);
  if (!entry) return null;
  if (Date.now() - entry.receivedAt > TTL_MS) {
    store.delete(chatId);
    return null;
  }
  return entry.content;
}

export function clearAttachment(chatId: string): void {
  store.delete(chatId);
}


/**
 * The most recent output of write_code, held per chat.
 *
 * Exists so generated content never has to travel back through the model.
 * Returning a 7,000-character file to the model and asking it to echo every
 * character into the next tool call is slow, costs tokens twice, and fails —
 * which is exactly how a finished HTML page arrived as an empty-file error.
 */
type Generated = { content: string; language: string | null; at: number };

const generated = new Map<string, Generated>();

export function rememberGenerated(chatId: string, content: string, language?: string | null): void {
  generated.set(chatId, { content, language: language ?? null, at: Date.now() });
  if (generated.size > MAX_CHATS) {
    const oldest = [...generated.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) generated.delete(oldest[0]);
  }
}

export function getGenerated(chatId: string): Generated | null {
  const entry = generated.get(chatId);
  if (!entry) return null;
  if (Date.now() - entry.at > TTL_MS) {
    generated.delete(chatId);
    return null;
  }
  return entry;
}
