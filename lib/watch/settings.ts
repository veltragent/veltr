import type { WatchSettings, Threshold } from "./types";

/**
 * Per-user alert settings.
 *
 * Settings are keyed by Telegram chat id and never merged across users — two
 * people watching the same token evaluate the same market reading against their
 * own thresholds, and neither can observe or alter the other's.
 */

export const DEFAULT_SETTINGS: WatchSettings = {
  priceUpPct: 10,
  priceDownPct: 10,
  marketCapAbove: null,
  marketCapBelow: null,
  liquidityAbove: null,
  liquidityBelow: null,
  volumeAbove: null,
  volumeBelow: null,
  checkIntervalSec: 30,
  alertCooldownSec: 15 * 60,
  useDexScreener: true,
  useGeckoTerminal: true,
};

/**
 * Floor on the polling interval.
 *
 * GeckoTerminal's free tier allows 30 calls a minute for the whole process, not
 * per user. A user who could set a 1-second interval would exhaust that budget
 * for everyone, so the floor is a shared-resource guard rather than a preference.
 */
export const MIN_INTERVAL_SEC = 15;
export const MAX_INTERVAL_SEC = 24 * 3600;
export const MAX_COOLDOWN_SEC = 7 * 24 * 3600;

/** Percent moves outside this band are typos, not intentions. */
export const MIN_PCT = 0.01;
export const MAX_PCT = 100_000;
/** Above this a "market cap" is a parse accident, not a threshold. */
export const MAX_MONEY = 1e15;

export const PCT_PRESETS = [1, 5, 10, 20, 50];
export const INTERVAL_PRESETS_SEC = [15, 30, 60, 300, 900];
export const COOLDOWN_PRESETS_SEC = [0, 300, 900, 3600, 6 * 3600];
export const MONEY_PRESETS = [10_000, 50_000, 100_000, 500_000, 1_000_000];

export type NumericField =
  | "priceUpPct"
  | "priceDownPct"
  | "marketCapAbove"
  | "marketCapBelow"
  | "liquidityAbove"
  | "liquidityBelow"
  | "volumeAbove"
  | "volumeBelow"
  | "checkIntervalSec"
  | "alertCooldownSec";

export const FIELD_LABELS: Record<NumericField, string> = {
  priceUpPct: "Price Up",
  priceDownPct: "Price Down",
  marketCapAbove: "MC Above",
  marketCapBelow: "MC Below",
  liquidityAbove: "Liquidity Above",
  liquidityBelow: "Liquidity Below",
  volumeAbove: "24h Volume Above",
  volumeBelow: "24h Volume Below",
  checkIntervalSec: "Check Interval",
  alertCooldownSec: "Alert Cooldown",
};

/** Percentage fields read as percentages; the rest are US dollars or seconds. */
export const FIELD_UNIT: Record<NumericField, "pct" | "usd" | "sec"> = {
  priceUpPct: "pct",
  priceDownPct: "pct",
  marketCapAbove: "usd",
  marketCapBelow: "usd",
  liquidityAbove: "usd",
  liquidityBelow: "usd",
  volumeAbove: "usd",
  volumeBelow: "usd",
  checkIntervalSec: "sec",
  alertCooldownSec: "sec",
};

/**
 * Is this the name of a real settings field?
 *
 * Own-property check, not `in`: every object inherits "__proto__",
 * "constructor" and "toString", so `in` would accept those as field names and
 * hand an attacker-supplied callback payload a path to a write against
 * Object.prototype.
 */
export function isNumericField(value: string): value is NumericField {
  return Object.prototype.hasOwnProperty.call(FIELD_LABELS, value);
}

/**
 * Reads a user-typed threshold.
 *
 * People type what they mean rather than what parses: "250k", "$1.5M", "+7.5%",
 * "1,000,000". Rejecting those and demanding a bare integer would make the custom
 * path worse than the presets it exists to escape.
 */
export function parseNumericInput(raw: string): number | null {
  const cleaned = raw
    .trim()
    .replace(/[$,\s%]/g, "")
    .replace(/^\+/, "");
  if (!cleaned) return null;

  const match = /^(-?\d*\.?\d+)([kmb])?$/i.exec(cleaned);
  if (!match) return null;

  const base = Number(match[1]);
  if (!Number.isFinite(base)) return null;

  const scale = { k: 1e3, m: 1e6, b: 1e9 }[match[2]?.toLowerCase() ?? ""] ?? 1;
  return base * scale;
}

export type ValidationResult = { ok: true; value: number } | { ok: false; error: string };

/**
 * Clamps a parsed value into the range its field can meaningfully hold.
 *
 * Returns an error rather than silently clamping: a user who typed 1000000 for a
 * check interval meant something, and quietly storing 86400 would leave them
 * believing a setting they never chose.
 */
export function validateField(field: NumericField, value: number): ValidationResult {
  const unit = FIELD_UNIT[field];

  if (unit === "pct") {
    // A "-10%" down threshold is stored positive; the sign lives in the field name.
    const magnitude = Math.abs(value);
    if (magnitude < MIN_PCT || magnitude > MAX_PCT) {
      return { ok: false, error: `Enter a percentage between ${MIN_PCT} and ${MAX_PCT}.` };
    }
    return { ok: true, value: magnitude };
  }

  if (unit === "usd") {
    if (value <= 0 || value > MAX_MONEY) {
      return { ok: false, error: "Enter a positive dollar amount, e.g. 250000 or 250k." };
    }
    return { ok: true, value };
  }

  const seconds = Math.round(value);
  if (field === "checkIntervalSec") {
    if (seconds < MIN_INTERVAL_SEC || seconds > MAX_INTERVAL_SEC) {
      return {
        ok: false,
        error: `Interval must be between ${MIN_INTERVAL_SEC}s and ${MAX_INTERVAL_SEC / 3600}h.`,
      };
    }
    return { ok: true, value: seconds };
  }

  if (seconds < 0 || seconds > MAX_COOLDOWN_SEC) {
    return { ok: false, error: `Cooldown must be between 0s and ${MAX_COOLDOWN_SEC / 3600}h.` };
  }
  return { ok: true, value: seconds };
}

/**
 * Rebuilds a settings object from whatever was on disk.
 *
 * Stored settings predate every field added after them, so each one is taken
 * only when it is the right type and otherwise falls back to the default. A
 * corrupt or partial record degrades to defaults instead of poisoning the engine
 * with `undefined` thresholds.
 */
export function normaliseSettings(stored: unknown): WatchSettings {
  const raw = (stored ?? {}) as Partial<Record<keyof WatchSettings, unknown>>;
  const out: WatchSettings = { ...DEFAULT_SETTINGS };

  for (const field of Object.keys(FIELD_LABELS) as NumericField[]) {
    const value = raw[field];
    if (value === null) {
      // Explicitly disabled — only meaningful for thresholds.
      if (field !== "checkIntervalSec" && field !== "alertCooldownSec") {
        (out[field] as Threshold) = null;
      }
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const check = validateField(field, value);
    if (check.ok) (out[field] as number) = check.value;
  }

  if (typeof raw.useDexScreener === "boolean") out.useDexScreener = raw.useDexScreener;
  if (typeof raw.useGeckoTerminal === "boolean") out.useGeckoTerminal = raw.useGeckoTerminal;

  // Both sources off would silently stop every alert. Treat it as a mistake and
  // restore the primary source rather than leaving a watchlist that never fires.
  if (!out.useDexScreener && !out.useGeckoTerminal) out.useDexScreener = true;

  return out;
}

/* ------------------------------------------------------------ Rendering */

export function formatUsd(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(value / 1e3).toFixed(1)}K`;
  return `$${value.toFixed(2)}`;
}

export function formatDuration(seconds: number): string {
  if (seconds <= 0) return "Off";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(seconds % 3600 === 0 ? 0 : 1)}h`;
}

/** How a single setting reads in the settings panel and on a button. */
export function formatFieldValue(field: NumericField, settings: WatchSettings): string {
  const value = settings[field];
  if (value === null) return "Disabled";

  switch (FIELD_UNIT[field]) {
    case "pct":
      return `${field === "priceDownPct" ? "−" : "+"}${value}%`;
    case "usd":
      return formatUsd(value);
    default:
      return formatDuration(value);
  }
}
