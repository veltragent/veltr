// End-to-end check of the token watch data path against the live chain.
//
// Runs the real aggregator over real contract addresses, then drives one full
// monitoring cycle with injected state so the alert engine is exercised on live
// market data without writing anything or sending a message.
//
//   node --import ./tests/resolve-ts.mjs scripts/probe-watch.mjs

import { fetchTokenMarketData, fetchSourceReadings, readingFor } from "../lib/watch/aggregate.ts";
import { runWatchCycle } from "../lib/watch/engine.ts";
import { fullyArmed } from "../lib/watch/alerts.ts";
import { DEFAULT_SETTINGS } from "../lib/watch/settings.ts";
import { renderWatchConfirmation } from "../lib/watch/format.ts";

const TOKENS = {
  AI: "0x2e8c31162b855a2ffa90f6f8634643ad6f111e18",
  NVDA: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
  USDG: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
};
const NOT_A_TOKEN = "0x000000000000000000000000000000000000dEaD";

const line = (t) => console.log(`\n${"─".repeat(70)}\n${t}\n`);

line("1. Single-token lookup — the /watch path");
for (const [name, address] of Object.entries(TOKENS)) {
  const data = await fetchTokenMarketData(address, { deep: true });
  if (!data) {
    console.log(`  ${name.padEnd(6)} NOT FOUND`);
    continue;
  }
  console.log(
    `  ${name.padEnd(6)} price=${String(data.priceUsd).padEnd(16)} mc=${String(data.marketCap).padEnd(12)} liq=${String(
      Math.round(data.liquidity ?? 0)
    ).padEnd(10)} vol24=${String(Math.round(data.volume24h ?? 0)).padEnd(10)} sources=${data.source.join("+")}`
  );
  console.log(
    `         5m=${data.priceChange5m}  1h=${data.priceChange1h}  6h=${data.priceChange6h}  24h=${data.priceChange24h}  dex=${data.dex}`
  );
}

line("2. A contract with no market — must be reported, not crash");
const missing = await fetchTokenMarketData(NOT_A_TOKEN);
console.log("  result:", missing === null ? "null (correct: token not found)" : missing);

line("2b. Address disambiguation — /watch must still accept a wallet");
const { classifyAddress, handleWatch } = await import("../lib/watch/commands.ts");
for (const [label, address] of [
  ["AI token (contract, trades)      ", TOKENS.AI],
  ["ZkLighter proxy (wallet, no pair)", "0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d"],
  ["plain EOA                        ", "0x1111111111111111111111111111111111111111"],
]) {
  const kind = await classifyAddress(address);
  // Only a contract goes on to the market test; an EOA is a wallet outright.
  const traded = kind === "contract" ? (await fetchTokenMarketData(address)) !== null : false;
  console.log(
    `  ${label} bytecode=${kind.padEnd(8)} indexed_pair=${String(traded).padEnd(5)} → ${
      kind === "contract" && traded ? "TOKEN WATCH" : "WALLET SCOPE (original behaviour)"
    }`
  );
}
console.log("\n  handleWatch on a contract with no pair signals the fallback:");
const deadReply = await handleWatch("probe-user", NOT_A_TOKEN);
console.log(`   notFound=${deadReply.notFound === true}`);

line("3. Batched read — what the monitoring cycle actually costs");
const addresses = Object.values(TOKENS);
const t0 = Date.now();
const readings = await fetchSourceReadings(addresses);
console.log(
  `  ${addresses.length} tokens in ${Date.now() - t0}ms | dexscreener=${readings.dexscreener.size} geckoterminal=${readings.geckoterminal.size}`
);
for (const address of addresses) {
  const merged = readingFor(readings, address, { useDexScreener: true, useGeckoTerminal: true });
  console.log(`   ${address.slice(0, 10)}… → ${merged?.symbol ?? "?"} $${merged?.priceUsd ?? "—"}`);
}

line("4. Confirmation message as the user would receive it");
const aiData = await fetchTokenMarketData(TOKENS.AI, { deep: true });
const watch = {
  id: "probe",
  userId: "probe-user",
  chain: "robinhood",
  tokenAddress: TOKENS.AI,
  symbol: aiData?.symbol ?? null,
  name: aiData?.name ?? null,
  pairAddress: aiData?.pairAddress ?? null,
  baselinePrice: aiData?.priceUsd ?? null,
  lastPrice: aiData?.priceUsd ?? null,
  lastMarketCap: aiData?.marketCap ?? null,
  lastLiquidity: aiData?.liquidity ?? null,
  lastVolume: aiData?.volume24h ?? null,
  lastCheckedAt: new Date().toISOString(),
  lastAlertAt: null,
  armed: fullyArmed(),
  enabled: true,
  createdAt: new Date().toISOString(),
};
console.log(renderWatchConfirmation(watch, aiData, DEFAULT_SETTINGS, false));

line("5. Full monitoring cycle on live data — two users, one token, no I/O");
// Baselines are set below the live price so real market data trips a real
// threshold; nothing is persisted and nothing is sent.
const live = aiData.priceUsd;
const sent = [];

const report = await runWatchCycle({
  loadWatches: async () => [
    { ...watch, id: "w-a", userId: "user-A", baselinePrice: live / 1.2, lastCheckedAt: null },
    { ...watch, id: "w-b", userId: "user-B", baselinePrice: live / 1.2, lastCheckedAt: null },
  ],
  loadSettings: async (ids) =>
    new Map(
      ids.map((id) => [
        id,
        // User A alerts at +10%; user B only at +50% and so should hear nothing.
        { ...DEFAULT_SETTINGS, priceUpPct: id === "user-A" ? 10 : 50 },
      ])
    ),
  persist: async () => {},
  send: async (userId, text) => {
    sent.push({ userId, text });
    return true;
  },
});

console.log("  report:", JSON.stringify(report));
console.log(`  tokens fetched for 2 users watching 1 token: ${report.tokensFetched}`);
console.log(`  recipients: ${sent.map((s) => s.userId).join(", ") || "none"}`);
if (sent[0]) {
  console.log(`\n${sent[0].text}`);
}

line("Done.");
