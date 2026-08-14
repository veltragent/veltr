import { createPublicClient, http, parseAbi, formatUnits } from "viem";
import { readFileSync } from "node:fs";

if (!process.env.VELTR_RPC_URL) throw new Error("VELTR_RPC_URL is not set — run with: node --env-file=.env.local " + import.meta.filename);

const RPC = process.env.VELTR_RPC_URL;
const client = createPublicClient({ transport: http(RPC, { batch: true, timeout: 40_000 }) });

const V3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const V2_FACTORY = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

const factoryAbi = parseAbi([
  "function getPool(address,address,uint24) view returns (address)",
  "function getPair(address,address) view returns (address)",
]);
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

console.log("factory code check:");
for (const [name, addr] of [["V3", V3_FACTORY], ["V2", V2_FACTORY]]) {
  const code = await client.getCode({ address: addr });
  console.log(`  ${name} factory ${addr}: ${code && code !== "0x" ? "DEPLOYED" : "missing"}`);
}

const tokens = JSON.parse(readFileSync(new URL("../data/stock-tokens.json", import.meta.url)));
const picks = ["CRWD", "NVDA", "AAPL", "TSLA", "SPY", "ORCL", "SGOV"]
  .map((s) => tokens.find((t) => t.symbol === s))
  .filter(Boolean);

const FEES = [100, 500, 3000, 10000];

console.log("\nsearching pools (stock token paired with USDG or WETH):");
let found = 0;

for (const tok of picks) {
  for (const [quoteName, quote] of [["USDG", USDG], ["WETH", WETH]]) {
    // Uniswap V2
    try {
      const pair = await client.readContract({
        address: V2_FACTORY, abi: factoryAbi, functionName: "getPair", args: [tok.address, quote],
      });
      if (pair && pair !== "0x0000000000000000000000000000000000000000") {
        const bal = await client.readContract({ address: tok.address, abi: erc20, functionName: "balanceOf", args: [pair] });
        console.log(`  ${tok.symbol}/${quoteName} V2      ${pair}  tokenReserve=${formatUnits(bal, 18)}`);
        found++;
      }
    } catch {}

    // Uniswap V3
    for (const fee of FEES) {
      try {
        const pool = await client.readContract({
          address: V3_FACTORY, abi: factoryAbi, functionName: "getPool", args: [tok.address, quote, fee],
        });
        if (pool && pool !== "0x0000000000000000000000000000000000000000") {
          const bal = await client.readContract({ address: tok.address, abi: erc20, functionName: "balanceOf", args: [pool] });
          console.log(`  ${tok.symbol}/${quoteName} V3 ${String(fee).padStart(5)} ${pool}  tokenReserve=${formatUnits(bal, 18)}`);
          found++;
        }
      } catch {}
    }
  }
}

if (!found) console.log("  none found at canonical factory addresses");

// Cross-check against an independent index of DEX pools on this chain.
console.log("\nGeckoTerminal pools on robinhood-chain:");
try {
  const res = await fetch("https://api.geckoterminal.com/api/v2/networks/robinhood-chain/pools?page=1");
  if (!res.ok) {
    console.log("  http", res.status);
  } else {
    const j = await res.json();
    const items = j.data ?? [];
    console.log("  count:", items.length);
    for (const p of items.slice(0, 12)) {
      const a = p.attributes ?? {};
      console.log(`   ${(a.name ?? "?").padEnd(24)} liq=$${Number(a.reserve_in_usd ?? 0).toLocaleString()}  ${p.relationships?.dex?.data?.id ?? ""}`);
    }
  }
} catch (e) {
  console.log("  failed:", e.message);
}
