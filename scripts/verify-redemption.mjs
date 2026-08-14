/**
 * The final proof: a permitted redemption against a position that actually
 * exists, and a forbidden one against the same delegation.
 *
 * Simulation only. Nothing is broadcast.
 */
import { readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http, defineChain, parseAbi, formatEther } from "viem";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
for (const [k, v] of Object.entries(env)) process.env[k] ??= v;

const TOKEN_ID = BigInt(process.argv[2] ?? "0");
if (!TOKEN_ID) { console.log("usage: node scripts/verify-redemption.mjs <tokenId>"); process.exit(1); }

const chain = defineChain({
  id: 4663, name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [env.VELTR_RPC_URL] } },
});
const client = createPublicClient({ chain, transport: http() });

const POSM = "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3";
const posmAbi = parseAbi([
  "function ownerOf(uint256) view returns (address)",
  "function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)",
]);

const record = JSON.parse(readFileSync(new URL("../data/delegation.json", import.meta.url), "utf8"));
// Each action uses the delegation whose caveats fit it.
const collectDelegation = { ...record.collect, salt: BigInt(record.collect.salt) };
const exitDelegation = { ...record.exit, salt: BigInt(record.exit.salt) };
const delegation = collectDelegation;
const sessionKey = privateKeyToAccount(env.VELTR_SESSION_PRIVATE_KEY);

console.log("POSITION");
console.log("─".repeat(64));

const [owner, position] = await Promise.all([
  client.readContract({ address: POSM, abi: posmAbi, functionName: "ownerOf", args: [TOKEN_ID] }).catch(() => null),
  client.readContract({ address: POSM, abi: posmAbi, functionName: "positions", args: [TOKEN_ID] }).catch(() => null),
]);

if (!owner) { console.log("  tokenId", TOKEN_ID.toString(), "does not exist."); process.exit(1); }

console.log("  tokenId   ", TOKEN_ID.toString());
console.log("  owner     ", owner);
console.log("  delegator ", delegation.delegator);
console.log("  match     ", owner.toLowerCase() === delegation.delegator.toLowerCase());
if (position) {
  console.log("  liquidity ", position[7].toString());
  console.log("  range     ", position[5], "→", position[6]);
}

if (owner.toLowerCase() !== delegation.delegator.toLowerCase()) {
  console.log("\n  The delegation is signed by a different account. Cannot proceed.");
  process.exit(1);
}

const { planCollect, planDecreaseLiquidity, simulate } = await import("../lib/keeper.ts");

console.log("\nREDEMPTION — SIMULATION ONLY");
console.log("─".repeat(64));
console.log("  session key", sessionKey.address);
console.log("  gas balance", formatEther(await client.getBalance({ address: sessionKey.address })), "ETH");

console.log("\n  [1] collect fees to the owner");
const collect = planCollect(delegation, TOKEN_ID);
const r1 = await simulate(collect, sessionKey.address);
console.log("      ", r1.ok ? `WOULD EXECUTE — gas ${r1.gas}` : r1.reason);

console.log("\n  [2] withdraw all liquidity");
const decrease = planDecreaseLiquidity(exitDelegation, TOKEN_ID, position ? position[7] : 1n);
const r2 = await simulate(decrease, sessionKey.address);
console.log("      ", r2.ok ? `WOULD EXECUTE — gas ${r2.gas}` : r2.reason);

console.log("\n  VERDICT");
if (r1.ok || r2.ok) {
  console.log("      A permitted redemption passes every caveat and would execute.");
  console.log("      The session key can defend this position.");
} else {
  console.log("      Neither permitted action would execute. Reasons above.");
}
console.log("\n  Nothing was broadcast.");
