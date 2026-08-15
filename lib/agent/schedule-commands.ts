import { addSchedule, listSchedules, removeSchedule } from "./schedule-engine";
import { DEFAULT_INTERVAL_SEC, MIN_INTERVAL_SEC } from "./schedule";

/**
 * Telegram surface for recurring missions.
 *
 * Returns rendered replies rather than sending them, matching every other
 * feature so the transport keeps one delivery path.
 */

export type ScheduleReply = { text: string };

const USAGE = [
  "Run a mission on a schedule and hear from me only when the figures move.",
  "",
  "/every 1h investigate why the NVDA premium is where it is",
  "/every 30m check whether any announced split hits a token here",
  "",
  "/schedules        what you have running",
  "/unschedule 1     stop one",
  "",
  "Each run is a full mission, so the floor is 15 minutes. Observation only —",
  "a scheduled run never acts.",
].join("\n");

/** Reads 30m, 2h, or a bare number meaning minutes. */
export function parseInterval(raw: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*([mh])?$/i.exec(raw.trim());
  if (!match) return null;

  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;

  const unit = (match[2] ?? "m").toLowerCase();
  return Math.round(value * (unit === "h" ? 3600 : 60));
}

/** "90m" reads better as "1.5h" once it is over an hour. */
function humanInterval(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = minutes / 60;
  return `${hours % 1 === 0 ? hours : hours.toFixed(1)}h`;
}

export async function handleEvery(ownerId: string, argument: string): Promise<ScheduleReply> {
  const parts = argument.trim().split(/\s+/).filter(Boolean);

  // The first word is an interval only if it parses as one; otherwise the whole
  // argument is the objective and the default cadence applies.
  const leading = parts.length > 1 ? parseInterval(parts[0]) : null;
  const objective = leading === null ? argument.trim() : parts.slice(1).join(" ");

  if (!objective) return { text: USAGE };

  const requested = leading ?? DEFAULT_INTERVAL_SEC;
  const added = await addSchedule(ownerId, objective, requested);
  if (!added.ok) return { text: added.error };

  const floored = leading !== null && leading < MIN_INTERVAL_SEC;

  return {
    text: [
      `⏱ Scheduled every ${humanInterval(added.schedule.intervalSec)}`,
      "",
      added.schedule.objective,
      "",
      floored
        ? `You asked for less. The floor is ${MIN_INTERVAL_SEC / 60} minutes, because each run is a full mission — several model calls and many tool calls.`
        : "",
      "The first run establishes a baseline and tells you nothing. After that you hear from me only when the figures it observes actually move.",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

export async function handleSchedules(ownerId: string): Promise<ScheduleReply> {
  const all = await listSchedules(ownerId);
  if (all.length === 0) return { text: USAGE };

  const rows = all.map((schedule, i) => {
    const state = !schedule.enabled
      ? "paused after repeated failures"
      : schedule.lastChangedAt
        ? `last change ${schedule.lastChangedAt.slice(0, 16).replace("T", " ")}`
        : schedule.lastRunAt
          ? "no change since it started"
          : "not yet run";

    return [
      `${i + 1}. ${schedule.objective.slice(0, 70)}`,
      `   every ${humanInterval(schedule.intervalSec)} · ${state}`,
    ].join("\n");
  });

  return {
    text: [
      `⏱ Scheduled missions (${all.length})`,
      "",
      rows.join("\n\n"),
      "",
      "/unschedule <number> to stop one",
    ].join("\n"),
  };
}

export async function handleUnschedule(ownerId: string, argument: string): Promise<ScheduleReply> {
  const index = Number(argument.trim());
  if (!Number.isInteger(index) || index < 1) {
    return { text: "Which one? Send /schedules for the list, then /unschedule 1" };
  }

  const removed = await removeSchedule(ownerId, index - 1);
  if (!removed) return { text: "No schedule with that number. Send /schedules." };

  return { text: `Stopped: ${removed.objective.slice(0, 80)}` };
}
