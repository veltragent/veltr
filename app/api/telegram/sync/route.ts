import { NextResponse } from "next/server";
import { readState } from "@/lib/store";
import { syncTelegram } from "@/lib/telegram";

export const dynamic = "force-dynamic";

/**
 * Cross-origin access for a split deployment.
 *
 * When the website is served from one host and this route from another, the
 * browser will not call it without these. An explicit allowlist rather than `*`:
 * the POST drains Telegram updates, so any page that can call it can interfere
 * with the bot.
 *
 * Unset, no CORS headers are sent at all and the route is same-origin only —
 * which is what a single-host deployment wants.
 */
function corsHeaders(request: Request): Record<string, string> {
  const allowed = (process.env.VELTR_ALLOWED_ORIGIN ?? "")
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean);

  const origin = request.headers.get("origin")?.replace(/\/+$/, "") ?? "";
  if (!origin || !allowed.includes(origin)) return {};

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    // Origin varies per caller, so a cache must not serve one origin's headers
    // to another.
    Vary: "Origin",
  };
}

/** Preflight. Without it the browser never issues the POST. */
export async function OPTIONS(request: Request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * Manual drain of pending Telegram updates.
 *
 * The in-process scheduler normally long-polls continuously, so this endpoint
 * exists for environments where that loop is disabled and for the "Register me"
 * button on /alerts.
 */
export async function POST(request: Request) {
  const cors = corsHeaders(request);

  if (!process.env.VELTR_TELEGRAM_BOT_TOKEN) {
    return NextResponse.json({ error: "VELTR_TELEGRAM_BOT_TOKEN is not set." }, { status: 503, headers: cors });
  }

  try {
    return NextResponse.json(await syncTelegram(0), { headers: cors });
  } catch (error) {
    console.error("[veltr] telegram sync failed:", error);
    return NextResponse.json({ error: "Could not reach Telegram." }, { status: 502, headers: cors });
  }
}

export async function GET(request: Request) {
  const state = await readState();
  return NextResponse.json(
    {
      configured: Boolean(process.env.VELTR_TELEGRAM_BOT_TOKEN),
      subscribers: state.subscriptions.length,
      lastUpdateId: state.lastTelegramUpdateId,
      schedulerActive: process.env.VELTR_SCHEDULER !== "off",
    },
    { headers: corsHeaders(request) }
  );
}
