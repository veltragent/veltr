import { type Address, parseAbi } from "viem";
import { publicClient } from "./chain";
import { arbLossFraction } from "./lp-risk";

/**
 * Liquidity positions held by an address, and their exposure to a corporate
 * action.
 *
 * A position only matters here if one of its two currencies is a stock token:
 * the pool prices raw tokens and cannot see `uiMultiplier`, so the moment a
 * split applies the position is quoting a stale ratio and arbitrageurs take the
 * difference from the provider.
 */

export const V4_POSITION_MANAGER: Address = "0x58daec3116aae6D93017bAAea7749052E8a04fA7";
export const V3_POSITION_MANAGER: Address = "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3";

const v3Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function tokenOfOwnerByIndex(address,uint256) view returns (uint256)",
  "function positions(uint256) view returns (uint96 nonce,address operator,address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256 feeGrowth0,uint256 feeGrowth1,uint128 owed0,uint128 owed1)",
]);

const v4Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function getPoolAndPositionInfo(uint256) view returns ((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,uint256 info)",
  "function getPositionLiquidity(uint256) view returns (uint128)",
]);

export type LpPosition = {
  version: "v3" | "v4";
  tokenId: string;
  manager: Address;
  currency0: Address;
  currency1: Address;
  fee: number;
  liquidity: string;
  /** Stock token in this pair, if any. */
  stockToken: Address | null;
  stockSymbol: string | null;
  /** Loss the provider takes if a 4:1 split applies while still in the pool. */
  splitLossFraction: number;
};

type NftItem = { id: string; manager: string };

type Collection = {
  amount: string;
  token: { address_hash?: string; address?: string };
  token_instances?: { id: string }[];
};

/**
 * Enumerates position NFTs via Blockscout.
 *
 * The v4 PositionManager is not ERC721Enumerable, so `tokenOfOwnerByIndex` is
 * unavailable and an indexer is the only practical route.
 *
 * Caveat worth knowing: Blockscout returns a *sample* of instances per
 * collection, not the full set. For an address holding thousands of positions
 * this reports the sample it returns, not every position — accurate for ordinary
 * wallets, incomplete for protocol-scale holders.
 */
async function fetchOwnedNfts(owner: Address): Promise<{ items: NftItem[]; truncated: boolean }> {
  const res = await fetch(
    `https://robinhoodchain.blockscout.com/api/v2/addresses/${owner}/nft/collections?type=ERC-721`,
    { next: { revalidate: 60 } }
  );
  if (!res.ok) return { items: [], truncated: false };

  const collections = ((await res.json()).items ?? []) as Collection[];
  const items: NftItem[] = [];
  let truncated = false;

  for (const c of collections) {
    const manager = (c.token?.address_hash ?? c.token?.address ?? "").toLowerCase();
    const instances = c.token_instances ?? [];
    if (Number(c.amount) > instances.length) truncated = true;
    for (const inst of instances) items.push({ id: inst.id, manager });
  }

  return { items, truncated };
}

export async function findLpPositions(
  owner: Address,
  stockTokens: Map<string, string>
): Promise<LpPosition[]> {
  const { items: nfts } = await fetchOwnedNfts(owner).catch(() => ({ items: [], truncated: false }));

  const v4Ids = nfts
    .filter((n) => n.manager === V4_POSITION_MANAGER.toLowerCase())
    .map((n) => BigInt(n.id));
  const v3Ids = nfts
    .filter((n) => n.manager === V3_POSITION_MANAGER.toLowerCase())
    .map((n) => BigInt(n.id));

  const positions: LpPosition[] = [];

  const classify = (a: Address, b: Address) => {
    const s0 = stockTokens.get(a.toLowerCase());
    const s1 = stockTokens.get(b.toLowerCase());
    if (s0) return { stockToken: a, stockSymbol: s0 };
    if (s1) return { stockToken: b, stockSymbol: s1 };
    return { stockToken: null, stockSymbol: null };
  };

  if (v3Ids.length) {
    const results = await publicClient.multicall({
      contracts: v3Ids.map((id) => ({
        address: V3_POSITION_MANAGER,
        abi: v3Abi,
        functionName: "positions" as const,
        args: [id],
      })),
      allowFailure: true,
    });

    v3Ids.forEach((id, i) => {
      const r = results[i];
      if (r.status !== "success") return;
      const p = r.result as readonly unknown[];
      const token0 = p[2] as Address;
      const token1 = p[3] as Address;
      const { stockToken, stockSymbol } = classify(token0, token1);
      if (!stockToken) return;

      positions.push({
        version: "v3",
        tokenId: id.toString(),
        manager: V3_POSITION_MANAGER,
        currency0: token0,
        currency1: token1,
        fee: Number(p[4]),
        liquidity: (p[7] as bigint).toString(),
        stockToken,
        stockSymbol,
        splitLossFraction: arbLossFraction(4),
      });
    });
  }

  if (v4Ids.length) {
    const [infos, liquidities] = await Promise.all([
      publicClient.multicall({
        contracts: v4Ids.map((id) => ({
          address: V4_POSITION_MANAGER,
          abi: v4Abi,
          functionName: "getPoolAndPositionInfo" as const,
          args: [id],
        })),
        allowFailure: true,
      }),
      publicClient.multicall({
        contracts: v4Ids.map((id) => ({
          address: V4_POSITION_MANAGER,
          abi: v4Abi,
          functionName: "getPositionLiquidity" as const,
          args: [id],
        })),
        allowFailure: true,
      }),
    ]);

    v4Ids.forEach((id, i) => {
      const info = infos[i];
      if (info.status !== "success") return;
      const [poolKey] = info.result as readonly [
        { currency0: Address; currency1: Address; fee: number },
        bigint,
      ];
      const { stockToken, stockSymbol } = classify(poolKey.currency0, poolKey.currency1);
      if (!stockToken) return;

      const liq = liquidities[i];
      positions.push({
        version: "v4",
        tokenId: id.toString(),
        manager: V4_POSITION_MANAGER,
        currency0: poolKey.currency0,
        currency1: poolKey.currency1,
        fee: Number(poolKey.fee),
        liquidity: liq.status === "success" ? (liq.result as bigint).toString() : "0",
        stockToken,
        stockSymbol,
        splitLossFraction: arbLossFraction(4),
      });
    });
  }

  return positions;
}
