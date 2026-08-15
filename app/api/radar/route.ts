import { NextResponse } from "next/server";
import { buildRadarSnapshot } from "@/lib/tokens";
import { publicClient } from "@/lib/chain";

/** Multiplier updates are scheduled, not adversarial — a 60s window is ample. */
/**
 * Served through a function, cached at the edge for the same window.
 *
 * `export const revalidate` prerendered this route as a static file, and the
 * Vercel build then failed assembling the output with "Unable to find lambda for
 * route: /api/radar". The Cache-Control header this route already sets gives the same caching
 * behaviour — one origin hit per window — without the
 * route needing to be a static asset.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [snapshot, blockNumber] = await Promise.all([
      buildRadarSnapshot(),
      publicClient.getBlockNumber().catch(() => null),
    ]);

    return NextResponse.json(
      { ...snapshot, blockNumber: blockNumber?.toString() ?? null },
      { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" } }
    );
  } catch (error) {
    console.error("[veltr] radar snapshot failed:", error);
    return NextResponse.json(
      { error: "Unable to reach Robinhood Chain. The public RPC is rate-limited; set VELTR_RPC_URL." },
      { status: 502 }
    );
  }
}
