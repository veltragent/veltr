// Discovery: find real ERC-8056 stock tokens on Robinhood Chain mainnet.
// Strategy: list ERC-20s from Blockscout, then probe uiMultiplier() on-chain.
// Tokens that answer the ERC-8056 interface ARE stock tokens. No registry address needed.
import { createPublicClient, http, toFunctionSelector } from "viem";
import { writeFileSync, mkdirSync } from "node:fs";

const RPC = "https://rpc.mainnet.chain.robinhood.com";
const BLOCKSCOUT = "https://robinhoodchain.blockscout.com/api/v2";

const client = createPublicClient({ transport: http(RPC, { batch: true, timeout: 30_000 }) });

const SEL = {
  uiMultiplier: toFunctionSelector("function uiMultiplier() view returns (uint256)"),
  newUIMultiplier: toFunctionSelector("function newUIMultiplier() view returns (uint256)"),
  effectiveAt: toFunctionSelector("function effectiveAt() view returns (uint256)"),
};

async function listErc20s(maxPages = 12) {
  const out = [];
  let url = `${BLOCKSCOUT}/tokens?type=ERC-20`;
  for (let i = 0; i < maxPages && url; i++) {
    const res = await fetch(url);
    if (!res.ok) break;
    const json = await res.json();
    out.push(...(json.items ?? []));
    const p = json.next_page_params;
    if (!p) break;
    url = `${BLOCKSCOUT}/tokens?type=ERC-20&${new URLSearchParams(p).toString()}`;
  }
  return out;
}

async function probe(address, selector) {
  try {
    const data = await client.call({ to: address, data: selector });
    if (!data?.data || data.data === "0x") return null;
    return BigInt(data.data);
  } catch {
    return null;
  }
}

const tokens = await listErc20s();
console.log(`Blockscout returned ${tokens.length} ERC-20 tokens. Probing ERC-8056...`);

const stock = [];
const CONCURRENCY = 12;
for (let i = 0; i < tokens.length; i += CONCURRENCY) {
  const batch = tokens.slice(i, i + CONCURRENCY);
  const results = await Promise.all(
    batch.map(async (t) => {
      const mult = await probe(t.address_hash, SEL.uiMultiplier);
      if (mult === null) return null;
      const [pending, effAt] = await Promise.all([
        probe(t.address_hash, SEL.newUIMultiplier),
        probe(t.address_hash, SEL.effectiveAt),
      ]);
      return {
        address: t.address_hash,
        symbol: t.symbol,
        name: t.name,
        decimals: Number(t.decimals ?? 18),
        holders: Number(t.holders_count ?? 0),
        totalSupply: t.total_supply,
        uiMultiplier: mult.toString(),
        newUIMultiplier: pending?.toString() ?? null,
        effectiveAt: effAt?.toString() ?? null,
      };
    })
  );
  stock.push(...results.filter(Boolean));
  process.stdout.write(`\r  probed ${Math.min(i + CONCURRENCY, tokens.length)}/${tokens.length} — found ${stock.length}`);
}

console.log(`\n\nERC-8056 stock tokens found: ${stock.length}\n`);
for (const s of stock.slice(0, 40)) {
  const m = Number(s.uiMultiplier) / 1e18;
  const pend = s.newUIMultiplier && s.newUIMultiplier !== s.uiMultiplier ? ` PENDING->${(Number(s.newUIMultiplier) / 1e18).toFixed(6)} @${s.effectiveAt}` : "";
  console.log(`  ${String(s.symbol).padEnd(10)} mult=${m.toFixed(6)} holders=${String(s.holders).padEnd(7)} ${s.address}${pend}`);
}

mkdirSync(new URL("../data/", import.meta.url), { recursive: true });
writeFileSync(new URL("../data/stock-tokens.json", import.meta.url), JSON.stringify(stock, null, 2));
console.log(`\nWrote data/stock-tokens.json (${stock.length} tokens)`);
