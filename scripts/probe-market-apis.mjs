// Which keyless market APIs actually serve Robinhood Chain, and can they feed charts?
const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36";

const get = async (url, label) => {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
    if (!res.ok) { console.log(`  ${label}: HTTP ${res.status}`); return null; }
    return await res.json();
  } catch (e) { console.log(`  ${label}: ${e.message}`); return null; }
};

console.log("=== GeckoTerminal /networks/robinhood/pools ===");
const pools = await get("https://api.geckoterminal.com/api/v2/networks/robinhood/pools?page=1", "pools");
const items = pools?.data ?? [];
console.log("  pools returned:", items.length);
for (const p of items.slice(0, 6)) {
  const a = p.attributes ?? {};
  console.log(`   ${String(a.name).padEnd(20)} liq=$${Number(a.reserve_in_usd || 0).toLocaleString("en-US", { maximumFractionDigits: 0 }).padStart(11)}  vol24h=$${Number(a.volume_usd?.h24 || 0).toLocaleString("en-US", { maximumFractionDigits: 0 })}`);
}

const pool = items[0]?.attributes?.address;
console.log("\n=== GeckoTerminal OHLCV (chart source) ===");
console.log("  pool:", pool);
for (const tf of ["hour", "day"]) {
  const o = await get(`https://api.geckoterminal.com/api/v2/networks/robinhood/pools/${pool}/ohlcv/${tf}?aggregate=1&limit=5`, `ohlcv/${tf}`);
  const list = o?.data?.attributes?.ohlcv_list ?? [];
  console.log(`  ${tf}: ${list.length} candles`);
  for (const c of list.slice(0, 3)) {
    console.log(`     ${new Date(c[0] * 1000).toISOString().slice(0, 16)}  O ${c[1]}  H ${c[2]}  L ${c[3]}  C ${c[4]}  V ${Math.round(c[5])}`);
  }
}

console.log("\n=== GeckoTerminal: pools for one stock token ===");
const tokPools = await get(`https://api.geckoterminal.com/api/v2/networks/robinhood/tokens/${NVDA}/pools`, "token pools");
console.log("  NVDA pools:", (tokPools?.data ?? []).length);
for (const p of (tokPools?.data ?? []).slice(0, 3)) {
  const a = p.attributes ?? {};
  console.log(`   ${a.name}  price=$${a.base_token_price_usd}  liq=$${Number(a.reserve_in_usd || 0).toLocaleString("en-US", { maximumFractionDigits: 0 })}`);
}

console.log("\n=== DexScreener ===");
const ds = await get(`https://api.dexscreener.com/latest/dex/tokens/${NVDA}`, "dexscreener");
const pairs = (ds?.pairs ?? []).filter((p) => p.chainId === "robinhood");
console.log("  robinhood pairs:", pairs.length);
const top = pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
if (top) {
  console.log(`   top: ${top.baseToken.symbol}/${top.quoteToken.symbol} $${top.priceUsd} liq=$${Math.round(top.liquidity.usd).toLocaleString()}`);
  console.log(`   txns24h buys=${top.txns?.h24?.buys} sells=${top.txns?.h24?.sells} | vol24h=$${Math.round(top.volume?.h24 ?? 0).toLocaleString()} | change24h=${top.priceChange?.h24}%`);
}

console.log("\n=== CoinGecko: is the token indexed on the robinhood platform? ===");
const cg = await get(`https://api.coingecko.com/api/v3/coins/robinhood/contract/${NVDA.toLowerCase()}`, "coingecko contract");
if (cg?.id) {
  console.log(`  id=${cg.id} | name=${cg.name} | price=$${cg.market_data?.current_price?.usd} | mcap=$${cg.market_data?.market_cap?.usd}`);
} else {
  console.log("  not indexed individually (expected — CoinGecko covers the category, not every token)");
}

console.log("\n=== Free stock-quote candidates (no key needed) ===");
const y = await get("https://query1.finance.yahoo.com/v8/finance/chart/NVDA?range=1d&interval=1h", "yahoo chart");
const meta = y?.chart?.result?.[0]?.meta;
if (meta) {
  console.log(`  Yahoo: ${meta.symbol} $${meta.regularMarketPrice} | prevClose $${meta.chartPreviousClose} | state=${meta.marketState} | tz=${meta.exchangeTimezoneName}`);
  const q = y.chart.result[0].indicators?.quote?.[0];
  console.log(`  candles available: ${q?.close?.filter(Boolean).length ?? 0}`);
} else {
  console.log("  Yahoo: unavailable");
}
