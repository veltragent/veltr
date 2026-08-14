import { isCancelled } from "../inflight";
import { advanceMission, answerPermission, cancelMission, createMission, defaultDeps } from "./mission";
import { getMission, listMissions, saveMission } from "./store";
import { canTransition, isTerminal, type Mission, type PermissionMode } from "./types";
import type { MissionDeps } from "./mission";

/**
 * Mission runner.
 *
 * The seam between the agent loop, which is pure orchestration, and the world,
 * which has a database and a user who closes their laptop. Persistence brackets
 * every pass: a record exists before any work starts and is updated the moment
 * the loop stops, so a mission is never lost between "started" and "finished".
 */

export type StartInput = {
  ownerId: string;
  objective: string;
  permissionMode?: PermissionMode;
  /** Telegram chat for tools that deliver something. */
  chatId?: string | null;
  onStatus?: (status: string) => void;
  /** Test seam. Production passes nothing and gets the live registry. */
  deps?: Partial<MissionDeps>;
};

const MIN_OBJECTIVE_CHARS = 6;

export type StartResult =
  | { ok: true; mission: Mission }
  | { ok: false; error: string };

export async function startMission(input: StartInput): Promise<StartResult> {
  const objective = input.objective.trim();
  if (objective.length < MIN_OBJECTIVE_CHARS) {
    return { ok: false, error: "Give me an objective — a sentence describing what you want to know or done." };
  }

  const mission = createMission({
    ownerId: input.ownerId,
    objective,
    permissionMode: input.permissionMode,
  });

  // Written before the first tool call, so a crash leaves a record rather than a
  // mission that ran and vanished.
  await saveMission(mission);

  console.log(`[veltr][AGENT] mission=${mission.id} owner=${input.ownerId} started`);

  const advanced = await runToPause(mission, input);
  return { ok: true, mission: advanced };
}

/** Answers a pending approval and continues, or completes on a refusal. */
export async function respondToApproval(
  ownerId: string,
  missionId: string,
  approved: boolean,
  input: Omit<StartInput, "ownerId" | "objective"> = {}
): Promise<StartResult> {
  const mission = await getMission(ownerId, missionId);
  if (!mission) return { ok: false, error: "That mission does not exist." };
  if (mission.state !== "waiting_permission") {
    return { ok: false, error: "That mission is not waiting for approval." };
  }

  const answered = answerPermission(mission, approved);
  await saveMission(answered);

  console.log(
    `[veltr][AGENT] mission=${missionId} permission=${approved ? "approved" : "declined"} tool=${mission.pendingAction?.tool}`
  );

  if (isTerminal(answered.state)) return { ok: true, mission: answered };

  return { ok: true, mission: await runToPause(answered, { ...input, ownerId }) };
}

export async function abortMission(ownerId: string, missionId: string): Promise<StartResult> {
  const mission = await getMission(ownerId, missionId);
  if (!mission) return { ok: false, error: "That mission does not exist." };
  if (isTerminal(mission.state)) return { ok: false, error: "That mission has already finished." };

  const cancelled = cancelMission(mission);
  await saveMission(cancelled);
  return { ok: true, mission: cancelled };
}

/**
 * Runs the loop and persists wherever it stops.
 *
 * A throw is caught and recorded as a failed mission rather than propagated: the
 * caller is an HTTP handler or a Telegram loop, and neither should have to
 * decide what a half-finished mission means.
 */
async function runToPause(mission: Mission, input: Omit<StartInput, "objective">): Promise<Mission> {
  try {
    const deps = await defaultDeps(input.chatId ?? mission.ownerId);

    const { mission: advanced } = await advanceMission(mission, {
      ...deps,
      // Cancellation piggybacks on the existing per-chat inflight lock, so
      // /cancel abandons a mission the same way it abandons anything else.
      isCancelled: () => isCancelled(input.chatId ?? mission.ownerId),
      onStatus: input.onStatus ? (note) => input.onStatus?.(note) : undefined,
      ...input.deps,
    });

    await saveMission(advanced);
    console.log(
      `[veltr][AGENT] mission=${advanced.id} state=${advanced.state} iterations=${advanced.iterations} tools=${advanced.toolCalls}`
    );
    return advanced;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[veltr][AGENT] mission=${mission.id} failed:`, message);

    // Only record a failure the state machine actually permits; a mission that
    // finished cannot be retroactively failed by a late exception.
    const failed: Mission = canTransition(mission.state, "failed")
      ? {
          ...mission,
          state: "failed",
          error: message,
          updatedAt: new Date().toISOString(),
          steps: [...mission.steps, { at: new Date().toISOString(), state: "failed" as const, note: "Mission failed." }],
        }
      : mission;

    await saveMission(failed);
    return failed;
  }
}

/**
 * Fails missions that outlived their deadline without finishing.
 *
 * A process killed mid-mission leaves a record stuck in `running` that nothing
 * will ever advance. Reaping on read means the list a user sees is honest
 * without needing a background job to keep it that way.
 */
export async function reapStale(ownerId: string, now: Date = new Date()): Promise<Mission[]> {
  const missions = await listMissions(ownerId);

  for (const mission of missions) {
    if (isTerminal(mission.state)) continue;
    // A mission waiting for a human is not stale; it is waiting.
    if (mission.state === "waiting_permission") continue;
    if (now.getTime() < new Date(mission.deadlineAt).getTime()) continue;

    await saveMission({
      ...mission,
      state: "failed",
      error: "The mission did not finish before its deadline.",
      updatedAt: now.toISOString(),
      steps: [...mission.steps, { at: now.toISOString(), state: "failed", note: "Timed out." }],
    });
  }

  return listMissions(ownerId);
}
