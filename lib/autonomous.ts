import { type Address, type Hex, getAddress, slice, size } from "viem";
import { publicClient } from "./chain";

/**
 * Autonomous tier — EIP-7702 delegation.
 *
 * Veltr deploys no contracts. Every delegate below is an audited implementation
 * already live on this chain; writing a bespoke account to hold user funds for a
 * six-day project would be the single worst decision available here.
 *
 * EIP-7702 rather than an ERC-4337 smart account is deliberate: a 4337 account
 * has a *new address*, so users would have to migrate existing liquidity and
 * lending positions before Veltr could protect them. 7702 lets an existing EOA
 * delegate to contract logic while keeping its address, so Veltr can act on
 * positions the user already holds.
 */

export type DelegateOption = {
  key: string;
  name: string;
  address: Address;
  /** Whether the implementation exposes scoped permissions for session keys. */
  scopedPermissions: boolean;
  note: string;
};

/** Verified deployed on Robinhood Chain mainnet (chain 4663). */
export const DELEGATES: DelegateOption[] = [
  {
    key: "kernel",
    name: "ZeroDev Kernel",
    address: "0xd6CEDDe84be40893d153Be9d467CD6aD37875b28",
    scopedPermissions: true,
    note: "Permission validators allow a key restricted to specific targets, selectors and spend caps.",
  },
  {
    key: "metamask",
    name: "MetaMask Delegator",
    address: "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B",
    scopedPermissions: true,
    note: "Caveat enforcers express allowed targets, allowed methods and value limits.",
  },
  {
    key: "alchemy",
    name: "Alchemy Modular Account v2",
    address: "0x00000000000017c61b5bEe81050EC8eFc9c6fecd",
    scopedPermissions: true,
    note: "Session key module; Alchemy is the chain's documented AA provider.",
  },
  {
    key: "simple7702",
    name: "Simple7702Account",
    address: "0xe6Cae83BdE06E4c305530e199D7217f42808555B",
    scopedPermissions: false,
    note: "Reference implementation. No permission system — unsuitable for a session key.",
  },
];

export const DEFAULT_DELEGATE = DELEGATES[0];

/**
 * The session key's authority, stated as data rather than prose.
 *
 * Every entry reduces risk or returns assets to their owner. There is no action
 * here that opens a position, increases leverage, or names a third-party
 * recipient — so a compromised key can annoy, but cannot steal.
 */
export const DEFENSIVE_POLICY = {
  intent: "Reduce exposure only. Funds may move to the delegating account and nowhere else.",
  allowedActions: [
    // Exactly what the signed delegation permits — no more. `repay` and
    // `withdraw` were listed here while a lending venue was still in scope; they
    // are not in the delegation, so publishing them would promise authority the
    // key does not have.
    { selector: "decreaseLiquidity", reason: "Exit an AMM position before a multiplier applies" },
    { selector: "collect", reason: "Sweep the withdrawn balance back to the owner" },
    { selector: "burn", reason: "Close an emptied position" },
  ],
  invariants: [
    "Only the Uniswap V3 PositionManager may be called",
    "collect is the only call that moves assets out, and its recipient is pinned on-chain to the owner",
    "decreaseLiquidity and burn move nothing out; they only unwind a position in place",
    "No approvals may be granted to third parties",
    "No swap, mint, borrow or leverage-increasing call",
    "Native value capped at zero",
    "Expires after 30 days; at most 50 redemptions; revocable at any time",
  ],
  worstCaseIfCompromised:
    "An unwanted position close. The key cannot move assets to an address other than the owner's.",
} as const;

/**
 * MetaMask delegation framework, verified deployed on Robinhood Chain mainnet.
 *
 * Addresses are taken from the framework's own `documents/Deployments.md`, not
 * from memory. An earlier pass used recalled addresses whose prefixes were right
 * and whose tails were wrong, which made every enforcer look absent and led to
 * the false conclusion that scoped session keys were impossible on this chain.
 * They were deployed the whole time.
 */
export const DELEGATION_FRAMEWORK = {
  manager: "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3",
  enforcers: {
    /** Restricts which contracts the key may call. */
    allowedTargets: "0x7F20f61b1f09b08D970938F6fa563634d65c4EeB",
    /** Restricts which function selectors the key may invoke. */
    allowedMethods: "0x2c21fD0Cb9DC8445CB3fb0DC5E7Bb0Aca01842B5",
    /**
     * Restricts argument values inside the calldata. This is the one that makes
     * "funds may only move to the owner" true: `collect(tokenId, recipient, …)`
     * passes both the target and the selector check, so without this a
     * compromised key could name any recipient it liked.
     */
    allowedCalldata: "0xc2b0d624c1c4319760C96503BA27C347F3260f55",
    /** Caps native value per call. */
    valueLte: "0x92Bf12322527cAA612fd31a0e810472BBB106A8F",
    /** Fixed expiry. */
    timestamp: "0x1046bb45C8d673d4ea75321280DB34899413c069",
    /** Bounds the total number of redemptions. */
    limitedCalls: "0x04658B29F6b82ed55274221a06Fc97D318E25416",
  },
} as const;

/** EIP-7702 marks a delegated EOA with a 23-byte 0xef0100-prefixed code stub. */
const DELEGATION_PREFIX = "0xef0100";

export type DelegationStatus = {
  address: Address;
  delegated: boolean;
  delegateAddress: Address | null;
  delegateName: string | null;
  recognised: boolean;
  balanceWei: string;
  balanceEth: number;
  funded: boolean;
};

export async function readDelegationStatus(address: Address): Promise<DelegationStatus> {
  const [code, balance] = await Promise.all([
    publicClient.getCode({ address }).catch(() => undefined),
    publicClient.getBalance({ address }).catch(() => 0n),
  ]);

  let delegateAddress: Address | null = null;
  if (code && code.startsWith(DELEGATION_PREFIX) && size(code) === 23) {
    delegateAddress = getAddress(slice(code as Hex, 3));
  }

  const known = delegateAddress
    ? DELEGATES.find((d) => d.address.toLowerCase() === delegateAddress!.toLowerCase())
    : undefined;

  return {
    address,
    delegated: delegateAddress !== null,
    delegateAddress,
    delegateName: known?.name ?? null,
    recognised: Boolean(known),
    balanceWei: balance.toString(),
    balanceEth: Number(balance) / 1e18,
    // Enough to sign a delegation and a couple of operations.
    funded: balance >= 10n ** 15n,
  };
}

/** Confirms a delegate implementation is actually deployed before it is used. */
export async function verifyDelegateDeployed(option: DelegateOption) {
  const code = await publicClient.getCode({ address: option.address }).catch(() => undefined);
  const bytes = code && code !== "0x" ? size(code) : 0;
  return { ...option, deployed: bytes > 0, codeSize: bytes };
}
