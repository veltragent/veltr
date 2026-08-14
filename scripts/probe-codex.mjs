// What does Codex actually expose for Robinhood Chain (network 4663)?
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);

const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const NET = 4663;

async function q(label, query, variables = {}) {
  try {
    const res = await fetch(env.CODEX_GRAPHQL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: env.CODEX_API_KEY },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(45_000),
    });
    const j = await res.json();
    if (j.errors) {
      console.log(`\n[${label}] ERRORS: ${JSON.stringify(j.errors).slice(0, 220)}`);
      return null;
    }
    console.log(`\n[${label}] OK`);
    return j.data;
  } catch (e) {
    console.log(`\n[${label}] ${e.message}`);
    return null;
  }
}

// 1. Token metadata + live price
const t = await q("filterTokens", `
  query($net: Int!, $addr: String!) {
    filterTokens(filters: { network: [$net] }, phrase: $addr, limit: 3) {
      results {
        token { address name symbol totalSupply }
        priceUSD
        liquidity
        volume24
        marketCap
        holders
        txnCount24
        uniqueBuys24
        uniqueSells24
        change24
      }
    }
  }`, { net: NET, addr: NVDA });
if (t?.filterTokens?.results?.length) {
  for (const r of t.filterTokens.results) {
    console.log(`   ${r.token.symbol.padEnd(7)} $${r.priceUSD} | liq $${Math.round(Number(r.liquidity||0)).toLocaleString()} | vol24 $${Math.round(Number(r.volume24||0)).toLocaleString()}`);
    console.log(`     holders=${r.holders} txns24=${r.txnCount24} buys=${r.uniqueBuys24} sells=${r.uniqueSells24} change24=${r.change24}`);
  }
}

// 2. Rank ALL tokens on the chain — the "show every token" requirement
const top = await q("filterTokens ranked", `
  query($net: Int!) {
    filterTokens(
      filters: { network: [$net] }
      rankings: { attribute: volume24, direction: DESC }
      limit: 10
    ) {
      count
      results { token { symbol name address } priceUSD volume24 liquidity holders change24 }
    }
  }`, { net: NET });
if (top?.filterTokens) {
  console.log(`   total tokens indexed on network ${NET}: ${top.filterTokens.count}`);
  for (const r of (top.filterTokens.results ?? []).slice(0, 8)) {
    console.log(`   ${String(r.token.symbol).padEnd(9)} $${String(r.priceUSD).slice(0,10).padEnd(11)} vol24 $${Math.round(Number(r.volume24||0)).toLocaleString().padStart(13)} holders ${r.holders}`);
  }
}

// 3. OHLCV bars
const now = Math.floor(Date.now() / 1000);
const bars = await q("getBars", `
  query($symbol: String!, $from: Int!, $to: Int!) {
    getBars(symbol: $symbol, from: $from, to: $to, resolution: "60", removeLeadingNullValues: true) {
      o h l c v t
    }
  }`, { symbol: `${NVDA}:${NET}`, from: now - 86400 * 3, to: now });
if (bars?.getBars) {
  const b = bars.getBars;
  console.log(`   bars returned: ${(b.t ?? []).length}`);
  if (b.t?.length) {
    const i = b.t.length - 1;
    console.log(`   latest: t=${new Date(b.t[i]*1000).toISOString().slice(0,16)} o=${b.o[i]} h=${b.h[i]} l=${b.l[i]} c=${b.c[i]} v=${b.v[i]}`);
  }
}

// 4. Top holders — concentration analysis
const holders = await q("holders", `
  query($input: HoldersInput!) {
    holders(input: $input) { count status items { address balance shiftedBalance } }
  }`, { input: { tokenId: `${NVDA}:${NET}` } });
if (holders?.holders) {
  console.log(`   holder count: ${holders.holders.count} status=${holders.holders.status}`);
  for (const h of (holders.holders.items ?? []).slice(0, 4)) {
    console.log(`     ${h.address} balance=${h.shiftedBalance ?? h.balance}`);
  }
}

// 5. Recent trades
const events = await q("getTokenEvents", `
  query($net: Int!, $addr: String!) {
    getTokenEvents(query: { networkId: $net, address: $addr }, limit: 5) {
      items { eventType timestamp maker token0SwapValueUsd token1SwapValueUsd transactionHash }
    }
  }`, { net: NET, addr: NVDA });
if (events?.getTokenEvents?.items) {
  console.log(`   events: ${events.getTokenEvents.items.length}`);
  for (const e of events.getTokenEvents.items.slice(0, 3)) {
    console.log(`     ${e.eventType} $${e.token0SwapValueUsd ?? e.token1SwapValueUsd ?? "?"} ${new Date(e.timestamp*1000).toISOString().slice(0,16)}`);
  }
}
