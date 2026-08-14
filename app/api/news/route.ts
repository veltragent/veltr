import { NextResponse } from "next/server";
import { buildRadarSnapshot } from "@/lib/tokens";
import { fetchTickerNews, fetchFilings, fetchMarketHeadlines } from "@/lib/news";

export const revalidate = 600;

/**
 * News. With `symbol`, returns company-scoped articles and SEC filings; without
 * it, the macro headlines.
 */
export async function GET(request: Request) {
  const symbol = new URL(request.url).searchParams.get("symbol")?.trim().toUpperCase();

  try {
    if (!symbol) {
      const headlines = await fetchMarketHeadlines();
      return NextResponse.json({ scope: "market", articles: headlines, count: headlines.length });
    }

    const snapshot = await buildRadarSnapshot().catch(() => null);
    const token = snapshot?.tokens.find((t) => t.symbol.toUpperCase() === symbol);

    const [articles, filings] = await Promise.all([
      fetchTickerNews(symbol, token?.name),
      fetchFilings(symbol),
    ]);

    return NextResponse.json({
      scope: "company",
      symbol,
      companyName: token?.name ?? null,
      articles,
      filings,
      count: articles.length,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[veltr] news failed:", error);
    return NextResponse.json({ error: "News unavailable." }, { status: 502 });
  }
}
