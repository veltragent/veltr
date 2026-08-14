import { createPublicClient, http, parseAbiItem, toEventSelector } from "viem";
import { readFileSync } from "node:fs";

const client = createPublicClient({
  transport: http("https://rpc.mainnet.chain.robinhood.com", { batch: true, timeout: 60_000 }),
});

const EVENT = parseAbiItem(
  "event UIMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier, uint256 effectiveAtTimestamp)"
);
console.log("topic0:", toEventSelector(EVENT));

const head = await client.getBlockNumber();
console.log("head block:", head);

const toks = JSON.parse(readFileSync(new URL("../data/stock-tokens.json", import.meta.url)));
const crwd = toks.find((t) => t.symbol === "CRWD");
console.log("CRWD:", crwd.address);

console.log("\n--- full range, single address ---");
try {
  const logs = await client.getLogs({ address: crwd.address, event: EVENT, fromBlock: 0n, toBlock: "latest" });
  console.log("OK, logs:", logs.length);
  for (const l of logs)
    console.log(
      "   block", l.blockNumber,
      "old", (Number(l.args.oldMultiplier) / 1e18).toFixed(6),
      "-> new", (Number(l.args.newMultiplier) / 1e18).toFixed(6),
      "effAt", new Date(Number(l.args.effectiveAtTimestamp) * 1000).toISOString()
    );
} catch (e) {
  console.log("FAILED:", e.shortMessage || String(e.message).slice(0, 300));
}

console.log("\n--- full range, ALL addresses ---");
try {
  const logs = await client.getLogs({
    address: toks.map((t) => t.address),
    event: EVENT,
    fromBlock: 0n,
    toBlock: "latest",
  });
  console.log("OK, total logs:", logs.length);
  const bySym = new Map(toks.map((t) => [t.address.toLowerCase(), t.symbol]));
  const counts = {};
  for (const l of logs) {
    const s = bySym.get(l.address.toLowerCase()) ?? l.address;
    counts[s] = (counts[s] || 0) + 1;
  }
  console.log("events per token:", JSON.stringify(counts));
} catch (e) {
  console.log("FAILED:", e.shortMessage || String(e.message).slice(0, 300));
}
