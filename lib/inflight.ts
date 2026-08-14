/**
 * One request at a time per chat, and a way to abandon it.
 *
 * The lock matters more than the cancel. The expensive mistake is not a request
 * someone regrets — it is the second request they send because the first looked
 * dead, which runs a parallel model call for a single intention and bills twice.
 *
 * Cancellation is cooperative: the agent loop checks between rounds, so a tool
 * call already in flight still completes. An HTTP request cannot be recalled,
 * and pretending otherwise would make the guarantee a lie.
 */

type Slot = {
  startedAt: number;
  cancelled: boolean;
  label: string;
};

const inflight = new Map<string, Slot>();

/** A request that outlives this is assumed dead rather than holding the lock. */
const STALE_AFTER_MS = 5 * 60_000;

export type Claim = { ok: true; release: () => void } | { ok: false; busyForSeconds: number; label: string };

export function beginRequest(chatId: string, label = "your request"): Claim {
  const existing = inflight.get(chatId);

  if (existing) {
    const age = Date.now() - existing.startedAt;
    if (age < STALE_AFTER_MS) {
      return { ok: false, busyForSeconds: Math.round(age / 1000), label: existing.label };
    }
    // A slot this old means the holder crashed without releasing; keeping it
    // would lock the chat permanently.
    inflight.delete(chatId);
  }

  inflight.set(chatId, { startedAt: Date.now(), cancelled: false, label });

  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      inflight.delete(chatId);
    },
  };
}

/** Returns false when there was nothing to cancel. */
export function requestCancel(chatId: string): boolean {
  const slot = inflight.get(chatId);
  if (!slot) return false;
  slot.cancelled = true;
  return true;
}

export function isCancelled(chatId: string | null | undefined): boolean {
  if (!chatId) return false;
  return inflight.get(chatId)?.cancelled ?? false;
}

export function describeInflight(chatId: string): { label: string; seconds: number } | null {
  const slot = inflight.get(chatId);
  if (!slot) return null;
  return { label: slot.label, seconds: Math.round((Date.now() - slot.startedAt) / 1000) };
}
