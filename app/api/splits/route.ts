import { NextResponse } from "next/server";
import { buildRadarSnapshot } from "@/lib/tokens";
import { fetchAnnouncedSplits, matchSplitsToTokens } from "@/lib/splits-calendar";

/**
 * Served through a function, cached at the edge for the same window.
 *
 * `export const revalidate` prerendered this route as a static file, and the
 * Vercel build then failed assembling the output with "Unable to find lambda for
 * route: /api/splits". The Cache-Control header this route already sets gives the same caching
 * behaviour — one origin hit per window — without the
 * route needing to be a static asset.
 */
export const dynamic = "force-dynamic";

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
