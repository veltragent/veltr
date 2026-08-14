import { mutateState, readState } from "../store";
import { LIMITS } from "./budget";
import { isTerminal, type Mission } from "./types";

/**
 * Mission persistence.
 *
 * A mission waiting for approval must survive a restart — the answer can arrive
 * hours later and in a different process — so missions live in the same atomic
 * document as the rest of the agent's state, behind the same write queue.
 *
 * Every function here is scoped by owner. There is no call that returns another
 * user's mission, which is the enforcement point for a mission being able to act
 * only on behalf of whoever started it.
 */

/**
 * Bounds one stored mission.
 *
 * The ledger is already capped while running, but a completed mission is kept
 * only as a record: the evidence that mattered is cited in the result, and the
 * full transcript would grow this file without bound for no reader.
 */
function compact(mission: Mission): Mission {
  if (!isTerminal(mission.state)) return mission;

  const cited = new Set(mission.result?.evidenceIds ?? []);
  const kept = mission.evidence.filter((e) => cited.has(e.id)).slice(-8);

  return {
    ...mission,
    evidence: kept,
    // The last decision is the one that produced the result; the rest are the
    // path taken to it and are not evidence of anything.
    decisions: mission.decisions.slice(-1),
    steps: mission.steps.slice(-12),
  };
}

export async function saveMission(mission: Mission): Promise<Mission> {
  const stored = compact(mission);

  return mutateState((state) => {
    const missions = state.missions ?? [];
    const existing = missions.findIndex((m) => m.id === stored.id);

    const next =
      existing >= 0
        ? missions.map((m) => (m.id === stored.id ? stored : m))
        : [...missions, stored];

    // Trim per owner rather than globally, so a busy user cannot evict another
    // user's mission from the record.
    const byOwner = new Map<string, Mission[]>();
    for (const mission of next) {
      const list = byOwner.get(mission.ownerId) ?? [];
      list.push(mission);
      byOwner.set(mission.ownerId, list);
    }

    const trimmed: Mission[] = [];
    for (const list of byOwner.values()) {
      const sorted = [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      // Unfinished missions are never evicted: one of them may be waiting for an
      // answer, and dropping it would strand the person who was asked.
      const live = sorted.filter((m) => !isTerminal(m.state));
      const done = sorted.filter((m) => isTerminal(m.state));
      const keepDone = done.slice(-Math.max(0, LIMITS.maxMissionsPerOwner - live.length));
      trimmed.push(...live, ...keepDone);
    }

    return {
      state: { ...state, missions: trimmed },
      result: stored,
    };
  });
}

export async function getMission(ownerId: string, missionId: string): Promise<Mission | null> {
  const state = await readState();
  return (state.missions ?? []).find((m) => m.id === missionId && m.ownerId === ownerId) ?? null;
}

export async function listMissions(ownerId: string): Promise<Mission[]> {
  const state = await readState();
  return (state.missions ?? [])
    .filter((m) => m.ownerId === ownerId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Missions still awaiting an answer, for the owner's prompt list. */
export async function pendingApprovals(ownerId: string): Promise<Mission[]> {
  const missions = await listMissions(ownerId);
  return missions.filter((m) => m.state === "waiting_permission" && m.pendingAction !== null);
}

export async function removeMission(ownerId: string, missionId: string): Promise<boolean> {
  return mutateState((state) => {
    const missions = state.missions ?? [];
    const kept = missions.filter((m) => !(m.id === missionId && m.ownerId === ownerId));
    return { state: { ...state, missions: kept }, result: kept.length < missions.length };
  });
}

/** Drops every mission belonging to one owner — used by /stop. */
export async function removeAllMissions(ownerId: string): Promise<number> {
  return mutateState((state) => {
    const missions = state.missions ?? [];
    const kept = missions.filter((m) => m.ownerId !== ownerId);
    return { state: { ...state, missions: kept }, result: missions.length - kept.length };
  });
}
