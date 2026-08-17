import { randomUUID } from "node:crypto";
import { isAddress } from "viem";
import { readState, writeState, type Subscription } from "./store";
import {
  sendTelegram,
  sendPhoto,
  withActivity,
  sendPlaceholder,
  editMessage,
  deleteMessage,
  reactTo,
  answerCallback,
} from "./notify";
import {
  classifyAddress,
  handleCallbackData,
  handleCustomValue,
  handleSettings,
  handleUnwatch,
  handleWatch,
  handleWatches,
  cancelPending,
  hasPending,
  type Reply,
} from "./watch/commands";
import { removeAllWatches } from "./watch/store";
import {
  MISSION_NS,
  handleMission,
  handleMissionCallback,
  handleMissions,
  missionSummary,
} from "./agent/commands";
import { removeAllMissions } from "./agent/store";
import { learnOwner, isOwner } from "./owner";
import { describeSpend, spendToday } from "./spend";
import { describeCensus, readLatest } from "./backup";
import { handleTrack, handleTracks, handleUntrack } from "./track/commands";
import { removeAllTracks } from "./track/store";
import { handleEvery, handleSchedules, handleUnschedule } from "./agent/schedule-commands";
import { removeAllSchedules } from "./agent/schedule-engine";
import { runCommand, clamp, BOT_HELP, INTRODUCTION } from "./bot-commands";
import { runAgentLoop } from "./agent-loop";
import { startProgress } from "./progress";
import { beginRequest, requestCancel, describeInflight } from "./inflight";
import { reactionFor, reactionDelayMs, FILE_RECEIVED_EMOJI } from "./reactions";
import { downloadFile, isReadableAsText, MAX_DOWNLOAD_BYTES } from "./files";
import { rememberAttachment } from "./attachments";

/**
 * Takes delivery of an uploaded file.
 *
 * Stored against the chat so the next question can refer to it, and acknowledged
 * immediately — a silent upload leaves the user unsure whether it arrived.
 * Returns false when the file could not be read, so a caption is not answered as
 * though the attachment were available.
 */
async function ingestDocument(
  chatId: string,
  doc: { file_id: string; file_name?: string; mime_type?: string; file_size?: number },
  name: string | null
): Promise<boolean> {
  const filename = doc.file_name ?? "attachment";
  const size = doc.file_size ?? 0;

  if (size > MAX_DOWNLOAD_BYTES) {
    await sendTelegram(chatId, `${filename} is ${Math.round(size / 1024 / 1024)}MB. Telegram caps bot downloads at 20MB.`);
    return false;
  }

  if (!isReadableAsText(filename, doc.mime_type)) {
    await sendTelegram(
      chatId,
      `I can only read text-based files — code, markdown, HTML, CSV, JSON and similar. ${filename} is not one, and reading it as text would produce nonsense rather than an error.`
    );
    return false;
  }

  const content = await withActivity(chatId, "typing", () =>
    downloadFile({ fileId: doc.file_id, name: filename, mimeType: doc.mime_type ?? null, sizeBytes: size })
  );

  if (!content?.text) {
    await sendTelegram(chatId, `Could not read ${filename}.`);
    return false;
  }

  rememberAttachment(chatId, content);

  const lines = content.text.split("\n").length;
  await sendTelegram(
    chatId,
    [
      `${name ? name + ", got it" : "Got it"} — ${filename}`,
      `${lines.toLocaleString()} lines, ${Math.round(content.bytes / 1024)}KB${content.truncated ? " (truncated)" : ""}`,
      "",
      "Ask me anything about it, or tell me what to do with it:",
      "  explain what this does",
      "  clean this up and send it back",
      "  turn this into an HTML page",
      "  find the bug",
    ].join("\n")
  );
  return true;
}

const GOODBYE = "Unsubscribed. Send /start to resume alerts.";

type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; first_name?: string; username?: string; title?: string };
    from?: { first_name?: string; username?: string };
    text?: string;
    caption?: string;
    document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  };
  /** Inline-keyboard press. Carries the message the keyboard is attached to. */
  callback_query?: {
    id: string;
    data?: string;
    from?: { id?: number; first_name?: string; username?: string };
    message?: { message_id: number; chat: { id: number } };
  };
};

/**
 * Delivers a watch-feature reply.
 *
 * A reply marked `edit` replaces the message its button was attached to, so a
 * settings panel is navigated in place rather than growing a new message per tap.
 * Telegram rejects an edit whose text and markup are both unchanged, which is not
 * an error worth reporting — the panel already shows what was asked for.
 */
async function deliverReply(chatId: string, reply: Reply, editMessageId?: number): Promise<void> {
  const markup = reply.keyboard;

  if (reply.edit && editMessageId) {
    const edited = await editMessage(chatId, editMessageId, clamp(reply.text), {
      replyMarkup: markup,
    });
    if (edited) return;
  }

  await sendTelegram(chatId, clamp(reply.text), { replyMarkup: markup });
}

/**
 * Handles one inline-keyboard press.
 *
 * The acting identity is the chat the keyboard lives in, never anything inside
 * the payload — a forged callback therefore reaches only the sender's own
 * settings, which their own buttons already reach.
 */
async function handleCallbackQuery(
  query: NonNullable<TelegramUpdate["callback_query"]>
): Promise<void> {
  const chatId = query.message?.chat?.id;
  if (chatId === undefined || !query.data) {
    await answerCallback(query.id);
    return;
  }

  const chat = String(chatId);
  const messageId = query.message?.message_id;

  try {
    // Each feature owns a callback namespace, so a button can only ever reach
    // the handler that created it.
    if (query.data.startsWith(`${MISSION_NS}:`)) {
      // Approving an action resumes the mission, which can take a while — the
      // press is acknowledged first so the button stops spinning immediately.
      await answerCallback(query.id, "Working…");
      const outcome = await withActivity(chat, "typing", () =>
        handleMissionCallback(chat, query.data as string)
      );
      if (outcome.reply) await deliverReply(chat, outcome.reply, messageId);
      return;
    }

    const outcome = await handleCallbackData(chat, query.data);
    await answerCallback(query.id, outcome.toast);
    if (outcome.reply) await deliverReply(chat, outcome.reply, messageId);
  } catch (error) {
    console.error("[veltr] callback failed:", error);
    await answerCallback(query.id, "That did not work. Try again.");
  }
}

/** Prefer the person's own first name; fall back to their handle. */
function displayName(message: NonNullable<TelegramUpdate["message"]>): string | null {
  const raw =
    message.from?.first_name ??
    message.chat.first_name ??
    message.from?.username ??
    message.chat.username ??
    null;
  if (!raw) return null;

  // Telegram names often carry decorative marks and invisible characters; a
  // greeting built from those reads as broken rather than personal.
  const cleaned = raw
    .replace(/[​-‏‪-‮️]/g, "")
    .replace(/[^\p{L}\p{N}\s'’.-]/gu, "")
    .trim()
    .split(/\s+/)[0];

  return cleaned && cleaned.length >= 2 ? cleaned : null;
}

/** One natural greeting line for command replies. */
function greet(name: string | null, kind: "chart" | "data"): string {
  if (!name) return "";
  return kind === "chart" ? `${name}, here is the chart.\n\n` : `${name}, here is what I have.\n\n`;
}

export type SyncResult = {
  processed: number;
  added: number;
  removed: number;
  subscribers: number;
};

/**
 * Drains pending Telegram updates and reconciles subscriptions.
 *
 * `longPollSeconds` controls how long Telegram holds the connection open when
 * there is nothing new. The scheduler passes a non-zero value so replies feel
 * immediate; the HTTP route passes 0 so a manual sync returns straight away.
 */
export async function syncTelegram(longPollSeconds = 0): Promise<SyncResult> {
  const token = process.env.VELTR_TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("VELTR_TELEGRAM_BOT_TOKEN is not set.");

  const state = await readState();
  const offset = state.lastTelegramUpdateId ? state.lastTelegramUpdateId + 1 : undefined;

  const url = new URL(`https://api.telegram.org/bot${token}/getUpdates`);
  if (offset) url.searchParams.set("offset", String(offset));
  url.searchParams.set("timeout", String(longPollSeconds));

  const res = await fetch(url, {
    signal: AbortSignal.timeout((longPollSeconds + 15) * 1000),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.description ?? "getUpdates failed");

  const updates: TelegramUpdate[] = json.result ?? [];

  /**
   * Acknowledge everything in the batch before working on any of it.
   *
   * Replies are produced one at a time — an agent answer is awaited inside the
   * loop below — so a second message would otherwise wait out the first one's
   * whole run before so much as being reacted to. The emoji costs nothing and
   * depends only on the text, so there is no reason for it to queue behind
   * somebody else's mission.
   *
   * Dispatched, never awaited: a cosmetic acknowledgement must not hold up the
   * answer it is meant to precede.
   */
  for (const update of updates) {
    const message = update.message;
    if (!message?.message_id) continue;

    const chat = String(message.chat.id);
    const messageId = message.message_id;
    const intent = message.document
      ? FILE_RECEIVED_EMOJI
      : reactionFor(message.text ?? message.caption ?? "");
    const delay = reactionDelayMs();

    void (delay > 0
      ? new Promise((r) => setTimeout(r, delay)).then(() => reactTo(chat, messageId, intent))
      : reactTo(chat, messageId, intent));
  }

  let subscriptions = [...state.subscriptions];
  let added = 0;
  let removed = 0;
  let cursor = state.lastTelegramUpdateId;

  for (const update of updates) {
    cursor = Math.max(cursor ?? 0, update.update_id);

    // Button presses arrive as their own update kind and carry no message text.
    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query);
      continue;
    }

    const message = update.message;
    if (!message) continue;

    const chatId = String(message.chat.id);
    const name = displayName(message);

    // Telegram will not resolve a private @username to a chat id for a bot, so
    // the owner is identified the only way available: by speaking. Recorded once,
    // then persisted, so the push restriction survives a restart.
    void learnOwner(chatId, message.from?.username).catch(() => {});

    // The reaction for this message has already gone out, above, before any of
    // the batch was worked on.

    // A document may arrive with a caption instead of text; the caption is the
    // instruction, so it is treated as the message.
    if (message.document) {
      const handled = await ingestDocument(chatId, message.document, name);
      if (handled && !message.caption) continue;
    }
    // Commands are matched case-insensitively, but arguments keep their original
    // case — an address must survive as the user typed it.
    const raw = (message.text ?? message.caption ?? "").trim();
    const text = raw.toLowerCase();

    if (text === "/cancel") {
      // A pending settings prompt is also "the thing currently running" from the
      // user's point of view, so /cancel must clear it too.
      const clearedPrompt = cancelPending(chatId);
      const running = describeInflight(chatId);
      const cancelled = requestCancel(chatId);
      await sendTelegram(
        chatId,
        cancelled
          ? `Cancelling ${running?.label ?? "the request"} (running ${running?.seconds ?? 0}s).

A step already in flight will finish — an HTTP call cannot be recalled — but nothing further will run.`
          : clearedPrompt
            ? "Setting left unchanged."
            : "Nothing is running right now."
      );
      continue;
    }

    if (text === "/stop") {
      const before = subscriptions.length;
      subscriptions = subscriptions.filter((s) => s.destination !== chatId);
      if (subscriptions.length < before) {
        removed++;
        // Token watches and missions both deliver through this channel, so
        // leaving them behind would keep messaging someone who unsubscribed.
        const dropped = await removeAllWatches(chatId).catch(() => 0);
        const missions = await removeAllMissions(chatId).catch(() => 0);
        const tracks = await removeAllTracks(chatId).catch(() => 0);
        const schedules = await removeAllSchedules(chatId).catch(() => 0);
        const extra = [
          dropped > 0 ? `stopped watching ${dropped} token${dropped === 1 ? "" : "s"}` : "",
          missions > 0 ? `discarded ${missions} mission${missions === 1 ? "" : "s"}` : "",
          tracks > 0 ? `stopped tracking ${tracks} target${tracks === 1 ? "" : "s"}` : "",
          schedules > 0 ? `cancelled ${schedules} schedule${schedules === 1 ? "" : "s"}` : "",
        ].filter(Boolean);
        await sendTelegram(
          chatId,
          extra.length > 0 ? `${GOODBYE}\n\nAlso ${extra.join(" and ")}.` : GOODBYE
        );
      }
      continue;
    }

    // A typed threshold answers a prompt the bot raised. Only a plain message can
    // be an answer — a slash command means the user moved on, so the prompt is
    // dropped and the command runs normally.
    if (hasPending(chatId)) {
      if (raw.startsWith("/")) {
        cancelPending(chatId);
      } else {
        const reply = await handleCustomValue(chatId, raw);
        if (reply) {
          await deliverReply(chatId, reply);
          continue;
        }
      }
    }

    // Market commands resolve against the same data layer the website uses, so
    // the bot and the site can never quote different numbers.
    const isCommand = raw.startsWith("/");
    const isChart = text.startsWith("/chart");

    // Only slow work gets a placeholder. Instant replies like /help would
    // otherwise flash a "thinking" message the user never finishes reading.
    const slowCommand =
      /^\/(price|chart|premium|token|news|market|splits|chain|flow|delegation|positions)\b/.test(text);
    let progressId: number | null = null;
    if (slowCommand) {
      progressId = await sendPlaceholder(chatId, isChart ? "Drawing chart…" : "Thinking…");
    }

    const command = await withActivity(chatId, isChart ? "upload_photo" : "typing", () =>
      runCommand(raw, chatId)
    );

    if (command.handled) {
      if (command.imageUrl) {
        // The placeholder cannot become a photo, so it is removed and the image
        // sent in its place.
        if (progressId) await deleteMessage(chatId, progressId);
        const ok = await sendPhoto(chatId, command.imageUrl, greet(name, "chart") + command.text);
        if (ok) continue;
        await sendTelegram(chatId, clamp(greet(name, "chart") + command.text), { markdown: true });
        continue;
      }

      const body = clamp(greet(name, "data") + command.text);
      const edited = progressId
        ? await editMessage(chatId, progressId, body, { markdown: true })
        : false;
      if (!edited) {
        if (progressId) await deleteMessage(chatId, progressId);
        await sendTelegram(chatId, body, { markdown: true });
      }
      continue;
    }

    // Not a recognised command — clear any placeholder before falling through.
    if (progressId) await deleteMessage(chatId, progressId);

    // Slash commands are matched on the verb alone, so "/watch@veltragent_bot"
    // in a group behaves the same as "/watch" in a direct message.
    const [verbToken, ...verbRest] = raw.split(/\s+/);
    const verb = verbToken.toLowerCase().split("@")[0];
    const verbArg = verbRest.join(" ").trim();

    /** Scopes corporate-action alerts to a wallet — the original /watch. */
    const setWalletScope = async (address: string, preamble = "") => {
      const sub = subscriptions.find((s) => s.destination === chatId);
      if (!sub) {
        await sendTelegram(chatId, "Send /start first, then /watch <address>.");
        return;
      }
      sub.address = address;
      await sendTelegram(
        chatId,
        `${preamble}Watching ${address}.\n\nYou will now only be alerted about tokens this wallet actually holds, and each alert will show the effect on your own position.\n\nSend /unwatch to return to chain-wide alerts.`
      );
    };

    if (verb === "/watches" || verb === "/watchlist") {
      const progressId = await sendPlaceholder(chatId, "Reading your watchlist…");
      const reply = await withActivity(chatId, "typing", () => handleWatches(chatId));
      if (progressId) await deleteMessage(chatId, progressId);
      await deliverReply(chatId, reply);
      continue;
    }

    if (verb === "/settings") {
      const reply = await handleSettings(chatId, verbArg);
      await deliverReply(chatId, reply);
      continue;
    }

    if (verb === "/track" || verb === "/tracks" || verb === "/untrack") {
      const reply =
        verb === "/tracks"
          ? await withActivity(chatId, "typing", () => handleTracks(chatId))
          : verb === "/untrack"
            ? await handleUntrack(chatId, verbArg)
            : await withActivity(chatId, "typing", () => handleTrack(chatId, verbArg));
      await sendTelegram(chatId, clamp(reply.text));
      continue;
    }

    // Operational, not market: what the system is costing, and whether its own
    // backups are running. Answered only for the operator — to anyone else it
    // does not exist, which is why it is not in the command menu either.
    if (verb === "/spend") {
      if (!(await isOwner(chatId))) {
        await sendTelegram(chatId, "Unknown command. /help for what I can do.");
        continue;
      }
      const [spend, snapshot] = await Promise.all([spendToday(), readLatest()]);
      await sendTelegram(
        chatId,
        [
          describeSpend(spend),
          "",
          snapshot
            ? `Last backup ${snapshot.at.slice(0, 16).replace("T", " ")}Z — ${describeCensus(snapshot.counts)}`
            : "No backup has been taken yet.",
        ].join("\n")
      );
      continue;
    }

    if (verb === "/every" || verb === "/schedules" || verb === "/unschedule") {
      const reply =
        verb === "/schedules"
          ? await handleSchedules(chatId)
          : verb === "/unschedule"
            ? await handleUnschedule(chatId, verbArg)
            : await handleEvery(chatId, verbArg);
      await sendTelegram(chatId, clamp(reply.text));
      continue;
    }

    if (verb === "/missions") {
      const reply = await withActivity(chatId, "typing", () => handleMissions(chatId));
      await deliverReply(chatId, reply);
      continue;
    }

    if (verb === "/mission") {
      // A mission runs several model calls and many tool calls. The same lock the
      // agent loop uses applies here: a second mission started because the first
      // looked slow would double the spend for one intention.
      const claim = beginRequest(chatId, "your mission");
      if (!claim.ok) {
        await sendTelegram(
          chatId,
          `Still working on ${claim.label} (${claim.busyForSeconds}s so far).\n\nSend /cancel to abandon it.`
        );
        continue;
      }

      const progressId = await sendPlaceholder(chatId, "🎯 ANALYZING");
      let shown = "";
      // Status only, never reasoning — and only on change, since Telegram rate
      // limits edits to a message.
      const onStatus = (status: string) => {
        if (status === shown || !progressId) return;
        shown = status;
        void editMessage(chatId, progressId, `🎯 ${status}`);
      };

      const reply = await withActivity(chatId, "typing", () =>
        handleMission(chatId, verbArg, onStatus).catch((error) => {
          console.error("[veltr][AGENT] mission command failed:", error);
          return { text: "The mission could not be run. Try again, or use /help for direct commands." };
        })
      );

      claim.release();
      if (progressId) await deleteMessage(chatId, progressId);
      await deliverReply(chatId, reply);
      continue;
    }

    if (verb === "/watch") {
      // Two things have always been reachable through this one command: a wallet
      // to scope alerts to, and — now — a token to monitor. Both are EVM
      // addresses, so the chain is asked which one this is rather than the user.
      // An explicit "wallet"/"token" prefix overrides the guess.
      const forced = /^(wallet|token)\s+(.+)$/i.exec(verbArg);
      const target = (forced ? forced[2] : verbArg).trim();
      const mode = forced ? forced[1].toLowerCase() : null;

      if (!isAddress(target)) {
        await sendTelegram(
          chatId,
          [
            "Send a valid address.",
            "",
            "/watch 0x2e8c31162b855a2ffa90f6f8634643ad6f111e18   monitor a token",
            "/watch 0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d   scope alerts to a wallet",
            "",
            "I work out which one it is from the address itself.",
          ].join("\n")
        );
        continue;
      }

      if (mode === "wallet") {
        await setWalletScope(target);
        continue;
      }

      // An account with no code is certainly a wallet, and skips the lookup.
      const kind = mode === "token" ? "contract" : await classifyAddress(target);

      if (kind === "wallet") {
        await setWalletScope(target);
        continue;
      }

      const progressId = await sendPlaceholder(chatId, "Looking up the token…");
      const reply = await withActivity(chatId, "typing", () => handleWatch(chatId, target));
      if (progressId) await deleteMessage(chatId, progressId);

      // A contract that does not trade is not a token — and on this chain it is
      // very often a smart-contract wallet. Falling back keeps /watch a strict
      // superset of what it did before, so no existing user loses the command.
      if (reply.notFound && mode !== "token") {
        await setWalletScope(
          target,
          "That address has no indexed trading pair on Robinhood Chain, so I have read it as a wallet.\n\n"
        );
        continue;
      }

      await deliverReply(chatId, reply);
      continue;
    }

    if (verb === "/unwatch") {
      // Bare /unwatch keeps its original meaning: back to chain-wide alerts.
      // With an address it removes that token from the watchlist instead.
      if (verbArg && isAddress(verbArg)) {
        const reply = await handleUnwatch(chatId, verbArg);
        await deliverReply(chatId, reply);
        continue;
      }

      const sub = subscriptions.find((s) => s.destination === chatId);
      if (sub?.address) {
        sub.address = null;
        await sendTelegram(chatId, "Back to chain-wide alerts across all 95 stock tokens.");
        continue;
      }

      // No wallet scope to clear — offer the token watchlist, which is what the
      // user most likely meant.
      const reply = await handleUnwatch(chatId, "");
      if (reply.keyboard) {
        await deliverReply(chatId, reply);
      } else {
        await sendTelegram(chatId, "You are already on chain-wide alerts.");
      }
      continue;
    }

    if (text === "/status") {
      const tracked = Object.keys(state.lastMultiplier).length;
      const pending = Object.values(state.lastPending).filter((v) => v !== null).length;
      const scope = subscriptions.find((s) => s.destination === chatId)?.address;
      const watched = (state.tokenWatches ?? []).filter((w) => w.userId === chatId).length;
      const missions = await missionSummary(chatId).catch(() => ({ total: 0, waiting: 0 }));
      await sendTelegram(
        chatId,
        [
          `Tracking ${tracked} stock tokens.`,
          `${pending} corporate action${pending === 1 ? "" : "s"} currently scheduled.`,
          `Last checked: ${state.lastRunAt ?? "never"}.`,
          `Scope: ${scope ?? "chain-wide"}.`,
          `Token watchlist: ${watched} token${watched === 1 ? "" : "s"}${watched ? " — /watches" : ""}.`,
          `Missions: ${missions.total}${missions.waiting ? ` — ${missions.waiting} awaiting your approval` : ""}${missions.total ? " — /missions" : ""}.`,
        ].join("\n")
      );
      continue;
    }

    const alreadySubscribed = subscriptions.some((s) => s.destination === chatId);

    /*
     * They are demonstrably reachable, so any "unreachable" mark is stale.
     *
     * Without this, a user who blocked the bot and later unblocked it would stay
     * silently excluded from chain-wide alerts forever — the mark is only ever
     * set by a failed broadcast, and nothing else would clear it.
     */
    if (alreadySubscribed) {
      const { clearUndeliverable } = await import("./intel/broadcast");
      void clearUndeliverable(chatId).catch(() => {});
    }

    // An unrecognised slash command is a typo, not a question. Sending "/prcie"
    // to the language model would produce a confident guess; the command list
    // is the useful reply.
    if (raw.startsWith("/") && text !== "/start" && alreadySubscribed) {
      await sendTelegram(chatId, BOT_HELP);
      continue;
    }

    if (text === "/start" && alreadySubscribed) {
      await sendTelegram(chatId, "Already subscribed.\n\n" + BOT_HELP);
      continue;
    }

    if (!alreadySubscribed) {
      const subscription: Subscription = {
        id: randomUUID(),
        address: null,
        channel: "telegram",
        destination: chatId,
        minDeltaPct: 0,
        createdAt: new Date().toISOString(),
      };
      subscriptions.push(subscription);
      added++;

      // The same introduction for everyone. It is the one message that has to
      // land, and a per-person variant which sometimes fell back to a shorter
      // text meant nobody could know what a new reader actually saw.
      await sendTelegram(chatId, clamp(INTRODUCTION));
      continue;
    }

    // Anything else from a subscriber is a question, not noise. Previously these
    // were dropped, which made the bot look broken to anyone who typed a
    // sentence instead of a command.
    if (raw.length > 1 && !isCommand) {
      // One request at a time. A second message while the first is running is
      // almost always impatience, not a new question — and answering it would
      // run a parallel model call for the same intention.
      const claim = beginRequest(chatId, "your request");
      if (!claim.ok) {
        await sendTelegram(
          chatId,
          `Still working on ${claim.label} (${claim.busyForSeconds}s so far).

Send /cancel to abandon it, or wait — I will reply when it is done.`
        );
        continue;
      }

      // The status line names the tool actually running, so a long request reads
      // as progress rather than a stall, then becomes the answer in place.
      const progress = await startProgress(chatId, "Thinking");

      const result = await withActivity(chatId, "typing", () =>
        runAgentLoop(raw, { chatId }, name, (tool) => progress.tool(tool)).catch((error) => {
          console.error("[veltr] agent loop failed:", error);
          return {
            answer:
              "That question could not be answered right now. The market data or model may be rate-limiting — try again, or use /help for direct commands.",
            source: "error",
            toolsUsed: [] as string[],
            actions: [] as string[],
            rounds: 0,
          };
        })
      );

      if (result.toolsUsed.length) {
        console.log(`[veltr] agent used ${result.toolsUsed.join(", ")}${result.actions.length ? ` | acted: ${result.actions.join(", ")}` : ""}`);
      }
      const answer = result.answer;

      const body = clamp(answer);
      claim.release();
      progress.finish();

      const edited = progress.messageId
        ? await editMessage(chatId, progress.messageId, body)
        : false;
      if (!edited) {
        await progress.discard();
        const sent = await sendTelegram(chatId, body);
        if (!sent) console.warn("[veltr] failed to deliver answer to", chatId);
      }
    }
  }

  // The long-poll returns empty most of the time; writing then would churn the
  // state file every cycle and defeat the mtime-based cache in readState.
  if (updates.length > 0) {
    // Re-read: a concurrent watcher pass may have written changes meanwhile.
    const fresh = await readState();
    await writeState({ ...fresh, subscriptions, lastTelegramUpdateId: cursor });
  }

  return { processed: updates.length, added, removed, subscribers: subscriptions.length };
}
