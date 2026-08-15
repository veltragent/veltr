import { randomUUID } from "node:crypto";
import { mutateState, readState } from "../store";
import { startMission } from "./run";
import { renderResult } from "./format";
import {
  compareRun,
  isDue,
  DEFAULT_INTERVAL_SEC,
  MAX_FAILURES,
  MAX_SCHEDULES_PER_USER,
  MIN_INTERVAL_SEC,
  type Schedule,
} from "./schedule";
import type { Mission } from "./types";
import { announceOnce, spendAllows } from "../spend";

/**
 * The recurring-mission runner.
 *
 * One centralised cycle, like every other monitor here: adding a schedule starts
 * no timer, and a restart resumes from disk.
 *
 * A schedule costs far more than a tracked page — each run is a full mission,
 * several model calls and many tool calls — so it is deliberately harder to run
 * often and deliberately quiet. Silence is the expected output.
 */

/* ------------------------------------------------------------ Storage */

export async function listSchedules(ownerId: string): Promise<Schedule[]> {
  const state = await readState();
  return (state.schedules ?? [])
    .filter((s) => s.ownerId === ownerId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function listAllSchedules(): Promise<Schedule[]> {
  return (await readState()).schedules ?? [];
}

export type AddResult = { ok: true; schedule: Schedule } | { ok: false; error: string };

export async function addSchedule(
  ownerId: string,
  objective: string,
  intervalSec = DEFAULT_INTERVAL_SEC
): Promise<AddResult> {
  const trimmed = objective.trim();
  if (trimmed.length < 6) {
    return { ok: false, error: "Give me an objective to run — a sentence, not a command." };
  }

  const interval = Math.max(MIN_INTERVAL_SEC, Math.round(intervalSec));

  return mutateState<AddResult>((state) => {
    const schedules = state.schedules ?? [];
    const mine = schedules.filter((s) => s.ownerId === ownerId);

    if (mine.some((s) => s.objective.toLowerCase() === trimmed.toLowerCase())) {
      return { state, result: { ok: false, error: "You already have that on a schedule." } };
    }
    if (mine.length >= MAX_SCHEDULES_PER_USER) {
      return {
        state,
        result: {
          ok: false,
          // Each one is a full mission on a timer; this ceiling is a spending limit.
          error: `You already have ${MAX_SCHEDULES_PER_USER} schedules. Remove one first — each is a full mission every cycle.`,
        },
      };
    }

    const schedule: Schedule = {
      id: randomUUID(),
      ownerId,
      objective: trimmed,
      intervalSec: interval,
      fingerprint: null,
      lastFigures: {},
      lastSummary: null,
      lastRunAt: null,
      lastChangedAt: null,
      failures: 0,
      enabled: true,
      createdAt: new Date().toISOString(),
    };

    return { state: { ...state, schedules: [...schedules, schedule] }, result: { ok: true, schedule } };
  });
}

export async function removeSchedule(ownerId: string, index: number): Promise<Schedule | null> {
  return mutateState<Schedule | null>((state) => {
    const schedules = state.schedules ?? [];
    const mine = schedules.filter((s) => s.ownerId === ownerId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const target = mine[index];
    if (!target) return { state, result: null };
    return { state: { ...state, schedules: schedules.filter((s) => s.id !== target.id) }, result: target };
  });
}

export async function removeAllSchedules(ownerId: string): Promise<number> {
  return mutateState((state) => {
    const schedules = state.schedules ?? [];
    const kept = schedules.filter((s) => s.ownerId !== ownerId);
    return { state: { ...state, schedules: kept }, result: schedules.length - kept.length };
  });
}

async function persist(updated: Schedule): Promise<void> {
  await mutateState((state) => ({
    state: {
      ...state,
      schedules: (state.schedules ?? []).map((s) => (s.id === updated.id ? updated : s)),
    },
    result: undefined,
  }));
}

/* -------------------------------------------------------------- Cycle */

export type ScheduleDeps = {
  loadSchedules: () => Promise<Schedule[]>;
  runMission: (ownerId: string, objective: string) => Promise<Mission | null>;
  save: (schedule: Schedule) => Promise<void>;
  send: (ownerId: string, text: string) => Promise<boolean>;
  now: () => Date;
};

export type ScheduleReport = {
  ranAt: string;
  due: number;
  ran: number;
  changed: number;
  sent: number;
  failed: number;
  paused: number;
  /** Due runs held back because the daily model ceiling was reached. */
  skippedForSpend: number;
};

async function defaultDeps(): Promise<ScheduleDeps> {
  return {
    loadSchedules: listAllSchedules,
    runMission: async (ownerId, objective) => {
      // read_only: a scheduled run happens while nobody is watching, so it may
      // observe and reason but never act. An action nobody asked for at three in
      // the morning is not autonomy, it is a surprise.
      const result = await startMission({ ownerId, objective, permissionMode: "read_only" });
      return result.ok ? result.mission : null;
    },
    save: persist,
    send: async (ownerId, text) => {
      const { mayPush } = await import("../owner");
      if (!(await mayPush(ownerId))) return false;
      const { sendTelegram } = await import("../notify");
      return sendTelegram(ownerId, text);
    },
    now: () => new Date(),
  };
}

function renderChange(schedule: Schedule, mission: Mission): string {
  return [
    "🔔 SCHEDULED MISSION — something moved",
    "",
    schedule.objective,
    "",
    renderResult(mission).replace(/^✓ COMPLETED\n\n/, "").replace(/^Objective:.*\n\n/m, ""),
    "",
    schedule.lastChangedAt
      ? `Previous change: ${schedule.lastChangedAt.slice(0, 16).replace("T", " ")}`
      : "First change since you scheduled this.",
    `Checked every ${Math.round(schedule.intervalSec / 60)} minutes. Silent unless the figures move.`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/**
 * One pass.
 *
 * Runs at most one mission per cycle. They are expensive and slow, and a tick
 * that fires five at once would queue five model conversations behind each other
 * while the rest of the scheduler waits.
 */
export async function runScheduleCycle(overrides: Partial<ScheduleDeps> = {}): Promise<ScheduleReport> {
  const deps: ScheduleDeps = { ...(await defaultDeps()), ...overrides };
  const now = deps.now();
  const report: ScheduleReport = { ranAt: now.toISOString(), due: 0, ran: 0, changed: 0, sent: 0, failed: 0, paused: 0, skippedForSpend: 0 };

  const schedules = await deps.loadSchedules();
  const due = schedules.filter((s) => isDue(s, now));
  report.due = due.length;
  if (due.length === 0) return report;

  // Work nobody is waiting for yields first. Checked before the run rather than
  // inside it, so a mission is never abandoned half-finished — the schedule
  // simply does not come due again until the day rolls over.
  const verdict = await spendAllows("autonomous", now);
  if (!verdict.allowed) {
    report.skippedForSpend = report.due;
    console.log(`[veltr][SCHEDULE] ${report.due} due but held — ${verdict.tokens} tokens spent today`);
    void announceOnce(
      "soft",
      [
        "⏸ Scheduled missions are paused for today.",
        "",
        `Model usage has reached ${verdict.tokens.toLocaleString()} tokens, the point where work that runs on a timer stops so that answers you ask for keep working.`,
        "",
        "They resume at midnight UTC. /spend for the detail.",
      ].join("\n"),
      now
    ).catch(() => {});
    return report;
  }

  // Oldest check first, so a busy account cycles fairly rather than starving one.
  const schedule = [...due].sort((a, b) => (a.lastRunAt ?? "").localeCompare(b.lastRunAt ?? ""))[0];

  console.log(`[veltr][SCHEDULE] running "${schedule.objective.slice(0, 60)}" for ${schedule.ownerId}`);
  const mission = await deps.runMission(schedule.ownerId, schedule.objective);
  report.ran = 1;

  if (!mission) {
    const failures = schedule.failures + 1;
    const paused = failures >= MAX_FAILURES;
    if (paused) report.paused = 1;
    report.failed = 1;
    await deps.save({ ...schedule, failures, enabled: !paused, lastRunAt: now.toISOString() });
    return report;
  }

  const comparison = compareRun(schedule, mission);

  const next: Schedule = {
    ...schedule,
    lastRunAt: now.toISOString(),
    // A run that observed nothing leaves the baseline alone, so the next real
    // reading is compared against the last real one rather than against nothing.
    ...(comparison.reason === "no-evidence"
      ? { failures: schedule.failures + 1 }
      : {
          failures: 0,
          fingerprint: comparison.fingerprint,
          lastFigures: comparison.figures,
          lastSummary: mission.result?.summary ?? schedule.lastSummary,
        }),
  };

  if (comparison.reason === "no-evidence" && next.failures >= MAX_FAILURES) {
    next.enabled = false;
    report.paused = 1;
  }

  if (!comparison.changed) {
    await deps.save(next);
    console.log(`[veltr][SCHEDULE] no report — ${comparison.reason}`);
    return report;
  }

  report.changed = 1;
  next.lastChangedAt = now.toISOString();
  await deps.save(next);

  if (await deps.send(schedule.ownerId, renderChange(schedule, mission))) {
    report.sent = 1;
  }
  console.log(`[veltr][SCHEDULE] reported a change (${comparison.reason})`);

  return report;
}

export async function runScheduleCycleSafely(): Promise<ScheduleReport | null> {
  try {
    return await runScheduleCycle();
  } catch (error) {
    console.error("[veltr][SCHEDULE] cycle failed:", error instanceof Error ? error.message : error);
    return null;
  }
}
