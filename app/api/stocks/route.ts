import { NextResponse } from "next/server";
import { buildRadarSnapshot } from "@/lib/tokens";
import {
  fetchStockQuote,
  fetchCompanyProfile,
  fetchCompanyNews,
  fetchMarketNews,
  fetchRecommendations,
  fetchPeers,
  fetchMarketStatus,
  fetchEarningsForTokens,
} from "@/lib/stocks";
import { readPremium } from "@/lib/market";

export const revalidate = 60;

/**
 * Equity view. Without `symbol` it returns the market-wide picture; with one it
 * returns everything known about that company, including the premium its token
 * trades at on this chain.
 */
export async function GET(request: Request) {
  const symbol = new URL(request.url).searchParams.get("symbol")?.trim().toUpperCase();

  try {
    if (!symbol) {
      const snapshot = await buildRadarSnapshot();
      const symbols = snapshot.tokens.map((t) => t.symbol);

      const [status, news, earnings] = await Promise.all([
        fetchMarketStatus(),
        fetchMarketNews(),
        fetchEarningsForTokens(symbols),
      ]);

      return NextResponse.json({
        marketStatus: status,
        earnings: earnings.slice(0, 25),
        news: news.slice(0, 20),
        tokenisedSymbols: symbols.length,
        generatedAt: new Date().toISOString(),
      });
    }

    const snapshot = await buildRadarSnapshot();
    const token = snapshot.tokens.find((t) => t.symbol.toUpperCase() === symbol);

    const [quote, profile, news, recommendations, peers, status, premium] = await Promise.all([
      fetchStockQuote(symbol),
      fetchCompanyProfile(symbol),
      fetchCompanyNews(symbol),
      fetchRecommendations(symbol),
      fetchPeers(symbol),
      fetchMarketStatus(),
      token ? readPremium(symbol, token.address) : Promise.resolve(null),
    ]);

    if (!quote && !profile && !token) {
      return NextResponse.json({ error: `No data for ${symbol}.` }, { status: 404 });
    }

    return NextResponse.json({
      symbol,
      quote,
      profile,
      recommendations: recommendations.slice(0, 4),
      peers: peers.slice(0, 8),
      news: news.slice(0, 10),
      marketStatus: status,
      onChain: token
        ? {
            address: token.address,
            multiplier: token.multiplier,
            holders: token.holders,
            severity: token.severity,
            premium,
          }
        : null,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[veltr] stocks failed:", error);
    return NextResponse.json({ error: "Equity data unavailable." }, { status: 502 });
  }
}
