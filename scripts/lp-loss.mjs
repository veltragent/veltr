// What did the CRWD 4:1 split actually cost liquidity providers, and what
// would the same event cost on today's most liquid tokens?
import { createPublicClient, http, parseAbi } from "viem";
import { readFileSync } from "node:fs";

if (!process.env.VELTR_RPC_URL) throw new Error("VELTR_RPC_URL is not set — run with: node --env-file=.env.local " + import.meta.filename);

const client = createPublicClient({
  transport: http(process.env.VELTR_RPC_URL, {
    batch: true,
    timeout: 40_000,
  }),
});
const BS = "https://robinhoodchain.blockscout.com/api/v2";

const lossFraction = (m) => 1 - (2 * Math.sqrt(m)) / (1 + m);

const V4_POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const IDENTIFY = parseAbi(["function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)"]);

async function isPool(address) {
  if (address.toLowerCase() === V4_POOL_MANAGER) return "Uniswap V4 PoolManager";
  try {
    await client.readContract({ address, abi: IDENTIFY, functionName: "slot0" });
    return "concentrated-liquidity pool";
  } catch {
    return null;
  }
}

console.log("Arbitrage loss vs holding, by multiplier ratio (constant-product floor):");
for (const m of [1.0001, 1.0007, 1.002, 1.003, 1.5, 2, 3, 4, 10]) {
  console.log(`  ratio ${String(m).padEnd(7)} → ${(lossFraction(m) * 100).toFixed(4)}% of pooled value`);
}

const tokens = JSON.parse(readFileSync(new URL("../data/stock-tokens.json", import.meta.url)));
const picks = ["NVDA", "AAPL", "SPY", "TSLA", "MSFT", "GOOGL"]
  .map((s) => tokens.find((t) => t.symbol === s))
  .filter(Boolean);

console.log("\nPooled stock tokens currently exposed to a corporate action:");
let totalPooledUsd = 0;

for (const tok of picks) {
  const meta = await (await fetch(`${BS}/tokens/${tok.address}`)).json();
  const price = Number(meta.exchange_rate ?? 0);

  const holders = ((await (await fetch(`${BS}/tokens/${tok.address}/holders`)).json()).items ?? []);
  let pooled = 0;
  const found = [];

  for (const h of holders.slice(0, 8)) {
    if (!h.address.is_contract) continue;
    const kind = await isPool(h.address.hash);
    if (!kind) continue;
    const amt = Number(h.value) / 1e18;
    pooled += amt;
    found.push(`${kind} ${amt.toFixed(2)}`);
  }

  const usd = pooled * price;
  totalPooledUsd += usd;
  if (pooled > 0) {
    console.log(`  ${tok.symbol.padEnd(6)} pooled=${pooled.toFixed(2)} @ $${price}  = $${usd.toLocaleString(undefined,{maximumFractionDigits:0})}`);
    for (const f of found) console.log(`         ${f}`);
  }
}

console.log(`\nTotal pooled value across sample: $${totalPooledUsd.toLocaleString(undefined,{maximumFractionDigits:0})}`);
console.log(`If a 4:1 split hit one of these: ${(lossFraction(4) * 100).toFixed(2)}% extracted by arbitrageurs`);
console.log(`  → $${(totalPooledUsd * lossFraction(4)).toLocaleString(undefined,{maximumFractionDigits:0})} on the sample above`);
console.log(`A 0.22% dividend (ORCL-sized): ${(lossFraction(1.0022) * 100).toFixed(6)}% — negligible`);
