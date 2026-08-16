import type { Address } from "viem";
import { erc8056Abi, publicClient } from "./chain";
import { buildPremiumWall } from "./premium-wall";
import { buildRadarSnapshot } from "./tokens";

/**
 * What an address actually holds, in tokenised shares.
 *
 * The whole file turns on one call. A stock token's true balance is
 * `balanceOfUI`, not `balanceOf`: after a split or a dividend the raw balance
 * is stale by the uiMultiplier, and reading it reports a holding that is wrong
 * by exactly the amount of the corporate action. That misreporting is the thing
 * this product exists to warn people about, so a portfolio here computing it
 * the wrong way would be the worst possible bug to ship.
 *
 * There is no cost basis. Nothing on chain says what someone paid — that would
 * mean indexing every transfer and inferring trades from them — so this reports
 * what is held and what it is worth, and the 24h move, and says nothing about
 * profit. An invented entry price would be believed.
 */

export type Holding = {
  symbol: string;
  name: string;
  address: string;
  /** Units held, already corrected by the uiMultiplier. */
  units: number;
  priceUsd: number | null;
  valueUsd: number | null;
  /** Percent the token trades above (+) or below (−) the underlying share. */
  premiumPct: number | null;
  /** Value at the underlying share price rather than the token price. */
  valueAtSharePriceUsd: number | null;
  /** True when a corporate action is queued against this token. */
  actionPending: boolean;
};

export type Portfolio = {
  address: string;
  holdings: Holding[];
  totalValueUsd: number;
  /**
   * What the same shares would be worth at the underlying prices.
   *
   * The gap against `totalValueUsd` is the premium being paid or the discount
   * being held, in dollars — the number that says whether the spread is worth
   * anything at this size.
   */
  totalAtSharePriceUsd: number | null;
  /** The equity market was shut, so every premium is against a stale close. */
  premiumIsStale: boolean;
  /** Tokens checked. Reported so an empty portfolio is distinguishable from a failed read. */
  tokensChecked: number;
  generatedAt: string;
};

export type PortfolioDeps = {
  listTokens: () => Promise<
    {
      address: string;
      symbol: string;
      name: string;
      decimals: number;
      priceUsd: number | null;
      /**
       * Taken from the snapshot rather than recomputed.
       *
       * A queued action is not “a pending multiplier exists” — the contracts
       * report the current one when nothing is scheduled, so that test is true
       * for every token on the chain. It is a pending multiplier that *differs*
       * from the live one, which the snapshot already decides. Deciding it a
       * second time here is how the portfolio and the rest of the product would
       * come to disagree.
       */
      actionPending: boolean;
    }[]
  >;
  readBalances: (owner: Address, tokens: Address[]) => Promise<(bigint | null)[]>;
  premiums: () => Promise<{ bySymbol: Map<string, number | null>; marketOpen: boolean }>;
};

async function defaultDeps(): Promise<PortfolioDeps> {
  return {
    listTokens: async () => {
      const snapshot = await buildRadarSnapshot();
      return snapshot.tokens.map((t) => ({
        address: t.address,
        symbol: t.symbol,
        name: t.name,
        decimals: t.decimals,
        priceUsd: t.priceUsd,
        actionPending: t.severity === "scheduled",
      }));
    },

    readBalances: async (owner, tokens) => {
      if (tokens.length === 0) return [];
      /**
       * balanceOfUI, in one multicall.
       *
       * `allowFailure` so a token that does not implement it — or reverts —
       * costs its own row rather than the whole portfolio. A null there means
       * "not known", and is reported as such rather than as a zero balance.
       */
      const results = await publicClient.multicall({
        allowFailure: true,
        contracts: tokens.map((address) => ({
          address,
          abi: erc8056Abi,
          functionName: "balanceOfUI" as const,
          args: [owner] as const,
        })),
      });

      return results.map((r) => (r.status === "success" ? (r.result as bigint) : null));
    },

    premiums: async () => {
      // Cached for 60s and shared with the website, so joining against it is free.
      const wall = await buildPremiumWall();
      return {
        bySymbol: new Map(wall.rows.map((r) => [r.symbol.toUpperCase(), r.premiumPct])),
        marketOpen: wall.marketOpen,
      };
    },
  };
}

/** Units from a raw on-chain amount, without losing precision on the way. */
export function toUnits(raw: bigint, decimals: number): number {
  if (raw === 0n) return 0;
  const divisor = 10n ** BigInt(decimals);
  const whole = raw / divisor;
  const remainder = raw % divisor;
  return Number(whole) + Number(remainder) / Number(divisor);
}

/**
 * Dust.
 *
 * A balance of a few billionths of a share is a rounding artefact of a transfer,
 * not a position, and listing thirty of them buries the two that matter.
 */
export const DUST_UNITS = 1e-9;

export async function readPortfolio(
  address: string,
  overrides: Partial<PortfolioDeps> = {}
): Promise<Portfolio> {
  const deps: PortfolioDeps = { ...(await defaultDeps()), ...overrides };
  const owner = address as Address;

  const tokens = await deps.listTokens();
  const balances = await deps.readBalances(
    owner,
    tokens.map((t) => t.address as Address)
  );

  const { bySymbol, marketOpen } = await deps.premiums().catch(() => ({
    bySymbol: new Map<string, number | null>(),
    marketOpen: false,
  }));

  const holdings: Holding[] = [];

  for (const [i, token] of tokens.entries()) {
    const raw = balances[i];
    if (raw === null || raw === undefined || raw === 0n) continue;

    const units = toUnits(raw, token.decimals);
    if (units <= DUST_UNITS) continue;

    const premiumPct = marketOpen ? (bySymbol.get(token.symbol.toUpperCase()) ?? null) : null;
    const valueUsd = token.priceUsd === null ? null : units * token.priceUsd;

    holdings.push({
      symbol: token.symbol,
      name: token.name,
      address: token.address,
      units,
      priceUsd: token.priceUsd,
      valueUsd,
      premiumPct,
      // What the same exposure is worth at the share price. Derived from the
      // premium rather than re-read, so the two numbers cannot disagree.
      valueAtSharePriceUsd:
        valueUsd === null || premiumPct === null ? null : valueUsd / (1 + premiumPct / 100),
      actionPending: token.actionPending,
    });
  }

  holdings.sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));

  const totalValueUsd = holdings.reduce((sum, h) => sum + (h.valueUsd ?? 0), 0);
  const priced = holdings.filter((h) => h.valueAtSharePriceUsd !== null);

  return {
    address,
    holdings,
    totalValueUsd,
    totalAtSharePriceUsd: priced.length
      ? priced.reduce((sum, h) => sum + (h.valueAtSharePriceUsd ?? 0), 0)
      : null,
    premiumIsStale: !marketOpen,
    tokensChecked: tokens.length,
    generatedAt: new Date().toISOString(),
  };
}
