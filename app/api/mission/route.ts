import { NextResponse } from "next/server";
import { callerKey, checkLimit } from "@/lib/ratelimit";
import { abortMission, reapStale, respondToApproval, startMission } from "@/lib/agent/run";
import { getMission } from "@/lib/agent/store";
import type { Mission } from "@/lib/agent/types";

export const dynamic = "force-dynamic";

/**
 * Missions over HTTP.
 *
 * A mission spends real credit across several model calls and many tool calls,
 * so this endpoint is authorised rather than open — unlike /api/agent, which is
 * one bounded call and can afford to be public behind a rate limit. Both apply
 * here: the secret keeps the internet out, the limit keeps a holder of the secret
 * from looping.
 */
function authorised(request: Request): boolean {
  const secret = process.env.VELTR_CRON_SECRET;
  // Unset means open in development and CLOSED in production, matching
  // /api/watch — a deployment that forgets the secret exposes nothing.
  if (!secret) return process.env.NODE_ENV !== "production";
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

/**
 * Callers are their own owner namespace.
 *
 * Prefixed so an HTTP caller can never address a mission created from Telegram,
 * where the owner id is a chat id.
 */
function ownerFor(request: Request): string {
  return `api:${callerKey(request)}`;
}

/** The public shape. The evidence ledger and decisions stay internal. */
function present(mission: Mission) {
  return {
    id: mission.id,
    objective: mission.objective,
    state: mission.state,
    status: mission.steps[mission.steps.length - 1]?.note ?? null,
    iterations: mission.iterations,
    toolCalls: mission.toolCalls,
    observations: mission.evidence.length,
    pendingAction: mission.pendingAction
      ? { tool: mission.pendingAction.tool, risk: mission.pendingAction.risk, rationale: mission.pendingAction.rationale }
      : null,
    result: mission.result,
    error: mission.error,
    createdAt: mission.createdAt,
    updatedAt: mission.updatedAt,
  };
}

/** Missions for this caller, with anything stalled reaped first. */
export async function GET(request: Request) {
  if (!authorised(request)) return NextResponse.json({ error: "Unauthorised." }, { status: 401 });

  const owner = ownerFor(request);
  const url = new URL(request.url);
  const id = url.searchParams.get("id");

  if (id) {
    const mission = await getMission(owner, id);
    if (!mission) return NextResponse.json({ error: "Not found." }, { status: 404 });
    return NextResponse.json({ mission: present(mission) });
  }

  const missions = await reapStale(owner);
  return NextResponse.json({ missions: missions.map(present) });
}

type Body = {
  objective?: unknown;
  /** Answering an approval, or cancelling. */
  missionId?: unknown;
  action?: unknown;
  permissionMode?: unknown;
};

/**
 * Starts a mission, or answers one waiting for approval.
 *
 * `permissionMode` cannot be used to pre-authorise a high-risk action: the
 * permission rule refuses those in every mode, so the worst this field can do is
 * make reversible, caller-owned actions ask more often.
 */
export async function POST(request: Request) {
  if (!authorised(request)) return NextResponse.json({ error: "Unauthorised." }, { status: 401 });

  const verdict = checkLimit(callerKey(request));
  if (!verdict.allowed) {
    return NextResponse.json(
      { error: verdict.reason },
      { status: 429, headers: { "Retry-After": String(verdict.retryAfterSeconds) } }
    );
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }

  const owner = ownerFor(request);
  const action = typeof body.action === "string" ? body.action : null;
  const missionId = typeof body.missionId === "string" ? body.missionId : null;

  if (action && missionId) {
    if (action === "cancel") {
      const result = await abortMission(owner, missionId);
      return result.ok
        ? NextResponse.json({ mission: present(result.mission) })
        : NextResponse.json({ error: result.error }, { status: 400 });
    }

    if (action === "approve" || action === "decline") {
      const result = await respondToApproval(owner, missionId, action === "approve");
      return result.ok
        ? NextResponse.json({ mission: present(result.mission) })
        : NextResponse.json({ error: result.error }, { status: 400 });
    }

    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }

  const objective = typeof body.objective === "string" ? body.objective : "";
  const mode =
    body.permissionMode === "read_only" || body.permissionMode === "always_ask" ? body.permissionMode : undefined;

  const result = await startMission({ ownerId: owner, objective, permissionMode: mode });

  return result.ok
    ? NextResponse.json({ mission: present(result.mission) })
    : NextResponse.json({ error: result.error }, { status: 400 });
}
