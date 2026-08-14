import { NextResponse } from "next/server";
import { buildRadarSnapshot } from "@/lib/tokens";
import { fetchAnnouncedSplits, matchSplitsToTokens } from "@/lib/splits-calendar";

export const revalidate = 1800;

/**
 * Announced splits, and which of them land on a token that exists on this chain.
 *
 * `matched` is the actionable set: a dated warning weeks ahead of the on-chain
 * multiplier change, for every liquidity provider in that token's pools.
 */
export async function GET() {
  try {
    const [snapshot, splits] = await Promise.all([
      buildRadarSnapshot(),
      fetchAnnouncedSplits(),
    ]);

    const matched = matchSplitsToTokens(
      splits,
      snapshot.tokens.map((t) => ({ symbol: t.symbol, address: t.address }))
    );

    return NextResponse.json(
      {
        announced: splits.length,
        upcoming: splits.filter((s) => (s.daysUntil ?? -1) >= 0).length,
        matched,
        matchedCount: matched.length,
        tokensTracked: snapshot.tokens.length,
        source: "Nasdaq public splits calendar",
        generatedAt: new Date().toISOString(),
      },
      { headers: { "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=3600" } }
    );
  } catch (error) {
    console.error("[veltr] splits calendar failed:", error);
    return NextResponse.json({ error: "Unable to read the splits calendar." }, { status: 502 });
  }
}
