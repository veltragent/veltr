import type { Alert } from "./alerts";
import { formatUsd, formatFieldValue, formatDuration, type NumericField } from "./settings";
import type { AlertKind, TokenMarketData, TokenWatch, WatchSettings } from "./types";

/**
 * Message copy for the watch feature.
 *
 * Pure string building, kept apart from delivery so every message below is
 * assertable in a test without a bot token. Plain text throughout: an alert
 * carries a contract address and a symbol chosen by whoever deployed the token,
 * and Telegram rejects an entire message when markdown in it is unbalanced.
 */

/** Prices span nine orders of magnitude here; a fixed precision loses one end or the other. */
export function formatPrice(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value === 0) return "$0";
  const abs = Math.abs(value);
  if (abs >= 100) return `$${value.toFixed(2)}`;
  if (abs >= 1) return `$${value.toFixed(4)}`;
  if (abs >= 0.0001) return `$${value.toFixed(6)}`;
  return `$${value.toExponential(4)}`;
}

export function formatMoney(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "—" : formatUsd(value);
}

export function formatPct(value: number | null, dp = 2): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(dp)}%`;
}

export function tokenLabel(watch: { symbol: string | null; tokenAddress: string }): string {
  return watch.symbol ? `$${watch.symbol}` : `${watch.tokenAddress.slice(0, 10)}…`;
}

function sourceLine(market: TokenMarketData): string {
  const names: Record<string, string> = {
    dexscreener: "DEX Screener",
    geckoterminal: "GeckoTerminal",
    onchain: "on-chain",
  };
  const listed = market.source.map((s) => names[s] ?? s).join(" + ");
  return listed ? `Source: ${listed}` : "";
}

/* ---------------------------------------------------------------- /watch */

export function renderWatchConfirmation(
  watch: TokenWatch,
  market: TokenMarketData,
  settings: WatchSettings,
  alreadyWatched: boolean
): string {
  const lines = [
    `👁 ${alreadyWatched ? "Updated watch on" : "Watching"} ${tokenLabel(watch)}`,
    market.name ? market.name : "",
    "",
    `Price: ${formatPrice(market.priceUsd)}`,
    `MC: ${formatMoney(market.marketCap ?? market.fdv)}`,
    `Liquidity: ${formatMoney(market.liquidity)}`,
    `24h Volume: ${formatMoney(market.volume24h)}`,
  ];

  if (market.priceChange24h !== null) lines.push(`24h Change: ${formatPct(market.priceChange24h)}`);

  lines.push("", "Alerts:");
  lines.push(
    settings.priceUpPct === null ? "🟢 Up: Disabled" : `🟢 Up: +${settings.priceUpPct}%`,
    settings.priceDownPct === null ? "🔴 Down: Disabled" : `🔴 Down: −${settings.priceDownPct}%`
  );

  const levels: [string, NumericField][] = [
    ["📈 MC Above", "marketCapAbove"],
    ["📉 MC Below", "marketCapBelow"],
    ["💧 Liquidity Above", "liquidityAbove"],
    ["💧 Liquidity Below", "liquidityBelow"],
    ["📊 Volume Above", "volumeAbove"],
    ["📊 Volume Below", "volumeBelow"],
  ];
  for (const [label, field] of levels) {
    if (settings[field] !== null) lines.push(`${label}: ${formatFieldValue(field, settings)}`);
  }

  if (alreadyWatched) {
    lines.push("", "Baseline reset to the current price, so percentage alerts measure from here.");
  }

  lines.push(
    "",
    `Checked every ${formatDuration(settings.checkIntervalSec)}. ${sourceLine(market)}`,
    "",
    "You'll be notified when your alert conditions are triggered.",
    "Change them any time with /settings."
  );

  if (market.url) lines.push("", market.url);

  return lines.filter((l) => l !== "").join("\n").replace(/\n{3,}/g, "\n\n");
}

export const TOKEN_NOT_FOUND = [
  "❌ Token not found on Robinhood Chain markets.",
  "",
  "Make sure the contract address is correct and the token has an indexed trading pair.",
  "",
  "A token that has never traded, or whose pool was created in the last few minutes, will not be indexed by DEX Screener or GeckoTerminal yet.",
].join("\n");

/* -------------------------------------------------------------- /watches */

export function renderWatchlist(watches: TokenWatch[], settings: WatchSettings): string {
  if (watches.length === 0) {
    return [
      "👁 Your Watchlist",
      "",
      "Nothing watched yet.",
      "",
      "Add a token with its contract address:",
      "/watch 0x2e8c31162b855a2ffa90f6f8634643ad6f111e18",
    ].join("\n");
  }

  const alertScope =
    settings.priceUpPct === null && settings.priceDownPct === null
      ? "price alerts off"
      : `${settings.priceUpPct === null ? "—" : `+${settings.priceUpPct}%`} / ${
          settings.priceDownPct === null ? "—" : `−${settings.priceDownPct}%`
        }`;

  const body = watches.map((watch, i) => {
    const change = renderChangeFromBaseline(watch);
    return [
      `${i + 1}. ${tokenLabel(watch)}${watch.enabled ? "" : "  (paused)"}`,
      `Price: ${formatPrice(watch.lastPrice)}${change ? `  ${change}` : ""}`,
      `MC: ${formatMoney(watch.lastMarketCap)}`,
      `Alert: ${alertScope}`,
    ].join("\n");
  });

  return [`👁 Your Watchlist (${watches.length})`, "", body.join("\n\n")].join("\n");
}

function renderChangeFromBaseline(watch: TokenWatch): string {
  if (watch.baselinePrice === null || watch.lastPrice === null || watch.baselinePrice <= 0) return "";
  const pct = (watch.lastPrice / watch.baselinePrice - 1) * 100;
  return `(${formatPct(pct)} since watch)`;
}

/* --------------------------------------------------------------- Alerts */

const HEADLINE: Record<AlertKind, string> = {
  priceUp: "🟢 PRICE ALERT",
  priceDown: "🔴 PRICE ALERT",
  marketCapAbove: "🚀 MC ALERT",
  marketCapBelow: "⚠️ MC ALERT",
  liquidityAbove: "💧 LIQUIDITY ALERT",
  liquidityBelow: "⚠️ LIQUIDITY ALERT",
  volumeAbove: "📊 VOLUME ALERT",
  volumeBelow: "📉 VOLUME ALERT",
};

/**
 * Alert copy.
 *
 * Long enough to act on without opening anything, short enough to read on a lock
 * screen: what fired, what it is now, what it was measured against, and the
 * three context figures that say whether the move is real.
 */
export function renderAlert(alert: Alert): string {
  const { market } = alert;
  const label = alert.symbol ? `$${alert.symbol}` : alert.tokenAddress.slice(0, 10) + "…";

  const head =
    alert.kind === "priceUp" || alert.kind === "priceDown"
      ? [
          `${HEADLINE[alert.kind]} ${label}`,
          "",
          `Price: ${formatPrice(market.priceUsd)}`,
          `Change: ${formatPct(alert.changePct)}`,
          `Threshold: ${alert.kind === "priceUp" ? "+" : "−"}${alert.threshold}%`,
        ]
      : [
          `${HEADLINE[alert.kind]} ${label}`,
          "",
          `${METRIC_LABEL[alert.kind]}:`,
          formatMoney(alert.value),
          "",
          "Threshold:",
          formatMoney(alert.threshold),
        ];

  const context = [
    "",
    `MC: ${formatMoney(market.marketCap ?? market.fdv)}`,
    `Liquidity: ${formatMoney(market.liquidity)}`,
    `24h Volume: ${formatMoney(market.volume24h)}`,
  ];

  const footer = [""];
  const source = sourceLine(market);
  if (source) footer.push(source);
  if (market.url) footer.push("", `View Chart ↗ ${market.url}`);

  return [...head, ...context, ...footer].join("\n").replace(/\n{3,}/g, "\n\n");
}

const METRIC_LABEL: Record<AlertKind, string> = {
  priceUp: "Price",
  priceDown: "Price",
  marketCapAbove: "Market Cap",
  marketCapBelow: "Market Cap",
  liquidityAbove: "Liquidity",
  liquidityBelow: "Liquidity",
  volumeAbove: "24h Volume",
  volumeBelow: "24h Volume",
};

/* ------------------------------------------------------------- Settings */

export function renderSettings(settings: WatchSettings, watchCount: number): string {
  return [
    "⚙️ Veltr Watch Settings",
    "",
    "Price Alerts",
    `🟢 Price Up: ${formatFieldValue("priceUpPct", settings)}`,
    `🔴 Price Down: ${formatFieldValue("priceDownPct", settings)}`,
    "",
    "Market Cap",
    `📈 MC Above: ${formatFieldValue("marketCapAbove", settings)}`,
    `📉 MC Below: ${formatFieldValue("marketCapBelow", settings)}`,
    "",
    "Liquidity",
    `💧 Liquidity Above: ${formatFieldValue("liquidityAbove", settings)}`,
    `💧 Liquidity Below: ${formatFieldValue("liquidityBelow", settings)}`,
    "",
    "Volume",
    `📊 24h Volume Above: ${formatFieldValue("volumeAbove", settings)}`,
    `📊 24h Volume Below: ${formatFieldValue("volumeBelow", settings)}`,
    "",
    "Monitoring",
    `⏱ Check Interval: ${formatFieldValue("checkIntervalSec", settings)}`,
    `🔕 Alert Cooldown: ${formatFieldValue("alertCooldownSec", settings)}`,
    "",
    "Sources",
    `${settings.useDexScreener ? "🟢" : "🔴"} DEX Screener`,
    `${settings.useGeckoTerminal ? "🟢" : "🔴"} GeckoTerminal`,
    "",
    `Watching ${watchCount} token${watchCount === 1 ? "" : "s"}. These settings apply to all of them.`,
  ].join("\n");
}
