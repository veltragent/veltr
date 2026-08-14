import type { Address } from "viem";
import { parseAbi } from "viem";
import { publicClient } from "./chain";

/**
 * Quantifies what a multiplier change costs liquidity providers.
 *
 * An AMM pool holds *raw* stock tokens and prices them from its own reserves.
 * It has no view of `uiMultiplier`. The instant a corporate action applies, each
 * raw token in the pool is worth more than the pool is quoting, and arbitrageurs
 * buy the difference out. The LP pays for it.
 */

/** Contracts that hold stock tokens on behalf of liquidity providers. */
export type VenueKind = "uniswap-v4" | "uniswap-v3" | "ramses-v3" | "unknown";

export type LiquidityVenue = {
  address: Address;
  kind: VenueKind;
  label: string;
  tokenBalance: number;
  valueUsd: number | null;
};

/**
 * Constant-product loss for a price jump of factor `m`, relative to simply
 * holding the same assets:
 *
 *     loss = 1 − 2√m / (1 + m)
 *
 * This is the *floor*. Concentrated-liquidity positions (V3, V4) sit in a bounded
 * range; a jump large enough to leave that range converts the position entirely
 * into the cheap side, which is strictly worse than this figure.
 */
export function arbLossFraction(multiplierRatio: number): number {
  if (!Number.isFinite(multiplierRatio) || multiplierRatio <= 0) return 0;
  return 1 - (2 * Math.sqrt(multiplierRatio)) / (1 + multiplierRatio);
}

const KNOWN_VENUES: Record<string, { kind: VenueKind; label: string }> = {
  "0x8366a39cc670b4001a1121b8f6a443a643e40951": {
    kind: "uniswap-v4",
    label: "Uniswap V4 PoolManager",
  },
};

const IDENTIFY = parseAbi([
  "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)",
  "function getReserves() view returns (uint112,uint112,uint32)",
]);

async function classify(address: Address): Promise<{ kind: VenueKind; label: string }> {
  const known = KNOWN_VENUES[address.toLowerCase()];
  if (known) return known;

  try {
    await publicClient.readContract({ address, abi: IDENTIFY, functionName: "slot0" });
    return { kind: "uniswap-v3", label: "Concentrated-liquidity pool" };
  } catch {
    /* not a v3-style pool */
  }
  return { kind: "unknown", label: "Contract holder" };
}

type BlockscoutHolder = {
  address: { hash: Address; is_contract: boolean; name?: string | null };
  value: string;
};

/**
 * Finds the AMM venues holding a given stock token.
 *
 * Discovery is by holder inspection rather than factory enumeration: most of the
 * liquidity on this chain sits in the Uniswap V4 singleton, which has no
 * per-pool factory address to query.
 */
export async function findLiquidityVenues(
  token: Address,
  priceUsd: number | null
): Promise<LiquidityVenue[]> {
  const res = await fetch(
    `https://robinhoodchain.blockscout.com/api/v2/tokens/${token}/holders`,
    { next: { revalidate: 300 } }
  );
  if (!res.ok) return [];

  const items = ((await res.json()).items ?? []) as BlockscoutHolder[];
  const contracts = items.filter((h) => h.address.is_contract).slice(0, 6);

  const venues: LiquidityVenue[] = [];
  for (const holder of contracts) {
    const { kind, label } = await classify(holder.address.hash);

    // Only genuine AMM venues count. A Safe multisig or a custody proxy holding
    // the same token is not liquidity anyone can arbitrage, and including it
    // would overstate the amount at risk — the one error this figure must not
    // make.
    if (kind === "unknown") continue;

    const tokenBalance = Number(holder.value) / 1e18;
    venues.push({
      address: holder.address.hash,
      kind,
      // Prefer the curated label: Blockscout reports the V4 singleton as the
      // ambiguous "PoolManager".
      label: label,
      tokenBalance,
      valueUsd: priceUsd === null ? null : tokenBalance * priceUsd,
    });
  }

  return venues.sort((a, b) => b.tokenBalance - a.tokenBalance);
}

export type LpRisk = {
  venues: LiquidityVenue[];
  tokensAtRisk: number;
  valueAtRisk: number | null;
  lossFraction: number;
  /** Floor estimate of value arbitrageurs extract when the action applies. */
  estimatedLossUsd: number | null;
};

export async function assessLpRisk(
  token: Address,
  priceUsd: number | null,
  fromMultiplier: number,
  toMultiplier: number
): Promise<LpRisk> {
  const venues = await findLiquidityVenues(token, priceUsd);
  const ratio = fromMultiplier === 0 ? 1 : toMultiplier / fromMultiplier;
  const lossFraction = arbLossFraction(ratio);

  const tokensAtRisk = venues.reduce((sum, v) => sum + v.tokenBalance, 0);
  const valueAtRisk = priceUsd === null ? null : tokensAtRisk * priceUsd;

  return {
    venues,
    tokensAtRisk,
    valueAtRisk,
    lossFraction,
    estimatedLossUsd: valueAtRisk === null ? null : valueAtRisk * lossFraction,
  };
}
