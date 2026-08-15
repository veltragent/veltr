import { NextResponse } from "next/server";
import { buildRadarSnapshot } from "@/lib/tokens";
import { fetchCorporateActions, summariseActions } from "@/lib/events";

/**
 * Served through a function, cached at the edge for the same window.
 *
 * `export const revalidate` prerendered this route as a static file, and the
 * Vercel build then failed assembling the output with "Unable to find lambda for
 * route: /api/history". The Cache-Control header this route already sets gives the same caching
 * behaviour — one origin hit per window — without the
 * route needing to be a static asset.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const snapshot = await buildRadarSnapshot();
    const actions = await fetchCorporateActions(
      snapshot.tokens.map((t) => ({ address: t.address, symbol: t.symbol }))
    );

    return NextResponse.json(
      { actions, stats: summariseActions(actions), generatedAt: new Date().toISOString() },
      { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=900" } }
    );
  } catch (error) {
    console.error("[veltr] history failed:", error);
    return NextResponse.json({ error: "Unable to read corporate action history." }, { status: 502 });
  }
}
