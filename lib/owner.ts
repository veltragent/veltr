import { mutateState, readState } from "./store";

/**
 * Who the bot is allowed to push messages to.
 *
 * There is a difference between a reply and a notification. A reply is asked
 * for; a notification arrives unbidden, and after a deploy it arrives at
 * whoever happened to have subscribed — which for this instance is four chats,
 * three of them not the operator's.
 *
 * So when an owner is configured, every *push* path is restricted to them:
 * corporate-action alerts, the daily brief, token-watch alerts, mission
 * updates. Replies to a message someone sent are untouched, because refusing to
 * answer a direct question is a different decision from not broadcasting.
 *
 * Unset, nothing changes — the bot broadcasts to every subscriber as before.
 */

/** Telegram usernames are case-insensitive and the @ is decoration. */
function normalise(value: string | null | undefined): string | null {
  const cleaned = (value ?? "").trim().replace(/^@/, "").toLowerCase();
  return cleaned || null;
}

export function ownerUsername(): string | null {
  return normalise(process.env.VELTR_OWNER_USERNAME);
}

/**
 * The owner's chat id, if it is known yet.
 *
 * Can be set directly, but usually is not: Telegram will not resolve a private
 * username to an id for a bot, so the id is learned the first time the owner
 * sends a message and then persisted.
 */
export async function ownerChatId(): Promise<string | null> {
  const configured = (process.env.VELTR_OWNER_CHAT_ID ?? "").trim();
  if (configured) return configured;

  const state = await readState();
  return state.ownerChatId ?? null;
}

/** Is the restriction switched on at all? */
export function ownerRestrictionEnabled(): boolean {
  return Boolean(ownerUsername() || (process.env.VELTR_OWNER_CHAT_ID ?? "").trim());
}

/**
 * Records the owner's chat id when they speak.
 *
 * Called on every inbound message, so the id is captured the first time the
 * operator says anything — no manual lookup, and it survives a restart.
 */
export async function learnOwner(chatId: string, username: string | null | undefined): Promise<void> {
  const expected = ownerUsername();
  if (!expected) return;
  if (normalise(username) !== expected) return;

  const state = await readState();
  if (state.ownerChatId === chatId) return;

  await mutateState((current) => ({
    state: { ...current, ownerChatId: chatId },
    result: undefined,
  }));
  console.log(`[veltr][OWNER] identified @${expected} as chat ${chatId}`);
}

/**
 * Filters a broadcast down to who may actually receive it.
 *
 * Fails closed. With a restriction configured but no owner identified yet, the
 * answer is nobody — sending to everyone "until we work out who the owner is"
 * is precisely the outcome the setting exists to prevent. One message from the
 * owner fixes it.
 */
export async function allowedRecipients(destinations: string[]): Promise<string[]> {
  if (!ownerRestrictionEnabled()) return destinations;

  const owner = await ownerChatId();
  if (!owner) {
    console.warn(
      `[veltr][OWNER] push suppressed for ${destinations.length} recipient(s): @${ownerUsername()} has not messaged the bot yet, so their chat id is unknown`
    );
    return [];
  }

  const allowed = destinations.filter((d) => d === owner);
  if (allowed.length < destinations.length) {
    console.log(
      `[veltr][OWNER] push restricted to owner: ${allowed.length}/${destinations.length} recipient(s)`
    );
  }
  return allowed;
}

/** Whether one specific chat may receive a push right now. */
export async function mayPush(chatId: string): Promise<boolean> {
  return (await allowedRecipients([chatId])).length > 0;
}
