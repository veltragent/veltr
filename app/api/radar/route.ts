import { NextResponse } from "next/server";
import { buildRadarSnapshot } from "@/lib/tokens";
import { publicClient } from "@/lib/chain";

/** Multiplier updates are scheduled, not adversarial — a 60s window is ample. */
export const revalidate = 60;

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
