import { createPublicClient, http, parseAbi, formatUnits } from "viem";
import { readFileSync } from "node:fs";

if (!process.env.VELTR_RPC_URL) throw new Error("VELTR_RPC_URL is not set — run with: node --env-file=.env.local " + import.meta.filename);

const client = createPublicClient({
  transport: http(process.env.VELTR_RPC_URL, {
    batch: true,
    timeout: 40_000,
  }),
});
const BS = "https://robinhoodchain.blockscout.com/api/v2";

const tokens = JSON.parse(readFileSync(new URL("../data/stock-tokens.json", import.meta.url)));
const picks = ["NVDA", "CRWD", "ORCL", "SPY", "AAPL"]
  .map((s) => tokens.find((t) => t.symbol === s))
  .filter(Boolean);

// Signatures that identify what kind of contract a holder is.
const probes = {
  "UniV3 pool": "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)",
  "UniV2 pair": "function getReserves() view returns (uint112,uint112,uint32)",
  "ERC4626 vault": "function asset() view returns (address)",
  "Morpho-like": "function owner() view returns (address)",
};

async function identify(address) {
  const kinds = [];
  for (const [label, sig] of Object.entries(probes)) {
    try {
      await client.readContract({ address, abi: parseAbi([sig]), functionName: sig.split(" ")[1].split("(")[0] });
      kinds.push(label);
    } catch {}
  }
  return kinds;
}

for (const tok of picks) {
  console.log(`\n=== ${tok.symbol} (${tok.address}) ===`);
  const res = await fetch(`${BS}/tokens/${tok.address}/holders`);
  if (!res.ok) {
    console.log("  holders fetch failed", res.status);
    continue;
  }
  const items = (await res.json()).items ?? [];

  for (const h of items.slice(0, 6)) {
    const addr = h.address.hash;
    const isContract = h.address.is_contract;
    const amount = formatUnits(BigInt(h.value), 18);
    let tag = isContract ? "contract" : "EOA";

    if (isContract) {
      const kinds = await identify(addr);
      if (kinds.length) tag = kinds.join("+");
      // Blockscout often knows the verified contract name.
      try {
        const info = await fetch(`${BS}/addresses/${addr}`);
        if (info.ok) {
          const j = await info.json();
          if (j.name) tag += ` "${j.name}"`;
          if (j.implementations?.length) tag += ` [proxy]`;
        }
      } catch {}
    }
    console.log(`  ${Number(amount).toFixed(4).padStart(16)}  ${addr}  ${tag}`);
  }
}
