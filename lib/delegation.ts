import {
  concat,
  encodeAbiParameters,
  keccak256,
  pad,
  toHex,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";
import { DELEGATION_FRAMEWORK } from "./autonomous";
import { V3_POSITION_MANAGER, V4_POSITION_MANAGER } from "./lp-positions";

/**
 * Builds and signs the scoped delegation that lets Veltr act.
 *
 * A delegation is signed off-chain and redeemed later by the delegate, so
 * creating one costs nothing and broadcasts nothing. Authority is expressed as
 * caveats — small on-chain contracts the DelegationManager consults before
 * allowing a call through — and the whole safety argument rests on which ones
 * are attached.
 *
 * The three that matter here do different jobs, and all three are required:
 *
 *   allowedTargets   which contracts may be called
 *   allowedMethods   which function selectors may be invoked
 *   allowedCalldata  what the arguments may contain
 *
 * The third is the one people forget. `collect(tokenId, recipient, …)` passes
 * both a target check and a selector check while sending funds anywhere the
 * caller likes, so without argument-level enforcement "funds may only move to
 * the owner" is not a guarantee, it is a hope.
 */

/** A root delegation has no parent; the framework marks that with all-ones. */
export const ROOT_AUTHORITY: Hex =
  "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

export type Caveat = { enforcer: Address; terms: Hex; args: Hex };

export type Delegation = {
  delegate: Address;
  delegator: Address;
  authority: Hex;
  caveats: Caveat[];
  salt: bigint;
  signature: Hex;
};

/* ------------------------------------------------------------ Terms */

/** AllowedTargets takes packed 20-byte addresses. */
export function targetsTerms(targets: Address[]): Hex {
  if (targets.length === 0) throw new Error("At least one target is required.");
  return concat(targets);
}

/** AllowedMethods takes packed 4-byte selectors. */
export function methodsTerms(signatures: string[]): Hex {
  if (signatures.length === 0) throw new Error("At least one method is required.");
  return concat(signatures.map((sig) => toFunctionSelector(sig)));
}

/**
 * AllowedCalldata pins one 32-byte argument to an exact value.
 *
 * `dataStart` is the byte offset of the argument within calldata: 4 bytes of
 * selector, then 32 bytes per preceding argument. Pinning a recipient argument
 * to the owner's address is what stops a compromised key redirecting funds.
 */
export function calldataTerms(argIndex: number, value: Hex): Hex {
  const dataStart = 4 + argIndex * 32;
  return concat([pad(toHex(dataStart), { size: 32 }), pad(value, { size: 32 })]);
}

/** TimestampEnforcer takes two uint128s: not-before, not-after. */
export function timestampTerms(notBefore: number, notAfter: number): Hex {
  return concat([pad(toHex(notBefore), { size: 16 }), pad(toHex(notAfter), { size: 16 })]);
}

export function uint256Terms(value: bigint): Hex {
  return pad(toHex(value), { size: 32 });
}

/* ------------------------------------------------- The defensive policy */

/**
 * Contracts the key may touch.
 *
 * Uniswap V3 only, and V4 is excluded on purpose. `allowedCalldata` pins an
 * argument at a fixed byte offset, which works for V3's `collect` because its
 * recipient sits at a known position. V4 routes everything through
 * `modifyLiquidities(bytes actions, uint256)`, where the recipient is encoded
 * inside a variable-length blob at an offset that shifts with the action list —
 * so no fixed-offset check can reach it.
 *
 * Including V4 would leave a path where the key could name a recipient other
 * than the owner. One venue that is fully constrained beats two where the
 * guarantee only holds on one.
 */
export const DEFENSIVE_TARGETS: Address[] = [V3_POSITION_MANAGER];

/** Kept for the note above and for when argument-level enforcement can reach it. */
export const EXCLUDED_TARGETS = {
  [V4_POSITION_MANAGER]: "Recipient lives inside variable-length calldata; not enforceable at a fixed offset.",
} as const;

/**
 * Selectors the key may call. Every one reduces a position or returns assets.
 * `approve`, `mint`, `swap` and `increaseLiquidity` are absent by construction —
 * an allow-list denies everything it does not name.
 */
export const DEFENSIVE_METHODS = [
  "function decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))",
  "function collect((uint256,address,uint128,uint128))",
  "function burn(uint256)",
] as const;

export type PolicyOptions = {
  owner: Address;
  /** Seconds from now until the delegation expires. */
  ttlSeconds?: number;
  /** Maximum native value per call, in wei. Defaults to zero. */
  maxValueWei?: bigint;
  /** Maximum number of redemptions. */
  maxCalls?: number;
};

/** Caveats every delegation carries regardless of what it permits. */
function baseCaveats(options: PolicyOptions): Caveat[] {
  const { ttlSeconds = 30 * 24 * 3600, maxValueWei = 0n, maxCalls = 50 } = options;
  const now = Math.floor(Date.now() / 1000);
  const e = DELEGATION_FRAMEWORK.enforcers;

  return [
    { enforcer: e.allowedTargets as Address, terms: targetsTerms(DEFENSIVE_TARGETS), args: "0x" },
    { enforcer: e.valueLte as Address, terms: uint256Terms(maxValueWei), args: "0x" },
    { enforcer: e.timestamp as Address, terms: timestampTerms(now - 60, now + ttlSeconds), args: "0x" },
    { enforcer: e.limitedCalls as Address, terms: uint256Terms(BigInt(maxCalls)), args: "0x" },
  ];
}

/**
 * Authority to sweep a position's balance to its owner.
 *
 * `collect` is the only permitted call that actually moves assets out, so this
 * is the only delegation that needs the recipient pinned — and it is pinned
 * here, at the argument offset where `collect` carries it.
 */
export function buildCollectCaveats(options: PolicyOptions): Caveat[] {
  const e = DELEGATION_FRAMEWORK.enforcers;
  return [
    ...baseCaveats(options),
    {
      enforcer: e.allowedMethods as Address,
      terms: methodsTerms(["function collect((uint256,address,uint128,uint128))"]),
      args: "0x",
    },
    {
      // collect(tokenId, recipient, …): recipient sits at argument index 1.
      enforcer: e.allowedCalldata as Address,
      terms: calldataTerms(1, options.owner),
      args: "0x",
    },
  ];
}

/**
 * Authority to unwind a position.
 *
 * Deliberately carries no calldata pin. A single enforcer checks one fixed byte
 * offset against one fixed value, and it applies to every call the delegation
 * permits — so pinning `collect`'s recipient offset here would compare
 * `decreaseLiquidity`'s liquidity amount against an address and reject it. That
 * is exactly what happened when both selectors shared one delegation: the key
 * could sweep fees but could not exit a position, which is the one thing the
 * defensive tier exists to do.
 *
 * Omitting the pin costs nothing, because neither call sends assets anywhere.
 * `decreaseLiquidity` converts liquidity into amounts owed *to the position*,
 * and `burn` only closes an emptied one. The assets still leave solely through
 * `collect`, whose recipient remains pinned in the delegation above.
 */
export function buildExitCaveats(options: PolicyOptions): Caveat[] {
  const e = DELEGATION_FRAMEWORK.enforcers;
  return [
    ...baseCaveats(options),
    {
      enforcer: e.allowedMethods as Address,
      terms: methodsTerms([
        "function decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))",
        "function burn(uint256)",
      ]),
      args: "0x",
    },
  ];
}

/** @deprecated Use buildCollectCaveats and buildExitCaveats. */
export function buildDefensiveCaveats(options: PolicyOptions): Caveat[] {
  return buildCollectCaveats(options);
}

/* --------------------------------------------------------- EIP-712 */

export const EIP712_TYPES = {
  Caveat: [
    { name: "enforcer", type: "address" },
    { name: "terms", type: "bytes" },
  ],
  Delegation: [
    { name: "delegate", type: "address" },
    { name: "delegator", type: "address" },
    { name: "authority", type: "bytes32" },
    { name: "caveats", type: "Caveat[]" },
    { name: "salt", type: "uint256" },
  ],
} as const;

export function delegationDomain(chainId: number) {
  return {
    name: "DelegationManager",
    version: "1",
    chainId,
    verifyingContract: DELEGATION_FRAMEWORK.manager as Address,
  } as const;
}

/** The message the delegator signs. `args` and `signature` are excluded. */
export function delegationMessage(delegation: Omit<Delegation, "signature">) {
  return {
    delegate: delegation.delegate,
    delegator: delegation.delegator,
    authority: delegation.authority,
    caveats: delegation.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms })),
    salt: delegation.salt,
  };
}

/** Stable identifier for a delegation, used for storage and revocation. */
export function delegationHash(delegation: Omit<Delegation, "signature">): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "bytes32" },
      ],
      [
        delegation.delegate,
        delegation.delegator,
        delegation.authority,
        delegation.salt,
        keccak256(
          concat(delegation.caveats.map((c) => keccak256(concat([c.enforcer, c.terms]))))
        ),
      ]
    )
  );
}

/** Human-readable description of what a delegation permits. */
export function describeDelegation(delegation: Omit<Delegation, "signature">) {
  const byEnforcer = new Map(
    Object.entries(DELEGATION_FRAMEWORK.enforcers).map(([name, addr]) => [
      (addr as string).toLowerCase(),
      name,
    ])
  );

  return {
    delegate: delegation.delegate,
    delegator: delegation.delegator,
    caveatCount: delegation.caveats.length,
    caveats: delegation.caveats.map((c) => ({
      enforcer: byEnforcer.get(c.enforcer.toLowerCase()) ?? c.enforcer,
      termsBytes: (c.terms.length - 2) / 2,
    })),
    allowedTargets: DEFENSIVE_TARGETS,
    allowedMethods: DEFENSIVE_METHODS.map((sig) => ({
      signature: sig.replace("function ", ""),
      selector: toFunctionSelector(sig),
    })),
  };
}
