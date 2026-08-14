/**
 * Token watch — shared vocabulary.
 *
 * Every provider normalises into `TokenMarketData`, so the alert engine never
 * learns which API a number came from. A field a provider does not serve stays
 * `null` and is never coerced to zero: a missing market cap must not read as a
 * market cap of nothing, or a "MC below $500K" alert fires on every outage.
 */

export type MarketSource = "dexscreener" | "geckoterminal" | "onchain";

export type TokenMarketData = {
  address: string;
  symbol: string | null;
  name: string | null;
  /** Price in the pool's quote token, when the provider reports one. */
  price: number | null;
  priceUsd: number | null;
  marketCap: number | null;
  fdv: number | null;
  liquidity: number | null;
  volume24h: number | null;
  priceChange5m: number | null;
  priceChange1h: number | null;
  priceChange6h: number | null;
  priceChange24h: number | null;
  buys: number | null;
  sells: number | null;
  pairAddress: string | null;
  dex: string | null;
  url: string | null;
  /** Every provider that contributed at least one field to this record. */
  source: MarketSource[];
  updatedAt: string;
};

/** An empty reading with the address filled in — the shape every parser starts from. */
export function emptyMarketData(address: string, source: MarketSource): TokenMarketData {
  return {
    address: address.toLowerCase(),
    symbol: null,
    name: null,
    price: null,
    priceUsd: null,
    marketCap: null,
    fdv: null,
    liquidity: null,
    volume24h: null,
    priceChange5m: null,
    priceChange1h: null,
    priceChange6h: null,
    priceChange24h: null,
    buys: null,
    sells: null,
    pairAddress: null,
    dex: null,
    url: null,
    source: [source],
    updatedAt: new Date().toISOString(),
  };
}

/**
 * A finite number, or null.
 *
 * Providers return numbers as strings, and a failed parse yields NaN — which is
 * a number by `typeof` and would pass straight into a threshold comparison. Every
 * value entering the model goes through here.
 */
export function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/* ------------------------------------------------------------- Settings */

/** A threshold the user has not configured. Disabled is null, never 0. */
export type Threshold = number | null;

export type WatchSettings = {
  /** Percent rise from baseline that fires an UP alert. */
  priceUpPct: Threshold;
  /** Percent fall from baseline that fires a DOWN alert, held as a positive number. */
  priceDownPct: Threshold;
  marketCapAbove: Threshold;
  marketCapBelow: Threshold;
  liquidityAbove: Threshold;
  liquidityBelow: Threshold;
  volumeAbove: Threshold;
  volumeBelow: Threshold;
  /** Seconds between checks for this user's watches. */
  checkIntervalSec: number;
  /** Seconds of silence enforced after any alert on a given watch. */
  alertCooldownSec: number;
  useDexScreener: boolean;
  useGeckoTerminal: boolean;
};

/**
 * Which side of a threshold a watch is currently sitting on.
 *
 * `armed` means the condition is eligible to fire. It is cleared when the alert
 * is sent and restored only once the metric has retreated through the re-arm
 * band — this is what stops one sustained move producing an alert per poll.
 */
export type ArmState = {
  priceUp: boolean;
  priceDown: boolean;
  marketCapAbove: boolean;
  marketCapBelow: boolean;
  liquidityAbove: boolean;
  liquidityBelow: boolean;
  volumeAbove: boolean;
  volumeBelow: boolean;
};

export type AlertKind = keyof ArmState;

export type TokenWatch = {
  id: string;
  /** Telegram chat id. Scopes every read and write — one user can never see another's. */
  userId: string;
  /** Always "robinhood" today; carried so a second chain does not need a migration. */
  chain: string;
  tokenAddress: string;
  symbol: string | null;
  name: string | null;
  pairAddress: string | null;
  /** Price the percentage thresholds are measured from. */
  baselinePrice: number | null;
  lastPrice: number | null;
  lastMarketCap: number | null;
  lastLiquidity: number | null;
  lastVolume: number | null;
  lastCheckedAt: string | null;
  lastAlertAt: string | null;
  armed: ArmState;
  enabled: boolean;
  createdAt: string;
};
