/**
 * Executes a redemption — the first time the session key actually acts.
 *
 * Simulates first and refuses to broadcast if the simulation fails. Run without
 * --execute to see exactly what would happen.
 *
 *   node scripts/redeem.mjs <tokenId> collect
 *   node scripts/redeem.mjs <tokenId> exit --execute
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
const ACTION = (process.argv[3] ?? "collect").toLowerCase();
const EXECUTE = process.argv.includes("--execute");

if (!TOKEN_ID || !["collect", "exit"].includes(ACTION)) {
  console.log("usage: node scripts/redeem.mjs <tokenId> <collect|exit> [--execute]");
  process.exit(1);
}

const chain = defineChain({
  id: 4663, name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [env.VELTR_RPC_URL] } },
});
const client = createPublicClient({ chain, transport: http() });

const { planCollect, planDecreaseLiquidity, simulate, execute, loadDelegations } =
  await import("../lib/keeper.ts");

const delegations = await loadDelegations();
if (!delegations) { console.log("No signed delegations. Run scripts/sign-delegation.mjs first."); process.exit(1); }

const POSM = "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3";
const position = await client.readContract({
  address: POSM,
  abi: parseAbi(["function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)"]),
  functionName: "positions",
  args: [TOKEN_ID],
}).catch(() => null);

if (!position) { console.log(`Position ${TOKEN_ID} not found.`); process.exit(1); }

const sessionKey = privateKeyToAccount(env.VELTR_SESSION_PRIVATE_KEY);
const gasBalance = await client.getBalance({ address: sessionKey.address });

console.log("REDEMPTION");
console.log("─".repeat(64));
console.log("  tokenId    ", TOKEN_ID.toString());
console.log("  liquidity  ", position[7].toString());
console.log("  owed       ", position[10].toString(), "/", position[11].toString());
console.log("  session key", sessionKey.address);
console.log("  gas balance", formatEther(gasBalance), "ETH");
console.log("  action     ", ACTION);

const plan =
  ACTION === "collect"
    ? planCollect(delegations.collect, TOKEN_ID)
    : planDecreaseLiquidity(delegations.exit, TOKEN_ID, position[7]);

console.log("\n  plan:", plan.action);
console.log("  via :", plan.to, "(DelegationManager)");

const sim = await simulate(plan, sessionKey.address);
console.log("\n  simulation:", sim.ok ? `passes, gas ${sim.gas}` : sim.reason);

if (!sim.ok) { console.log("\n  Not broadcasting a call that would revert."); process.exit(1); }

if (!EXECUTE) {
  console.log("\nDRY RUN — nothing broadcast. Re-run with --execute.");
  process.exit(0);
}

console.log("\n  broadcasting…");
const result = await execute(plan, env.VELTR_SESSION_PRIVATE_KEY);

if (!result.ok) {
  console.log(`  failed at ${result.stage}: ${result.reason}`);
  process.exit(1);
}

console.log("  tx        ", result.hash);
console.log("  block     ", result.blockNumber.toString());
console.log("  gas used  ", result.gasUsed.toString());
console.log("  explorer   https://robinhoodchain.blockscout.com/tx/" + result.hash);

const after = await client.readContract({
  address: POSM,
  abi: parseAbi(["function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)"]),
  functionName: "positions",
  args: [TOKEN_ID],
});

console.log("\n  AFTER");
console.log("  liquidity  ", position[7].toString(), "→", after[7].toString());
console.log("  owed       ", position[10].toString(), "→", after[10].toString());
console.log("\n  The session key acted. The owner signed nothing.");
