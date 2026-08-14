import { NextResponse } from "next/server";
import { runWatch } from "@/lib/watcher";
import { readState } from "@/lib/store";
import { dispatchPending } from "@/lib/notify";

export const dynamic = "force-dynamic";

/**
 * Authorises the watcher trigger.
 *
 * When VELTR_CRON_SECRET is unset the endpoint stays open so local development
 * works out of the box — but it must be set before deployment, or anyone can
 * drive the poller.
 */
function authorised(request: Request): boolean {
  const secret = process.env.VELTR_CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== "production";
  const header = request.headers.get("authorization");
  return header === `Bearer ${secret}`;
}

/** Current watcher state — what it last saw and what it has flagged. */
export async function GET() {
  const state = await readState();
  return NextResponse.json({
    lastRunAt: state.lastRunAt,
    lastBlock: state.lastBlock,
    tokensTracked: Object.keys(state.lastMultiplier).length,
    pendingActions: Object.values(state.lastPending).filter((v) => v !== null).length,
    subscriptions: state.subscriptions.length,
    changes: state.changes.slice(0, 50),
  });
}

/** Runs one watcher pass, then delivers anything it found. */
export async function POST(request: Request) {
  if (!authorised(request)) {
    return NextResponse.json({ error: "Unauthorised." }, { status: 401 });
  }

  try {
    const result = await runWatch();
    const delivery = await dispatchPending();

    return NextResponse.json({
      ...result,
      delivery,
      note: result.firstRun
        ? "Baseline established. Changes are reported from the next pass onward."
        : undefined,
    });
  } catch (error) {
    console.error("[veltr] watch failed:", error);
    return NextResponse.json({ error: "Watcher pass failed." }, { status: 502 });
  }
}
