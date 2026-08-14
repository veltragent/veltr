import { NextResponse } from "next/server";
import { buildRadarSnapshot } from "@/lib/tokens";
import { fetchCorporateActions, summariseActions } from "@/lib/events";

export const revalidate = 300;

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
