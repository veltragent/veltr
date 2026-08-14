import { NextResponse } from "next/server";
import { buildRadarSnapshot } from "@/lib/tokens";
import { publicClient } from "@/lib/chain";
import { runDailyBrief } from "@/lib/agent";
import { readState, writeState } from "@/lib/store";
import { sendTelegram } from "@/lib/notify";
import { allowedRecipients } from "@/lib/owner";

export const dynamic = "force-dynamic";

function authorised(request: Request): boolean {
  const secret = process.env.VELTR_CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== "production";
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

/**
 * Generates and broadcasts the daily brief.
 *
 * Guarded by a once-per-day check keyed on UTC date: the deep tier costs real
 * money per call, and a misconfigured cron firing hourly would otherwise run up
 * the bill twenty-four times over. `?force=1` overrides for testing.
 */
export async function POST(request: Request) {
  if (!authorised(request)) {
    return NextResponse.json({ error: "Unauthorised." }, { status: 401 });
  }

  const force = new URL(request.url).searchParams.get("force") === "1";
  const state = await readState();
  const today = new Date().toISOString().slice(0, 10);

  if (!force && state.lastBriefSentOn === today) {
    return NextResponse.json({
      skipped: `Brief already sent for ${today}. Pass ?force=1 to override.`,
      subscribers: state.subscriptions.length,
    });
  }

  try {
    const [snapshot, blockNumber] = await Promise.all([
      buildRadarSnapshot(),
      publicClient.getBlockNumber().catch(() => null),
    ]);

    const { brief, source } = await runDailyBrief({
      ...snapshot,
      blockNumber: blockNumber?.toString() ?? null,
    });

    const header = `Veltr daily brief — ${today}\n\n`;
    let sent = 0;
    let failed = 0;

    // The brief is the largest push the bot makes. When an owner is configured
    // it goes to them alone.
    const recipients = await allowedRecipients(state.subscriptions.map((s) => s.destination));

    for (const destination of recipients) {
      const ok = await sendTelegram(destination, header + brief);
      if (ok) sent++;
      else failed++;
    }

    await writeState({ ...(await readState()), lastBriefSentOn: today });

    return NextResponse.json({
      day: today,
      source,
      subscribers: state.subscriptions.length,
      recipients: recipients.length,
      sent,
      failed,
      brief,
    });
  } catch (error) {
    console.error("[veltr] brief failed:", error);
    return NextResponse.json({ error: "Brief generation failed." }, { status: 502 });
  }
}
