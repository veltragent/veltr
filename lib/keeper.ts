import {
  encodeAbiParameters,
  encodeFunctionData,
  parseAbi,
  concat,
  pad,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { publicClient } from "./chain";
import { dataFile } from "./paths";
import { DELEGATION_FRAMEWORK } from "./autonomous";
import { V3_POSITION_MANAGER } from "./lp-positions";
import type { Delegation } from "./delegation";

/**
 * Redemption: turning a signed delegation into an actual on-chain action.
 *
 * The session key calls `redeemDelegations` on the DelegationManager, which
 * walks every caveat before forwarding the call to the delegator's account. If
 * any enforcer rejects, the whole redemption reverts — so a mis-scoped call
 * fails loudly rather than executing partially.
 *
 * Nothing here broadcasts. Every path returns a simulated result first, because
 * an unsimulated transaction against someone's position is a guess.
 */

const DELEGATION_MANAGER_ABI = parseAbi([
  "function redeemDelegations(bytes[] permissionContexts, bytes32[] modes, bytes[] executionCallDatas)",
]);

const POSITION_MANAGER_ABI = parseAbi([
  "function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline)) returns (uint256,uint256)",
  "function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max)) returns (uint256,uint256)",
  "function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)",
]);

/** ERC-7579 single call, default execution mode. */
const SINGLE_DEFAULT_MODE: Hex =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

/** ERC-7579 packs a single execution as target ++ value ++ calldata. */
function encodeSingleExecution(target: Address, value: bigint, callData: Hex): Hex {
  return concat([target, pad(toHex(value), { size: 32 }), callData]);
}

const DELEGATION_TUPLE = {
  type: "tuple[]",
  components: [
    { name: "delegate", type: "address" },
    { name: "delegator", type: "address" },
    { name: "authority", type: "bytes32" },
    {
      name: "caveats",
      type: "tuple[]",
      components: [
        { name: "enforcer", type: "address" },
        { name: "terms", type: "bytes" },
        { name: "args", type: "bytes" },
      ],
    },
    { name: "salt", type: "uint256" },
    { name: "signature", type: "bytes" },
  ],
} as const;

/** The delegation chain, encoded as the manager expects it. */
function encodePermissionContext(delegation: Delegation): Hex {
  return encodeAbiParameters(
    [DELEGATION_TUPLE],
    [
      [
        {
          delegate: delegation.delegate,
          delegator: delegation.delegator,
          authority: delegation.authority,
          caveats: delegation.caveats,
          salt: delegation.salt,
          signature: delegation.signature,
        },
      ],
    ]
  );
}

export type RedemptionPlan = {
  to: Address;
  data: Hex;
  action: string;
  target: Address;
  innerCalldata: Hex;
};

/**
 * Builds a redemption that withdraws liquidity from a V3 position.
 *
 * `recipient` is not a parameter: it is fixed to the delegator, because the
 * `allowedCalldata` caveat pins that argument and any other value would be
 * rejected on-chain anyway. Making it settable would only invite a caller to
 * discover that the hard way.
 */
export function planCollect(
  delegation: Delegation,
  tokenId: bigint,
  amountMax: bigint = (1n << 128n) - 1n
): RedemptionPlan {
  const innerCalldata = encodeFunctionData({
    abi: POSITION_MANAGER_ABI,
    functionName: "collect",
    args: [
      {
        tokenId,
        recipient: delegation.delegator,
        amount0Max: amountMax,
        amount1Max: amountMax,
      },
    ],
  });

  const execution = encodeSingleExecution(V3_POSITION_MANAGER, 0n, innerCalldata);

  return {
    to: DELEGATION_FRAMEWORK.manager as Address,
    data: encodeFunctionData({
      abi: DELEGATION_MANAGER_ABI,
      functionName: "redeemDelegations",
      args: [[encodePermissionContext(delegation)], [SINGLE_DEFAULT_MODE], [execution]],
    }),
    action: `collect fees from position #${tokenId} to ${delegation.delegator}`,
    target: V3_POSITION_MANAGER,
    innerCalldata,
  };
}

export function planDecreaseLiquidity(
  delegation: Delegation,
  tokenId: bigint,
  liquidity: bigint,
  deadlineSeconds = 600
): RedemptionPlan {
  const innerCalldata = encodeFunctionData({
    abi: POSITION_MANAGER_ABI,
    functionName: "decreaseLiquidity",
    args: [
      {
        tokenId,
        liquidity,
        amount0Min: 0n,
        amount1Min: 0n,
        deadline: BigInt(Math.floor(Date.now() / 1000) + deadlineSeconds),
      },
    ],
  });

  const execution = encodeSingleExecution(V3_POSITION_MANAGER, 0n, innerCalldata);

  return {
    to: DELEGATION_FRAMEWORK.manager as Address,
    data: encodeFunctionData({
      abi: DELEGATION_MANAGER_ABI,
      functionName: "redeemDelegations",
      args: [[encodePermissionContext(delegation)], [SINGLE_DEFAULT_MODE], [execution]],
    }),
    action: `withdraw ${liquidity} liquidity from position #${tokenId}`,
    target: V3_POSITION_MANAGER,
    innerCalldata,
  };
}

export type SimulationResult =
  | { ok: true; gas: bigint; plan: RedemptionPlan }
  | { ok: false; reason: string; plan: RedemptionPlan };

/**
 * Simulates a redemption from the session key's address.
 *
 * A revert here is the caveat set doing its job, so the message is surfaced
 * rather than swallowed — "target-address-not-allowed" is a correct outcome for
 * a call that should not have been attempted.
 */
export async function simulate(plan: RedemptionPlan, sessionKey: Address): Promise<SimulationResult> {
  try {
    const gas = await publicClient.estimateGas({
      account: sessionKey,
      to: plan.to,
      data: plan.data,
      value: 0n,
    });
    return { ok: true, gas, plan };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const enforcer = message.match(/[A-Za-z]+Enforcer:[a-z-]+/)?.[0];
    return {
      ok: false,
      reason: enforcer ? `rejected by ${enforcer}` : message.split("\n")[0].slice(0, 200),
      plan,
    };
  }
}

/**
 * Sends a redemption.
 *
 * Simulation always runs first and a failure aborts before anything is signed:
 * broadcasting a redemption that a caveat will reject wastes gas and teaches
 * nothing, and broadcasting one whose effect was never checked is a guess about
 * someone else's position.
 */
export async function execute(
  plan: RedemptionPlan,
  sessionPrivateKey: Hex
): Promise<
  | { ok: true; hash: Hex; gasUsed: bigint; blockNumber: bigint }
  | { ok: false; reason: string; stage: "simulation" | "broadcast" }
> {
  const { createWalletClient, http } = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");
  const { robinhoodChain } = await import("./chain");

  const account = privateKeyToAccount(sessionPrivateKey);

  const simulation = await simulate(plan, account.address);
  if (!simulation.ok) return { ok: false, reason: simulation.reason, stage: "simulation" };

  try {
    const wallet = createWalletClient({ account, chain: robinhoodChain, transport: http() });
    const hash = await wallet.sendTransaction({
      to: plan.to,
      data: plan.data,
      value: 0n,
      // Headroom over the estimate: a redemption walks every caveat, and a
      // tight limit turns a passing call into an out-of-gas revert.
      gas: (simulation.gas * 130n) / 100n,
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      return { ok: false, reason: `reverted in block ${receipt.blockNumber}`, stage: "broadcast" };
    }
    return { ok: true, hash, gasUsed: receipt.gasUsed, blockNumber: receipt.blockNumber };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message.split("\n")[0].slice(0, 200) : "send failed",
      stage: "broadcast",
    };
  }
}

/** Loads the signed delegations, picking the one that fits an action. */
export async function loadDelegations(): Promise<{ collect: Delegation; exit: Delegation } | null> {
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(dataFile("delegation.json"), "utf8");
    const record = JSON.parse(raw);
    if (!record.collect || !record.exit) return null;
    return {
      collect: { ...record.collect, salt: BigInt(record.collect.salt) },
      exit: { ...record.exit, salt: BigInt(record.exit.salt) },
    };
  } catch {
    return null;
  }
}

/** Reads a V3 position so a plan can be built against real state. */
export async function readPosition(tokenId: bigint) {
  try {
    const p = (await publicClient.readContract({
      address: V3_POSITION_MANAGER,
      abi: POSITION_MANAGER_ABI,
      functionName: "positions",
      args: [tokenId],
    })) as readonly unknown[];

    return {
      tokenId,
      token0: p[2] as Address,
      token1: p[3] as Address,
      fee: Number(p[4]),
      liquidity: p[7] as bigint,
      owed0: p[10] as bigint,
      owed1: p[11] as bigint,
    };
  } catch {
    return null;
  }
}
