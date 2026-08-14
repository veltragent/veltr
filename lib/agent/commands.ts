import { renderApprovalRequest, renderMissionList, renderResult, statusLine } from "./format";
import { getMission, listMissions } from "./store";
import { abortMission, reapStale, respondToApproval, startMission } from "./run";
import type { Mission } from "./types";
// InlineKeyboard is a Telegram primitive rather than a watch concept; it is
// imported instead of redeclared so both features build identical markup.
import type { InlineKeyboard } from "../watch/keyboard";

/**
 * Telegram surface for missions.
 *
 * Returns rendered replies rather than sending them, matching the watch feature
 * so the transport keeps one delivery path. Identity is the chat id throughout —
 * the same key missions are stored under, so a button can only ever reach a
 * mission belonging to the chat it was pressed in.
 */

export const MISSION_NS = "m";

export type AgentReply = {
  text: string;
  keyboard?: InlineKeyboard;
  edit?: boolean;
};

export type MissionCallback =
  | { kind: "approve"; missionId: string }
  | { kind: "decline"; missionId: string }
  | { kind: "view"; missionId: string }
  | { kind: "cancel"; missionId: string }
  | { kind: "list" };

/**
 * Parses a mission callback.
 *
 * Strict on shape: the id must look like a UUID, so a crafted payload cannot be
 * used to probe for missions by trying arbitrary strings. Authorisation is still
 * the caller's job — the chat id decides ownership, never the payload.
 */
export function parseMissionCallback(data: string): MissionCallback | null {
  if (typeof data !== "string" || data.length > 64) return null;
  const parts = data.split(":");
  if (parts[0] !== MISSION_NS) return null;
  if (parts[1] === "list") return { kind: "list" };

  const id = parts[2] ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;

  switch (parts[1]) {
    case "a":
      return { kind: "approve", missionId: id };
    case "d":
      return { kind: "decline", missionId: id };
    case "v":
      return { kind: "view", missionId: id };
    case "x":
      return { kind: "cancel", missionId: id };
    default:
      return null;
  }
}

export function approvalKeyboard(mission: Mission): InlineKeyboard {
  return {
    inline_keyboard: [
      [
        { text: "✓ Approve", callback_data: `${MISSION_NS}:a:${mission.id}` },
        { text: "✖ Decline", callback_data: `${MISSION_NS}:d:${mission.id}` },
      ],
    ],
  };
}

function missionKeyboard(mission: Mission): InlineKeyboard | undefined {
  if (mission.state === "waiting_permission") return approvalKeyboard(mission);
  if (mission.state === "completed" || mission.state === "failed" || mission.state === "cancelled") {
    return { inline_keyboard: [[{ text: "🎯 Missions", callback_data: `${MISSION_NS}:list` }]] };
  }
  return {
    inline_keyboard: [
      [
        { text: "↻ Status", callback_data: `${MISSION_NS}:v:${mission.id}` },
        { text: "■ Cancel", callback_data: `${MISSION_NS}:x:${mission.id}` },
      ],
    ],
  };
}

/** Whatever the mission's current state is worth showing. */
export function renderMission(mission: Mission): AgentReply {
  if (mission.state === "waiting_permission") {
    return { text: renderApprovalRequest(mission), keyboard: approvalKeyboard(mission) };
  }
  if (mission.state === "completed" || mission.state === "failed" || mission.state === "cancelled") {
    return { text: renderResult(mission), keyboard: missionKeyboard(mission) };
  }
  return { text: statusLine(mission), keyboard: missionKeyboard(mission) };
}

export async function handleMission(
  chatId: string,
  objective: string,
  onStatus?: (status: string) => void
): Promise<AgentReply> {
  if (!objective.trim()) {
    return {
      text: [
        "Give me an objective, not a command.",
        "",
        "/mission investigate why NVDA is trading above its stock price",
        "/mission check whether any announced split lands on a token here",
        "",
        "I decide which data and tools are needed, and ask before doing anything consequential.",
      ].join("\n"),
    };
  }

  const started = await startMission({ ownerId: chatId, objective, chatId, onStatus });
  if (!started.ok) return { text: started.error };

  return renderMission(started.mission);
}

export async function handleMissions(chatId: string): Promise<AgentReply> {
  const missions = await reapStale(chatId);
  const waiting = missions.find((m) => m.state === "waiting_permission");

  // An outstanding approval is the only thing in this list that needs an answer,
  // so it is surfaced rather than buried in a list the user has to scan.
  if (waiting) {
    return {
      text: `${renderMissionList(missions)}\n\n${"─".repeat(24)}\n\n${renderApprovalRequest(waiting)}`,
      keyboard: approvalKeyboard(waiting),
    };
  }

  return {
    text: renderMissionList(missions),
    keyboard:
      missions.length > 0
        ? { inline_keyboard: missions.slice(0, 5).map((m) => [
            { text: `${m.state === "completed" ? "✓" : "•"} ${m.objective.slice(0, 28)}`, callback_data: `${MISSION_NS}:v:${m.id}` },
          ]) }
        : undefined,
  };
}

export type MissionCallbackOutcome = { reply: AgentReply | null; toast?: string };

/**
 * Routes a mission button.
 *
 * The mission is fetched by owner *and* id, so a payload naming someone else's
 * mission resolves to nothing rather than to their mission.
 */
export async function handleMissionCallback(
  chatId: string,
  data: string,
  onStatus?: (status: string) => void
): Promise<MissionCallbackOutcome> {
  const callback = parseMissionCallback(data);
  if (!callback) return { reply: null, toast: "Unrecognised button." };

  if (callback.kind === "list") {
    const reply = await handleMissions(chatId);
    return { reply: { ...reply, edit: true } };
  }

  const mission = await getMission(chatId, callback.missionId);
  if (!mission) return { reply: null, toast: "That mission is no longer available." };

  switch (callback.kind) {
    case "view":
      return { reply: { ...renderMission(mission), edit: true }, toast: "Refreshed" };

    case "cancel": {
      const result = await abortMission(chatId, mission.id);
      if (!result.ok) return { reply: null, toast: result.error };
      return { reply: { ...renderMission(result.mission), edit: true }, toast: "Cancelled" };
    }

    case "approve":
    case "decline": {
      const approved = callback.kind === "approve";
      const result = await respondToApproval(chatId, mission.id, approved, { chatId, onStatus });
      if (!result.ok) return { reply: null, toast: result.error };
      return {
        reply: { ...renderMission(result.mission), edit: true },
        toast: approved ? "Approved" : "Declined — nothing was run",
      };
    }
  }
}

/** Missions belonging to one chat, for /status. */
export async function missionSummary(chatId: string): Promise<{ total: number; waiting: number }> {
  const missions = await listMissions(chatId);
  return {
    total: missions.length,
    waiting: missions.filter((m) => m.state === "waiting_permission").length,
  };
}
