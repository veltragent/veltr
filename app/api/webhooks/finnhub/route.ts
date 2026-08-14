import { NextResponse } from "next/server";
import { readState, writeState } from "@/lib/store";
import { dispatchPending } from "@/lib/notify";

export const dynamic = "force-dynamic";

/**
 * Finnhub push endpoint.
 *
 * Finnhub delivers earnings releases and news as they happen rather than making
 * us poll for them. That matters here: an earnings release moves a stock token
 * immediately, and polling a 60-calls-per-minute budget across 95 symbols would
 * either miss it or exhaust the quota.
 *
 * Requires a publicly reachable URL, so this stays dormant on localhost and
 * begins receiving the moment the app is deployed and the URL is registered in
 * the Finnhub dashboard.
 */

type FinnhubEvent = {
  event?: string;
  symbol?: string;
  data?: unknown;
  // Earnings payloads
  epsActual?: number;
  epsEstimate?: number;
  revenueActual?: number;
  revenueEstimate?: number;
  quarter?: number;
  year?: number;
};

function authorised(request: Request): boolean {
  const expected = process.env.FINNHUB_WEBHOOK_SECRET;
  if (!expected) return false;
  return request.headers.get("x-finnhub-secret") === expected;
}

export async function POST(request: Request) {
  if (!authorised(request)) {
    // Finnhub treats any non-2xx as a delivery failure and retries, so an
    // unauthorised caller gets a clear rejection rather than a silent accept.
    return NextResponse.json({ error: "Invalid webhook secret." }, { status: 401 });
  }

  let payload: FinnhubEvent;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed payload." }, { status: 400 });
  }

  const symbol = payload.symbol?.toUpperCase();
  if (!symbol) {
    // Acknowledge anything unrecognised: retrying it would not help.
    return NextResponse.json({ received: true, ignored: "no symbol" });
  }

  try {
    const state = await readState();

    // Only relevant if the ticker actually exists as a token on this chain.
    const tracked = Object.keys(state.lastMultiplier).length > 0;
    const isTokenised = state.changes.some((c) => c.symbol.toUpperCase() === symbol) || tracked;

    if (!isTokenised) {
      return NextResponse.json({ received: true, ignored: "symbol not tokenised" });
    }

    const surprise =
      payload.epsActual !== undefined && payload.epsEstimate
        ? ((payload.epsActual - payload.epsEstimate) / Math.abs(payload.epsEstimate)) * 100
        : null;

    const lines = [
      `Earnings released — ${symbol}`,
      "",
      payload.epsActual !== undefined
        ? `EPS ${payload.epsActual} vs ${payload.epsEstimate ?? "?"} estimate${
            surprise !== null ? ` (${surprise >= 0 ? "+" : "−"}${Math.abs(surprise).toFixed(1)}% surprise)` : ""
          }`
        : "Details pending.",
      "",
      "The token tracks this price. Liquidity positions and collateral sized against it move now.",
    ];

    await writeState({
      ...state,
      changes: [
        {
          id: `finnhub-${symbol}-${Date.now()}`,
          detectedAt: new Date().toISOString(),
          token: "0x0000000000000000000000000000000000000000",
          symbol,
          kind: "action-scheduled",
          from: 0,
          to: 0,
          deltaPct: 0,
          effectiveAt: null,
          notified: false,
        },
        ...state.changes,
      ],
    });

    const delivery = await dispatchPending();

    return NextResponse.json({ received: true, symbol, delivered: delivery.sent, preview: lines.join("\n") });
  } catch (error) {
    console.error("[veltr] finnhub webhook failed:", error);
    // 500 tells Finnhub to retry, which is correct for a transient failure.
    return NextResponse.json({ error: "Processing failed." }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({
    configured: Boolean(process.env.FINNHUB_WEBHOOK_SECRET),
    note: "Register this URL in the Finnhub dashboard once the app has a public address.",
  });
}
