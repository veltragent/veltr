/**
 * Agent core — shared vocabulary and the mission state machine.
 *
 * A mission is the unit of autonomous work: the user supplies an objective, and
 * the agent decides what to observe, what it means, whether to act, and whether
 * the action worked. Every stage below is a state, and the legal moves between
 * them are declared here rather than implied by control flow — an agent that can
 * reach `completed` without ever verifying an action it took is a liar, and that
 * has to be impossible by construction rather than by care.
 */

export type MissionState =
  | "planning"
  | "running"
  | "waiting_permission"
  | "acting"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelled";

/** Nothing leaves these. A finished mission is a record, not a resource. */
export const TERMINAL_STATES: MissionState[] = ["completed", "failed", "cancelled"];

/**
 * The only legal moves.
 *
 * `verifying → running` is the one backward edge, and it is what lets a failed
 * verification be reconsidered rather than reported as success. It is bounded by
 * the iteration cap, not by the state machine, which is why that cap is not
 * optional.
 */
const TRANSITIONS: Record<MissionState, MissionState[]> = {
  planning: ["running", "failed", "cancelled"],
  running: ["running", "waiting_permission", "acting", "verifying", "completed", "failed", "cancelled"],
  waiting_permission: ["acting", "completed", "failed", "cancelled"],
  acting: ["verifying", "failed", "cancelled"],
  verifying: ["completed", "running", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function isTerminal(state: MissionState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function canTransition(from: MissionState, to: MissionState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** Thrown rather than logged: an illegal transition is a bug, not a condition. */
export class InvalidTransition extends Error {
  readonly from: MissionState;
  readonly to: MissionState;

  constructor(from: MissionState, to: MissionState) {
    super(`Invalid mission transition: ${from} → ${to}`);
    this.name = "InvalidTransition";
    this.from = from;
    this.to = to;
  }
}

/** What the user sees while a mission runs. One line, never internal reasoning. */
export type MissionStatus =
  | "OBSERVING"
  | "ANALYZING"
  | "DECIDING"
  | "WAITING FOR APPROVAL"
  | "ACTING"
  | "VERIFYING"
  | "COMPLETED";

export const STATUS_FOR_STATE: Record<MissionState, MissionStatus> = {
  planning: "ANALYZING",
  running: "OBSERVING",
  waiting_permission: "WAITING FOR APPROVAL",
  acting: "ACTING",
  verifying: "VERIFYING",
  completed: "COMPLETED",
  failed: "COMPLETED",
  cancelled: "COMPLETED",
};

/* ------------------------------------------------------------- Evidence */

/**
 * One observation, produced by one tool call.
 *
 * The ledger is the mission's entire factual basis. A claim that cannot point at
 * an entry here did not come from the world, and the decision engine drops it —
 * which is the mechanism behind "never invent a source".
 */
export type Evidence = {
  /** Short, stable, quotable by the model: e1, e2, … */
  id: string;
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  /** Redacted, truncated rendering of the tool result. */
  summary: string;
  /** URLs the tool actually returned. The only URLs allowed in output. */
  urls: string[];
  at: string;
};

/* ------------------------------------------------------------- Decisions */

export type DecisionVerdict =
  /** Enough is known to answer or to act. */
  | "conclude"
  /** More observation is warranted and the budget allows it. */
  | "investigate"
  /** An action should be taken, named in `action`. */
  | "act"
  /** The available evidence does not support any conclusion. */
  | "insufficient_evidence";

export type Decision = {
  verdict: DecisionVerdict;
  /** Ids that exist in the ledger. Validated, never taken on trust. */
  evidenceIds: string[];
  /** Short justification. Never chain-of-thought. */
  reason: string;
  /** Null unless the evidence genuinely supports a number. */
  confidence: number | null;
  /** Set when verdict is "act". */
  action: { tool: string; args: Record<string, unknown> } | null;
  /** Set when verdict is "conclude". */
  answer: string | null;
};

/* --------------------------------------------------------------- Risk */

/**
 * How much a tool can hurt.
 *
 * `low` reads the world and changes nothing. `medium` changes something the
 * caller owns and can undo. `high` is consequential: it spends money, moves
 * funds, destroys data, or is visible outside this system. The split exists so
 * autonomy can be granted to the first two without ever being granted to the
 * third by accident.
 */
export type RiskLevel = "low" | "medium" | "high";

export type PermissionMode =
  /** Only reads run automatically. Anything that changes state asks. */
  | "read_only"
  /** Reversible, caller-owned changes run automatically. High risk still asks. */
  | "auto_low_risk"
  /** Every action asks, including reversible ones. */
  | "always_ask";

export type ActionRequest = {
  tool: string;
  args: Record<string, unknown>;
  risk: RiskLevel;
  /** Why this is being asked for, in the user's terms. */
  rationale: string;
};

/* ------------------------------------------------------------- Mission */

export type MissionStep = {
  at: string;
  state: MissionState;
  /** One short line for the user. Never model reasoning. */
  note: string;
};

export type MissionResult = {
  /** What the user asked for, answered. */
  summary: string;
  /** Ids backing the summary. */
  evidenceIds: string[];
  confidence: number | null;
  /** Actions actually performed and verified. Never aspirational. */
  actionsTaken: { tool: string; verified: boolean; detail: string }[];
};

export type Mission = {
  id: string;
  /** Telegram chat id or API caller. Scopes every read and write. */
  ownerId: string;
  objective: string;
  state: MissionState;
  permissionMode: PermissionMode;
  createdAt: string;
  updatedAt: string;
  /** Wall-clock ceiling; a mission past it fails rather than running on. */
  deadlineAt: string;
  iterations: number;
  toolCalls: number;
  evidence: Evidence[];
  steps: MissionStep[];
  /** Set while waiting_permission; cleared once answered. */
  pendingAction: ActionRequest | null;
  decisions: Decision[];
  result: MissionResult | null;
  /** Present only when state is "failed". */
  error: string | null;
};
