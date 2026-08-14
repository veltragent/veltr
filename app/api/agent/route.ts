import { NextResponse } from "next/server";
import { buildRadarSnapshot } from "@/lib/tokens";
import { publicClient } from "@/lib/chain";
import { deterministicBriefing } from "@/lib/agent";
import { runAgentLoop } from "@/lib/agent-loop";
import { callerKey, checkLimit, budgetStatus } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let question = "";
  try {
    ({ question } = await request.json());
  } catch {
    return NextResponse.json({ error: "Malformed request body." }, { status: 400 });
  }

  if (typeof question !== "string" || !question.trim()) {
    return NextResponse.json({ error: "A question is required." }, { status: 400 });
  }
  if (question.length > 1000) {
    return NextResponse.json({ error: "Question exceeds 1000 characters." }, { status: 400 });
  }

  const verdict = checkLimit(callerKey(request));

  try {
    const [snapshot, blockNumber] = await Promise.all([
      buildRadarSnapshot(),
      publicClient.getBlockNumber().catch(() => null),
    ]);
    const withBlock = { ...snapshot, blockNumber: blockNumber?.toString() ?? null };

    // Over the limit the endpoint still answers — from chain state, at no cost.
    if (!verdict.allowed) {
      return NextResponse.json(
        {
          answer: deterministicBriefing(withBlock),
          source: "deterministic",
          grounded: true,
          throttled: verdict.reason,
          blockNumber: withBlock.blockNumber,
        },
        { status: 200, headers: { "Retry-After": String(verdict.retryAfterSeconds) } }
      );
    }

    // Same answering path as the Telegram bot, so the website panel and the bot
    // draw on identical evidence — prices, premiums and news included, not just
    // the chain snapshot.
    const result = await runAgentLoop(question);

    return NextResponse.json({
      answer: result.answer,
      source: result.source,
      grounded: true,
      toolsUsed: result.toolsUsed,
      actions: result.actions,
      rounds: result.rounds,
      blockNumber: withBlock.blockNumber,
      remaining: verdict.remaining,
    });
  } catch (error) {
    console.error("[veltr] agent failed:", error);
    return NextResponse.json({ error: "Agent unavailable — chain read failed." }, { status: 502 });
  }
}

/** Budget visibility, so throttling is observable rather than mysterious. */
export async function GET() {
  return NextResponse.json({ budget: budgetStatus() });
}
