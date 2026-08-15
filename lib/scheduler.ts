import { syncTelegram } from "./telegram";
import { runWatch } from "./watcher";
import { dispatchPending, registerBotCommands } from "./notify";
import { readState } from "./store";
import { runWatchCycleSafely } from "./watch/engine";
import { runTrackCycleSafely } from "./track/engine";
import { runScheduleCycleSafely } from "./agent/schedule-engine";
import { MIN_INTERVAL_SEC } from "./watch/settings";
import { acquireLease, keepLease, leaseHolder, INSTANCE_ID } from "./lease";

/**
 * In-process background scheduler.
 *
 * Runs three loops so the product works without any external cron:
 *
 *  - Telegram long-poll, continuous. Makes the bot reply immediately rather
 *    than only when someone happens to hit the sync endpoint.
 *  - Watcher, every 60s. The chain's median warning window is ~10 minutes, so a
 *    slower interval would miss actions entirely.
 *  - Daily brief, checked every 10 minutes, fired once per UTC day.
 *
 * Single-instance only. On a multi-replica deployment this must move to an
 * external scheduler, or every replica will poll and alert in parallel.
 */

let started = false;

const WATCH_INTERVAL_MS = 60_000;
const BRIEF_CHECK_MS = 10 * 60_000;
const BRIEF_HOUR_UTC = Number(process.env.VELTR_BRIEF_HOUR_UTC ?? 13);

/**
 * How often the token monitor wakes up.
 *
 * This is the tick, not the poll rate. Each watch carries its own interval and
 * the cycle only fetches the ones that are due, so ticking at the shortest
 * interval any user can select is what makes a 15-second setting mean 15 seconds
 * without making a 15-minute setting cost anything.
 */
const TOKEN_WATCH_TICK_MS = MIN_INTERVAL_SEC * 1000;

/** The change monitor decides per target when it is due; this is only the wake-up. */
const TRACK_TICK_MS = 5 * 60_000;

/**
 * How often a due recurring mission is picked up.
 *
 * The cycle runs at most one mission per tick — they take a minute or two and
 * cost several model calls — so this is a wake-up, not a rate.
 */
const SCHEDULE_TICK_MS = 5 * 60_000;

function log(...args: unknown[]) {
  console.log("[veltr:scheduler]", ...args);
}

async function telegramLoop() {
  if (!process.env.VELTR_TELEGRAM_BOT_TOKEN) {
    log("telegram loop disabled — no bot token");
    return;
  }
  // Registers the "/" autocomplete menu. Done once at boot rather than per
  // message — Telegram stores it against the bot, not the conversation.
  const registered = await registerBotCommands();
  log(`telegram long-poll started (command menu ${registered ? "registered" : "not registered"})`);

  for (;;) {
    try {
      const result = await syncTelegram(25);
      if (result.added || result.removed) {
        log(`telegram: +${result.added} −${result.removed} (${result.subscribers} total)`);
      }
    } catch (error) {
      log("telegram poll failed:", error instanceof Error ? error.message : error);
      // Back off so a persistent failure does not spin.
      await new Promise((r) => setTimeout(r, 15_000));
    }
  }
}

async function watchLoop() {
  log(`watcher started — every ${WATCH_INTERVAL_MS / 1000}s`);

  for (;;) {
    try {
      const result = await runWatch();
      if (result.changes.length > 0) {
        log(`detected ${result.changes.length} change(s):`, result.changes.map((c) => `${c.symbol} ${c.kind}`).join(", "));
        const delivery = await dispatchPending();
        log(`delivery: sent=${delivery.sent} failed=${delivery.failed}${delivery.skipped ? ` skipped=${delivery.skipped}` : ""}`);
      } else if (result.firstRun) {
        log(`baseline established across ${result.tokensChecked} tokens`);
      }
    } catch (error) {
      log("watch pass failed:", error instanceof Error ? error.message : error);
    }
    await new Promise((r) => setTimeout(r, WATCH_INTERVAL_MS));
  }
}

/**
 * Token watch monitor.
 *
 * One loop for every user and every watched token. Deliberately not one loop per
 * watch: the number of timers must not grow with the number of users, and a
 * token watched by many people must cost one market read, not one per watcher.
 */
async function tokenWatchLoop() {
  log(`token watcher started — tick every ${TOKEN_WATCH_TICK_MS / 1000}s`);

  for (;;) {
    const report = await runWatchCycleSafely();
    if (report && (report.alerts > 0 || report.unresolved > 0)) {
      log(
        `[WATCHER] due=${report.due} tokens=${report.tokensFetched} alerts=${report.alerts} sent=${report.sent} failed=${report.failed} unresolved=${report.unresolved} suppressed=${report.suppressed}`
      );
    }
    await new Promise((r) => setTimeout(r, TOKEN_WATCH_TICK_MS));
  }
}

/**
 * Change monitor for repositories and pages.
 *
 * Ticks far slower than the token watcher because the things it watches move on
 * human timescales — a commit, an edit — and because each target is one HTTP
 * request that no cache can dedupe across cycles.
 */
async function trackLoop() {
  log("track monitor started — tick every 5m");

  for (;;) {
    await new Promise((r) => setTimeout(r, TRACK_TICK_MS));
    const report = await runTrackCycleSafely();
    if (report && (report.changed > 0 || report.failed > 0)) {
      log(`[TRACK] due=${report.due} fetched=${report.fetched} changed=${report.changed} sent=${report.sent} failed=${report.failed}${report.paused ? ` paused=${report.paused}` : ""}`);
    }
  }
}

/** Recurring missions. Silent unless the figures a run observes actually move. */
async function scheduleLoop() {
  log("mission scheduler started — tick every 5m");

  for (;;) {
    await new Promise((r) => setTimeout(r, SCHEDULE_TICK_MS));
    const report = await runScheduleCycleSafely();
    if (report && report.ran > 0) {
      log(`[SCHEDULE] due=${report.due} ran=${report.ran} changed=${report.changed} sent=${report.sent} failed=${report.failed}`);
    }
  }
}

async function briefLoop() {
  for (;;) {
    await new Promise((r) => setTimeout(r, BRIEF_CHECK_MS));
    try {
      const now = new Date();
      const today = now.toISOString().slice(0, 10);
      const state = await readState();

      if (state.lastBriefSentOn === today) continue;
      if (now.getUTCHours() < BRIEF_HOUR_UTC) continue;
      if (state.subscriptions.length === 0) continue;

      // Routed through the HTTP endpoint so the once-per-day guard and the
      // deep-tier spend live in exactly one place.
      const port = process.env.PORT ?? "3000";
      const res = await fetch(`http://127.0.0.1:${port}/api/brief`, {
        method: "POST",
        headers: process.env.VELTR_CRON_SECRET
          ? { Authorization: `Bearer ${process.env.VELTR_CRON_SECRET}` }
          : {},
      });
      const json = await res.json();
      log("daily brief:", json.skipped ?? `sent=${json.sent} failed=${json.failed} via ${json.source}`);
    } catch (error) {
      log("brief check failed:", error instanceof Error ? error.message : error);
    }
  }
}

/** Lease name for the background loops. */
const SCHEDULER_LEASE = "scheduler";

/** How often a standing-by instance re-checks whether the lease has freed up. */
const LEASE_RETRY_MS = 10_000;

/**
 * Starts the background loops, if this instance is the one that should.
 *
 * Gated on a lease rather than on configuration: a second instance started by
 * hand — which is how the Telegram long-poll conflict actually happened here —
 * now serves HTTP and stays quiet instead of fighting the first for updates.
 * Nothing has to be remembered or passed to make that safe.
 */
export async function startScheduler(): Promise<void> {
  if (started) return;
  if (process.env.VELTR_SCHEDULER === "off") {
    log("disabled via VELTR_SCHEDULER=off");
    return;
  }

  /** Renders a lease expiry, or nothing at all when there is no usable one. */
  const expiryLabel = (expiresAt: string): string => {
    const at = new Date(expiresAt);
    return Number.isNaN(at.getTime()) ? "" : ` until ${at.toISOString().slice(11, 19)}Z`;
  };

  let acquired = await acquireLease(SCHEDULER_LEASE).catch(() => false);

  if (!acquired) {
    const holder = await leaseHolder(SCHEDULER_LEASE).catch(() => null);
    log(
      `standing by — the scheduler lease is held${holder ? ` by ${holder.holder}${expiryLabel(holder.expiresAt)}` : ""}. Serving HTTP; will take over if it is released or expires.`
    );

    /**
     * Keep asking, rather than giving up.
     *
     * A process killed without a clean shutdown leaves its lease warm for the
     * rest of the TTL. Trying once at boot meant a forced restart produced an
     * instance that served pages perfectly and never polled Telegram again —
     * the bot silently dead, with a healthy-looking web server in front of it.
     */
    acquired = await new Promise<boolean>((resolve) => {
      const timer = setInterval(async () => {
        if (await acquireLease(SCHEDULER_LEASE).catch(() => false)) {
          clearInterval(timer);
          resolve(true);
        }
      }, LEASE_RETRY_MS);
      timer.unref?.();
    });
  }

  started = true;
  log(`scheduler lease acquired by ${INSTANCE_ID}`);

  // Losing the lease means another instance took over. Nothing here can be
  // safely stopped mid-flight, so it is reported loudly rather than pretended
  // away — the loops are idempotent enough to overlap briefly, and a operator
  // seeing this knows two instances are running.
  keepLease(SCHEDULER_LEASE, () => {
    log("scheduler lease lost — a second instance is now driving. Stop this one.");
  });

  void telegramLoop();
  void watchLoop();
  void tokenWatchLoop();
  void trackLoop();
  void scheduleLoop();
  void briefLoop();
}
