import { fullyArmed } from "../lib/watch/alerts";
import { DEFAULT_SETTINGS } from "../lib/watch/settings";
import { emptyMarketData, type TokenMarketData, type TokenWatch, type WatchSettings } from "../lib/watch/types";

/** Shared fixtures. Kept minimal so a test's own setup is the interesting part. */

export const TOKEN_A = "0x2e8c31162b855a2ffa90f6f8634643ad6f111e18";
export const TOKEN_B = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";

export function makeWatch(overrides: Partial<TokenWatch> = {}): TokenWatch {
  const now = new Date("2026-08-14T00:00:00.000Z").toISOString();
  return {
    id: overrides.id ?? "watch-1",
    userId: "111",
    chain: "robinhood",
    tokenAddress: TOKEN_A,
    symbol: "AI",
    name: "Artificial Inu",
    pairAddress: null,
    baselinePrice: 1,
    lastPrice: 1,
    lastMarketCap: 1_000_000,
    lastLiquidity: 100_000,
    lastVolume: 500_000,
    lastCheckedAt: now,
    lastAlertAt: null,
    armed: fullyArmed(),
    enabled: true,
    createdAt: now,
    ...overrides,
  };
}

export function makeMarket(overrides: Partial<TokenMarketData> = {}): TokenMarketData {
  return {
    ...emptyMarketData(TOKEN_A, "dexscreener"),
    symbol: "AI",
    name: "Artificial Inu",
    priceUsd: 1,
    marketCap: 1_000_000,
    fdv: 1_000_000,
    liquidity: 100_000,
    volume24h: 500_000,
    ...overrides,
  };
}

export function makeSettings(overrides: Partial<WatchSettings> = {}): WatchSettings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

/** A fetch stand-in that replays canned responses and records what was asked for. */
export function stubFetch(
  handler: (url: string) => { status?: number; body?: unknown; headers?: Record<string, string> } | Promise<never>
) {
  const calls: string[] = [];

  const impl = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    const result = await handler(url);
    const status = result.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => result.headers?.[name.toLowerCase()] ?? null },
      json: async () => result.body,
      text: async () => JSON.stringify(result.body ?? ""),
    } as unknown as Response;
  }) as unknown as typeof fetch;

  return { impl, calls };
}
