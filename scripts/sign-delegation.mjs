/**
 * Signs the two scoped delegations the session key needs.
 *
 * Two rather than one because a calldata caveat pins a single byte offset and
 * applies to every call in its delegation. Pinning `collect`'s recipient offset
 * alongside `decreaseLiquidity` compares a liquidity amount against an address
 * and rejects it — the key could sweep fees but never exit a position.
 *
 *   collect  moves assets out, so its recipient is pinned to the owner
 *   exit     unwinds a position without moving anything, so no pin is needed
 *
 * Signing is off-chain. Nothing is broadcast and no gas is spent.
 */
import { createPublicClient, http, defineChain, verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);

const {
  ROOT_AUTHORITY,
  buildCollectCaveats,
  buildExitCaveats,
  delegationDomain,
  delegationMessage,
  EIP712_TYPES,
  delegationHash,
  DEFENSIVE_TARGETS,
} = await import("../lib/delegation.ts");

const chain = defineChain({
  id: 4663, name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [env.VELTR_RPC_URL] } },
});

const delegator = privateKeyToAccount(env.VELTR_DELEGATOR_PRIVATE_KEY);
const sessionKey = privateKeyToAccount(env.VELTR_SESSION_PRIVATE_KEY);
const client = createPublicClient({ chain, transport: http() });

console.log("SCOPED DELEGATIONS");
console.log("─".repeat(64));
console.log("  delegator (owner) ", delegator.address);
console.log("  delegate  (Veltr) ", sessionKey.address);
console.log("  target            ", DEFENSIVE_TARGETS.join(", "));

const code = await client.getCode({ address: delegator.address });
if (!(code?.startsWith("0xef0100") && code.length === 48)) {
  console.log("\n  Account is not delegated. Run scripts/delegate.mjs --execute first.");
  process.exit(1);
}
console.log("  7702 delegation    active");

const domain = delegationDomain(chain.id);
const options = { owner: delegator.address, ttlSeconds: 30 * 24 * 3600, maxValueWei: 0n, maxCalls: 50 };

async function sign(label, caveats, note) {
  const unsigned = {
    delegate: sessionKey.address,
    delegator: delegator.address,
    authority: ROOT_AUTHORITY,
    caveats,
    salt: BigInt("0x" + randomBytes(16).toString("hex")),
  };

  const message = delegationMessage(unsigned);
  const signature = await delegator.signTypedData({
    domain, types: EIP712_TYPES, primaryType: "Delegation", message,
  });

  const valid = await verifyTypedData({
    address: delegator.address, domain, types: EIP712_TYPES,
    primaryType: "Delegation", message, signature,
  });

  console.log(`\n  ${label.toUpperCase()}`);
  console.log(`    ${note}`);
  console.log(`    caveats          ${caveats.length}`);
  console.log(`    signature valid  ${valid}`);
  if (!valid) throw new Error(`${label} signature does not verify`);

  return {
    ...unsigned,
    salt: unsigned.salt.toString(),
    signature,
    hash: delegationHash(unsigned),
  };
}

const collect = await sign(
  "collect",
  buildCollectCaveats(options),
  "sweeps a position's balance; recipient pinned to the owner"
);

const exit = await sign(
  "exit",
  buildExitCaveats(options),
  "unwinds a position; moves nothing out, so no recipient pin"
);

const record = { chainId: chain.id, delegator: delegator.address, delegate: sessionKey.address, collect, exit, createdAt: new Date().toISOString() };

mkdirSync(new URL("../data/", import.meta.url), { recursive: true });
writeFileSync(new URL("../data/delegation.json", import.meta.url), JSON.stringify(record, null, 2));

console.log("\n  Written to data/delegation.json — off-chain only, nothing broadcast.");
