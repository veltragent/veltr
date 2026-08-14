import { describeRisk } from "./policy";
import { STATUS_FOR_STATE, type Mission } from "./types";

/**
 * What the user sees.
 *
 * The rule this module enforces: show the decision, the evidence, the action and
 * the outcome — never the deliberation. Chain-of-thought reads as insight while
 * being the least verified thing the model produced, and putting it in front of
 * someone invites them to trust the part nothing checked.
 *
 * So a mission reports what it looked at, what it concluded, what it did, and
 * whether that was confirmed. Not how it felt about any of it.
 */

export function statusLine(mission: Mission): string {
  const status = STATUS_FOR_STATE[mission.state];
  const last = mission.steps[mission.steps.length - 1];
  return last ? `${status} — ${last.note}` : status;
}

/** Confidence is shown only when it was allowed to survive validation. */
function confidenceLine(confidence: number | null): string | null {
  if (confidence === null) return null;
  const label = confidence >= 0.75 ? "high" : confidence >= 0.5 ? "moderate" : "low";
  return `Confidence: ${label} (${confidence.toFixed(2)})`;
}

/** The sources the mission actually retrieved. Never a link it did not fetch. */
export function citedSources(mission: Mission, limit = 4): string[] {
  const cited = new Set(mission.result?.evidenceIds ?? []);
  const urls: string[] = [];

  for (const entry of mission.evidence) {
    if (cited.size > 0 && !cited.has(entry.id)) continue;
    for (const url of entry.urls) {
      if (!urls.includes(url)) urls.push(url);
      if (urls.length >= limit) return urls;
    }
  }

  return urls;
}

export function renderApprovalRequest(mission: Mission): string {
  const pending = mission.pendingAction;
  if (!pending) return statusLine(mission);

  return [
    "⏸ WAITING FOR APPROVAL",
    "",
    `Objective: ${mission.objective}`,
    "",
    `Proposed action: ${pending.tool}`,
    `Risk: ${pending.risk} — ${describeRisk(pending.risk)}`,
    Object.keys(pending.args).length ? `Arguments: ${JSON.stringify(pending.args)}` : "",
    "",
    `Why: ${pending.rationale}`,
    "",
    "Nothing has been done yet. Approve or decline below.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * The finished mission.
 *
 * An action is reported as done only when the verification layer confirmed it;
 * anything else says so in the same breath. There is no phrasing here that lets
 * an unverified action read as a successful one.
 */
export function renderResult(mission: Mission): string {
  const lines: string[] = [];

  if (mission.state === "failed") {
    return ["✖ MISSION FAILED", "", `Objective: ${mission.objective}`, "", mission.error ?? "No reason recorded."].join("\n");
  }

  if (mission.state === "cancelled") {
    return ["■ CANCELLED", "", `Objective: ${mission.objective}`, "", "Nothing further was run."].join("\n");
  }

  const result = mission.result;
  if (!result) return statusLine(mission);

  lines.push("✓ COMPLETED", "", `Objective: ${mission.objective}`, "", result.summary);

  const confidence = confidenceLine(result.confidence);
  if (confidence) lines.push("", confidence);

  if (result.actionsTaken.length > 0) {
    lines.push("", "Actions:");
    for (const action of result.actionsTaken) {
      lines.push(`${action.verified ? "✓" : "⚠"} ${action.tool} — ${action.detail}`);
    }
  }

  const observed = mission.evidence.filter((e) => e.ok).length;
  lines.push(
    "",
    `Based on ${result.evidenceIds.length || observed} observation${
      (result.evidenceIds.length || observed) === 1 ? "" : "s"
    } across ${mission.iterations} iteration${mission.iterations === 1 ? "" : "s"}.`
  );

  const sources = citedSources(mission);
  if (sources.length > 0) lines.push("", "Sources:", ...sources);

  return lines.join("\n");
}

/** One line per mission, for the list view. */
export function renderMissionList(missions: Mission[]): string {
  if (missions.length === 0) {
    return [
      "No missions yet.",
      "",
      "Give me an objective and I will work out the steps:",
      "/mission investigate why NVDA is trading above its stock price",
    ].join("\n");
  }

  const rows = missions.slice(0, 10).map((mission, i) => {
    const status = STATUS_FOR_STATE[mission.state];
    const marker = mission.state === "waiting_permission" ? "⏸" : mission.state === "completed" ? "✓" : mission.state === "failed" ? "✖" : "•";
    return `${i + 1}. ${marker} ${mission.objective.slice(0, 70)}\n   ${status} · ${mission.evidence.length} observations`;
  });

  return ["🎯 Your missions", "", rows.join("\n\n")].join("\n");
}
