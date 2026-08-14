import { readFileSync } from "node:fs";
const toks = JSON.parse(readFileSync(new URL("../data/stock-tokens.json", import.meta.url)));

const pending = toks.filter((t) => t.newUIMultiplier && t.newUIMultiplier !== t.uiMultiplier);
const adjusted = toks.filter((t) => t.uiMultiplier !== "1000000000000000000");

console.log(`total=${toks.length}  pendingAction=${pending.length}  alreadyAdjusted=${adjusted.length}\n`);
console.log("PENDING corporate actions:");
if (!pending.length) console.log("  (none scheduled right now)");
for (const p of pending) {
  console.log(`  ${p.symbol}  ${Number(p.uiMultiplier) / 1e18} -> ${Number(p.newUIMultiplier) / 1e18}  effectiveAt=${p.effectiveAt} (${new Date(Number(p.effectiveAt) * 1000).toISOString()})`);
}

console.log("\nAlready-adjusted (accrued dividends/splits):");
for (const a of adjusted.sort((x, y) => Number(y.uiMultiplier) - Number(x.uiMultiplier))) {
  console.log(`  ${String(a.symbol).padEnd(8)} ${(Number(a.uiMultiplier) / 1e18).toFixed(8)}  holders=${a.holders}`);
}

// Does Blockscout expose a USD price for stock tokens? That would give us price data free.
const res = await fetch("https://robinhoodchain.blockscout.com/api/v2/tokens/0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC");
console.log("\nBlockscout token detail (NVDA):");
console.log(JSON.stringify(await res.json(), null, 2).slice(0, 700));
