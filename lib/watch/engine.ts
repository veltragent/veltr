import { evaluateWatch, type Alert } from "./alerts";
import { fetchSourceReadings, readingFor, type SourceReadings } from "./aggregate";
import { renderAlert } from "./format";
import { listAllWatches, getSettingsFor, persistCycle } from "./store";
import { fetchPremiums, type PremiumReadingLite } from "./premium";
import { DEFAULT_SETTINGS } from "./settings";
import type { TokenWatch, WatchSettings } from "./types";

/**
 * The monitoring engine.
 *
 * One centralised cycle for every user and every token, rather than a loop or a
 * timer per watch. Three properties follow from that, and all three are the point:
 *
 *  - A token watched by a hundred users is fetched once per cycle, not a hundred
 *    times. The market reading is a property of the token; only the evaluation is
 *    a property of the user.
 *  - Adding a watch starts no process. It appends a row, and the next cycle picks
 *    it up — so /watch cannot leak a timer, and a restart loses nothing.
 *  - Provider load is bounded by the number of distinct tokens under watch, not
 *    by the number of users, which is what makes a free API tier viable.
 *
 * Every dependency is injectable so a full cycle — dedup, evaluation, cooldown,
 * delivery — runs in a test with no network, no bot token and no state file.
 */

export type EngineDeps = {
  loadWatches: () => Promise<TokenWatch[]>;
  loadSettings: (userIds: string[]) => Promise<Map<string, WatchSettings>>;
  fetchReadings: (
    addresses: string[],
    sources: Pick<WatchSettings, "useDexScreener" | "useGeckoTerminal">
  ) => Promise<SourceReadings>;
  /** Premium per address, for the tokens whose watchers asked for it. */
  fetchPremiums: (addresses: string[]) => Promise<Map<string, PremiumReadingLite>>;
  persist: (watches: TokenWatch[]) => Promise<void>;
  send: (userId: string, text: string) => Promise<boolean>;
  now: () => Date;
};

/**
 * Ceiling on alerts delivered to one user in one cycle.
 *
 * Re-arm already prevents a single condition repeating, so hitting this means
 * many conditions crossed at once — a listing, a rug, or a bad reading. Ten
 * messages is the point past which more is not more informative.
 */
export const MAX_ALERTS_PER_USER_PER_CYCLE = 10;

export type CycleReport = {
  ranAt: string;
  /** Watches that were due this tick. */
  due: number;
  /** Distinct token addresses fetched — the number that actually costs quota. */
  tokensFetched: number;
  /** Watches whose token returned no usable reading from any enabled source. */
  unresolved: number;
  alerts: number;
  sent: number;
  failed: number;
  suppressed: number;
};

function defaultDeps(): EngineDeps {
  return {
    loadWatches: listAllWatches,
    loadSettings: getSettingsFor,
    fetchReadings: (addresses, sources) =>
      fetchSourceReadings(addresses, { settings: { ...DEFAULT_SETTINGS, ...sources } }),
    fetchPremiums: (addresses) => fetchPremiums(addresses),
    persist: persistCycle,
    send: async (userId, text) => {
      // A watch alert is a push. If an owner is configured, only they get one —
      // even though the watch belongs to whoever created it.
      const { mayPush } = await import("../owner");
      if (!(await mayPush(userId))) return false;

      const { sendTelegram } = await import("../notify");
      return sendTelegram(userId, text);
    },
    now: () => new Date(),
  };
}

/** A watch is due when its user's interval has elapsed since it was last checked. */
export function isDue(watch: TokenWatch, settings: WatchSettings, now: Date): boolean {
  if (!watch.enabled) return false;
  if (!watch.lastCheckedAt) return true;
  const elapsed = now.getTime() - new Date(watch.lastCheckedAt).getTime();
  // A clock moving backwards (NTP correction, a restored backup) would otherwise
  // park a watch until real time caught up.
  if (elapsed < 0) return true;
  return elapsed >= settings.checkIntervalSec * 1000;
}

/**
 * One monitoring pass.
 *
 * Never throws: the scheduler calls this forever, and an exception escaping here
 * would take down the loop that every watch depends on.
 */
export async function runWatchCycle(overrides: Partial<EngineDeps> = {}): Promise<CycleReport> {
  const deps: EngineDeps = { ...defaultDeps(), ...overrides };
  const now = deps.now();
  const report: CycleReport = {
    ranAt: now.toISOString(),
    due: 0,
    tokensFetched: 0,
    unresolved: 0,
    alerts: 0,
    sent: 0,
    failed: 0,
    suppressed: 0,
  };

  const watches = await deps.loadWatches();
  if (watches.length === 0) return report;

  const settingsByUser = await deps.loadSettings([...new Set(watches.map((w) => w.userId))]);
  const settingsFor = (userId: string) => settingsByUser.get(userId) ?? DEFAULT_SETTINGS;

  const due = watches.filter((w) => isDue(w, settingsFor(w.userId), now));
  report.due = due.length;
  if (due.length === 0) return report;

  // Deduplication happens here and nowhere else: many watches collapse to the
  // set of distinct tokens, and that set is what reaches the providers.
  const addresses = [...new Set(due.map((w) => w.tokenAddress.toLowerCase()))];
  report.tokensFetched = addresses.length;

  // A provider is queried when any user due this cycle wants it, and the result
  // is then filtered back down per user — so one person disabling a source never
  // costs another person their data, and never causes a second call.
  const sources = {
    useDexScreener: due.some((w) => settingsFor(w.userId).useDexScreener),
    useGeckoTerminal: due.some((w) => settingsFor(w.userId).useGeckoTerminal),
  };

  const readings = await deps.fetchReadings(addresses, sources);

  /**
   * Premium, for the tokens where anyone is actually watching it.
   *
   * Every constraint here is about not spending an equity quote nobody asked
   * for. The pool providers do not report premium; it needs a second call to an
   * equity feed, per symbol, and this cycle ticks every fifteen seconds.
   *
   * So: only tokens whose watcher has set a premium threshold, only when the
   * equity market is open — a closed market makes the alert impossible anyway,
   * which removes the cost overnight and at weekends entirely — and deduplicated
   * by symbol, exactly as the token readings are by address.
   */
  const wantsPremium = new Set(
    due
      .filter((w) => {
        const s = settingsFor(w.userId);
        return s.premiumAbove !== null || s.premiumBelow !== null;
      })
      .map((w) => w.tokenAddress.toLowerCase())
  );

  const premiums = wantsPremium.size > 0 ? await deps.fetchPremiums([...wantsPremium]) : new Map();

  const updated: TokenWatch[] = [];
  const alertsByUser = new Map<string, Alert[]>();

  for (const watch of due) {
    const settings = settingsFor(watch.userId);
    const market = readingFor(readings, watch.tokenAddress, settings);

    // No usable reading. The watch is left exactly as it was — not marked as
    // checked, not advanced — so the next cycle retries rather than treating an
    // outage as a price of nothing.
    if (!market || market.priceUsd === null) {
      report.unresolved++;
      continue;
    }

    const premium = premiums.get(watch.tokenAddress.toLowerCase());
    const withPremium = premium
      ? {
          ...market,
          premiumPct: premium.premiumPct,
          premiumIsStale: premium.isStale,
          equityPriceUsd: premium.equityPriceUsd,
        }
      : market;

    const result = evaluateWatch(watch, withPremium, settings, now);
    updated.push(result.watch);
    report.suppressed += result.suppressedByCooldown.length;

    if (result.alerts.length > 0) {
      const existing = alertsByUser.get(watch.userId) ?? [];
      alertsByUser.set(watch.userId, [...existing, ...result.alerts]);
    }
  }

  await deps.persist(updated);

  for (const [userId, alerts] of alertsByUser) {
    const capped = alerts.slice(0, MAX_ALERTS_PER_USER_PER_CYCLE);
    if (capped.length < alerts.length) {
      console.warn(
        `[veltr][ALERT] capped user=${userId} fired=${alerts.length} sent=${capped.length}`
      );
    }

    for (const alert of capped) {
      report.alerts++;
      const ok = await deps.send(userId, renderAlert(alert));
      if (ok) report.sent++;
      else report.failed++;
      console.log(
        `[veltr][ALERT] ${ok ? "sent" : "failed"} kind=${alert.kind} token=${alert.tokenAddress} symbol=${
          alert.symbol ?? "?"
        } value=${alert.value} threshold=${alert.threshold}`
      );
    }
  }

  return report;
}

/**
 * The scheduler's entry point.
 *
 * Swallows everything: a provider shape change or a corrupt row must not stop the
 * loop, because the loop is the feature.
 */
export async function runWatchCycleSafely(): Promise<CycleReport | null> {
  try {
    return await runWatchCycle();
  } catch (error) {
    console.error("[veltr][WATCHER] cycle failed:", error instanceof Error ? error.message : error);
    return null;
  }
}
