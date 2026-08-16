import { createPublicClient, defineChain, http, type Address } from "viem";

/**
 * Robinhood Chain mainnet — Arbitrum Orbit L2, Ethereum blobs for DA.
 * The public RPC is rate-limited and explicitly "not for production";
 * set VELTR_RPC_URL to an Alchemy endpoint before real traffic.
 */
export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.VELTR_RPC_URL || "https://rpc.mainnet.chain.robinhood.com"] },
  },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" },
  },
  contracts: {
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
});

export const publicClient = createPublicClient({
  chain: robinhoodChain,
  transport: http(undefined, { batch: true, timeout: 30_000, retryCount: 2 }),
});

/**
 * Separate transport for `eth_getLogs`.
 *
 * The two endpoints have opposite strengths. Alchemy's free tier caps getLogs at
 * a 10-block range — useless for reading a chain's full corporate-action history
 * — while the public endpoint serves an unbounded range across all token
 * addresses in one request. Alchemy handles the high-volume call traffic; the
 * public endpoint handles the one query it is better at.
 */
export const logsClient = createPublicClient({
  chain: robinhoodChain,
  transport: http(
    process.env.VELTR_LOGS_RPC_URL || "https://rpc.mainnet.chain.robinhood.com",
    { timeout: 60_000, retryCount: 2 }
  ),
});

/**
 * ERC-8056 scaled-UI interface.
 *
 * Stock tokens never rebase. A holder's raw balance is fixed forever; corporate
 * actions move `uiMultiplier` instead. Effective underlying exposure is
 * therefore `rawBalance * uiMultiplier / 1e18` — which is why any integrator
 * reading plain `balanceOf` reports the wrong number after a split or dividend.
 *
 * `newUIMultiplier` + `effectiveAt` expose a *scheduled* action before it lands.
 * That pair is the early-warning signal Veltr is built on.
 */
export const erc8056Abi = [
  { type: "function", name: "uiMultiplier", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "newUIMultiplier", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "effectiveAt", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "balanceOfUI",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  { type: "function", name: "totalSupplyUI", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "event",
    name: "UIMultiplierUpdated",
    inputs: [
      { name: "oldMultiplier", type: "uint256", indexed: false },
      { name: "newMultiplier", type: "uint256", indexed: false },
      { name: "effectiveAtTimestamp", type: "uint256", indexed: false },
    ],
  },
] as const;

export const WAD = 10n ** 18n;

/** Larger than viem's default so ~600 probes cost tens of requests, not hundreds. */
const MULTICALL_BATCH = 8192;

/**
 * Stage 1 of discovery: ask every ERC-20 on the chain for `uiMultiplier()`.
 * A contract that answers implements ERC-8056 and is therefore a stock token.
 * This is the authoritative test — no name matching, no icon heuristics, no
 * hardcoded registry — so newly listed symbols are picked up automatically.
 */
export type Erc8056Probe = {
  found: { address: Address; uiMultiplier: bigint }[];
  /** Contracts asked. */
  checked: number;
  /**
   * Calls the node refused, dropped or timed out.
   *
   * Reported because without it a throttled call is indistinguishable from a
   * contract that simply does not implement the interface — both arrive as an
   * address missing from `found`. A partial probe then looks exactly like a
   * chain with fewer stock tokens on it.
   */
  failed: number;
};

export async function probeErc8056(
  addresses: Address[],
  options: { usePublicFallback?: boolean } = {}
): Promise<Erc8056Probe> {
  const client = options.usePublicFallback ? logsClient : publicClient;

  const results = await client.multicall({
    contracts: addresses.map((address) => ({ address, abi: erc8056Abi, functionName: "uiMultiplier" }) as const),
    allowFailure: true,
    batchSize: MULTICALL_BATCH,
  });

  const found: { address: Address; uiMultiplier: bigint }[] = [];
  let failed = 0;

  addresses.forEach((address, i) => {
    const r = results[i];
    if (r.status === "success") {
      if (typeof r.result === "bigint" && r.result > 0n) found.push({ address, uiMultiplier: r.result });
      return;
    }
    /*
     * A contract without the function reverts, and viem reports that as a
     * failure too — so a revert is counted only when it is not the ordinary
     * "this is not a stock token" answer. Anything else is the node refusing.
     */
    const name = (r.error as { name?: string } | undefined)?.name ?? "";
    if (name !== "ContractFunctionExecutionError" && name !== "ContractFunctionRevertedError") failed++;
  });

  return { found, checked: addresses.length, failed };
}

/**
 * Stage 2: for confirmed stock tokens only, read the scheduled-action pair.
 * `newUIMultiplier` equal to `uiMultiplier` means nothing is queued.
 */
export async function readMultiplierState(addresses: Address[]) {
  const contracts = addresses.flatMap((address) => [
    { address, abi: erc8056Abi, functionName: "uiMultiplier" } as const,
    { address, abi: erc8056Abi, functionName: "newUIMultiplier" } as const,
    { address, abi: erc8056Abi, functionName: "effectiveAt" } as const,
    // Effective supply, for a market cap that means what it says. `totalSupply`
    // is the raw figure and is wrong by exactly the multiplier after a split —
    // the same trap that makes `balanceOf` misreport a holding.
    { address, abi: erc8056Abi, functionName: "totalSupplyUI" } as const,
  ]);

  const results = await publicClient.multicall({
    contracts,
    allowFailure: true,
    batchSize: MULTICALL_BATCH,
  });

  const PER = 4;
  return addresses.map((address, i) => {
    const [cur, next, eff, supply] = [
      results[i * PER],
      results[i * PER + 1],
      results[i * PER + 2],
      results[i * PER + 3],
    ];

    /*
     * Whether the node answered at all.
     *
     * Without this the caller cannot tell a token that has no multiplier from
     * one the node refused to read, and the snapshot drops both. A throttled
     * pass then removes tokens from the chain rather than reporting a fault —
     * the same failure the discovery probe had, one stage further down.
     */
    const name = (cur.error as { name?: string } | undefined)?.name ?? "";
    const unreachable =
      cur.status === "failure" &&
      name !== "ContractFunctionExecutionError" &&
      name !== "ContractFunctionRevertedError";

    return {
      address,
      uiMultiplier: cur.status === "success" ? (cur.result as bigint) : null,
      newUIMultiplier: next.status === "success" ? (next.result as bigint) : null,
      effectiveAt: eff.status === "success" ? (eff.result as bigint) : null,
      totalSupplyUI: supply.status === "success" ? (supply.result as bigint) : null,
      unreachable,
    };
  });
}

/** Raw + effective balances for one holder across many stock tokens. */
export async function readHolderBalances(holder: Address, addresses: Address[]) {
  const contracts = addresses.flatMap((address) => [
    { address, abi: erc8056Abi, functionName: "balanceOf", args: [holder] } as const,
    { address, abi: erc8056Abi, functionName: "balanceOfUI", args: [holder] } as const,
  ]);

  const results = await publicClient.multicall({ contracts, allowFailure: true });

  return addresses.map((address, i) => {
    const raw = results[i * 2];
    const ui = results[i * 2 + 1];
    return {
      address,
      raw: raw.status === "success" ? (raw.result as bigint) : 0n,
      effective: ui.status === "success" ? (ui.result as bigint) : 0n,
    };
  });
}
