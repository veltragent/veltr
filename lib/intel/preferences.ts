import type { WatchSettings } from "../watch/types";
import { DEFAULT_SIGNAL_PREFERENCES, SIGNAL_KINDS, type SignalKind, type SignalPreferences } from "./signals";

/**
 * Signal preferences, read out of the settings a user already has.
 *
 * Deliberately not a second settings store. `WatchSettings` is already
 * persisted per user, already normalised on read, already editable through
 * /settings, and already carries the guarantee that one user's values are never
 * visible to another. A parallel store would need all of that again and would
 * be one more thing to keep in step.
 *
 * The three fields are optional on the stored object, so settings written before
 * this existed load unchanged and fall back to the defaults.
 */

export type SignalSettings = {
  signalsEnabled?: boolean;
  signalMinConfidence?: number;
  signalKinds?: string[];
  signalCooldownSec?: number;
};

export type WatchSettingsWithSignals = WatchSettings & SignalSettings;

export const MIN_CONFIDENCE = 0;
export const MAX_CONFIDENCE = 95;
/** A signal cannot repeat faster than this, whatever the user asks for. */
export const MIN_SIGNAL_COOLDOWN_SEC = 15 * 60;
export const MAX_SIGNAL_COOLDOWN_SEC = 7 * 24 * 3600;

export const isSignalKind = (v: string): v is SignalKind => SIGNAL_KINDS.includes(v as SignalKind);

/**
 * Whether signals are on for this user.
 *
 * Off by default. A signal is a push nobody asked for, and turning a new class
 * of unsolicited message on for every existing user would be the wrong way to
 * ship this.
 */
export function signalsEnabled(settings: WatchSettings): boolean {
  return (settings as WatchSettingsWithSignals).signalsEnabled === true;
}

export function preferencesFrom(settings: WatchSettings): SignalPreferences {
  const s = settings as WatchSettingsWithSignals;

  if (!signalsEnabled(settings)) {
    // Nothing passes: an impossible confidence bar is a cleaner off switch than
    // a flag every caller has to remember to check.
    return { ...DEFAULT_SIGNAL_PREFERENCES, minConfidence: 101 };
  }

  const confidence =
    typeof s.signalMinConfidence === "number" && Number.isFinite(s.signalMinConfidence)
      ? Math.min(MAX_CONFIDENCE, Math.max(MIN_CONFIDENCE, s.signalMinConfidence))
      : DEFAULT_SIGNAL_PREFERENCES.minConfidence;

  const kinds = Array.isArray(s.signalKinds) ? s.signalKinds.filter(isSignalKind) : [];

  const cooldown =
    typeof s.signalCooldownSec === "number" && Number.isFinite(s.signalCooldownSec)
      ? Math.min(MAX_SIGNAL_COOLDOWN_SEC, Math.max(MIN_SIGNAL_COOLDOWN_SEC, Math.round(s.signalCooldownSec)))
      : DEFAULT_SIGNAL_PREFERENCES.cooldownSec;

  return { minConfidence: confidence, kinds, cooldownSec: cooldown };
}

/**
 * Validates a preference change before it is stored.
 *
 * Returns an error rather than clamping silently, matching what the existing
 * settings validator does — a user who typed a value meant it, and quietly
 * storing a different one leaves them believing a setting they never chose.
 */
export type PreferenceUpdate =
  | { ok: true; patch: SignalSettings }
  | { ok: false; error: string };

export function updatePreference(field: string, raw: string): PreferenceUpdate {
  const value = raw.trim().toLowerCase();

  if (field === "signalsEnabled") {
    if (value === "on" || value === "true") return { ok: true, patch: { signalsEnabled: true } };
    if (value === "off" || value === "false") return { ok: true, patch: { signalsEnabled: false } };
    return { ok: false, error: "Send on or off." };
  }

  if (field === "signalMinConfidence") {
    const n = Number(value.replace("%", ""));
    if (!Number.isFinite(n) || n < MIN_CONFIDENCE || n > MAX_CONFIDENCE) {
      return { ok: false, error: `Confidence must be between ${MIN_CONFIDENCE} and ${MAX_CONFIDENCE}.` };
    }
    return { ok: true, patch: { signalMinConfidence: n } };
  }

  if (field === "signalCooldownSec") {
    const n = Number(value.replace(/[ms]$/, ""));
    const seconds = value.endsWith("m") ? n * 60 : value.endsWith("h") ? n * 3600 : n;
    if (!Number.isFinite(seconds) || seconds < MIN_SIGNAL_COOLDOWN_SEC || seconds > MAX_SIGNAL_COOLDOWN_SEC) {
      return {
        ok: false,
        error: `Cooldown must be between ${MIN_SIGNAL_COOLDOWN_SEC / 60}m and ${MAX_SIGNAL_COOLDOWN_SEC / 3600}h.`,
      };
    }
    return { ok: true, patch: { signalCooldownSec: Math.round(seconds) } };
  }

  if (field === "signalKinds") {
    if (value === "all" || value === "") return { ok: true, patch: { signalKinds: [] } };
    const requested = value.split(/[,\s]+/).filter(Boolean);
    const valid = requested.filter(isSignalKind);
    if (valid.length !== requested.length) {
      const bad = requested.filter((r) => !isSignalKind(r));
      return { ok: false, error: `Not a signal type: ${bad.join(", ")}. Options: ${SIGNAL_KINDS.join(", ")}, or "all".` };
    }
    return { ok: true, patch: { signalKinds: valid } };
  }

  return { ok: false, error: `Unknown setting: ${field}` };
}
