import { NextResponse } from "next/server";
import { buildRadarSnapshot } from "@/lib/tokens";
import { fetchGlobalMarket, fetchChainPools, readPremium, isUsMarketOpen } from "@/lib/market";

export const revalidate = 60;

/**
 * Market overview: global crypto, chain-wide DEX activity, and the premium each
 * tokenised stock trades at against its underlying equity.
 *
 * The premium set is capped to the most-held tokens — each entry costs one
 * DexScreener call and one Yahoo call, and every source here is unauthenticated
 * and worth being polite to.
 */
export async function GET(request: Request) {
  const limit = Math.min(Number(new URL(request.url).searchParams.get("limit") ?? 12), 30);

  try {
    const [snapshot, global, pools] = await Promise.all([
      buildRadarSnapshot(),
      fetchGlobalMarket(),
      fetchChainPools(),
    ]);

    const subjects = [...snapshot.tokens].sort((a, b) => b.holders - a.holders).slice(0, limit);

    const premiums = await Promise.all(
      subjects.map(async (t) => {
        const reading = await readPremium(t.symbol, t.address);
        return {
          ...reading,
          address: t.address,
          name: t.name,
          iconUrl: t.iconUrl,
          holders: t.holders,
          multiplier: t.multiplier,
        };
      })
    );

    const priced = premiums.filter((p) => p.premiumPct !== null);
    const widest = [...priced].sort(
      (a, b) => Math.abs(b.premiumPct!) - Math.abs(a.premiumPct!)
    )[0];

    return NextResponse.json(
      {
        marketOpen: isUsMarketOpen(),
        global,
        pools,
        premiums,
        stats: {
          priced: priced.length,
          medianAbsPremium: median(priced.map((p) => Math.abs(p.premiumPct!))),
          widestSymbol: widest?.symbol ?? null,
          widestPremium: widest?.premiumPct ?? null,
          chainLiquidityUsd: pools.reduce((s, p) => s + p.liquidityUsd, 0),
          chainVolume24hUsd: pools.reduce((s, p) => s + p.volume24hUsd, 0),
        },
        generatedAt: new Date().toISOString(),
      },
      { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=180" } }
    );
  } catch (error) {
    console.error("[veltr] market failed:", error);
    return NextResponse.json({ error: "Market data unavailable." }, { status: 502 });
  }
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
