import { randomUUID } from "node:crypto";
import { LIMITS, callFingerprint, checkBudget, remainingToolCalls } from "./budget";
import { decide } from "./decide";
import { declaredActions, executeCall, registryRunner, type ToolRunner } from "./execute";
import { append, nextEvidenceId, toEvidence, usableEvidence } from "./evidence";
import { DEFAULT_PERMISSION_MODE, describeRisk, requiresApproval, riskOf } from "./policy";
import { llmReasoner, type Reasoner } from "./reasoner";
import { availableTools, routeTools, type RoutableTool } from "./router";
import { verifyAction } from "./verify";
import {
  InvalidTransition,
  canTransition,
  isTerminal,
  type Mission,
  type MissionResult,
  type MissionState,
  type PermissionMode,
} from "./types";

/**
 * Mission manager — the agent loop.
 *
 *   OBSERVE → REASON → DECIDE → ACT → VERIFY
 *
 * The loop is a state machine rather than a sequence of awaits, for one reason:
 * a mission has to survive being interrupted. Waiting for a human to approve an
 * action can take hours, and a loop that holds that in a call stack loses it on
 * restart. So each pass runs until it either finishes or needs something it
 * cannot get by itself, persists, and returns.
 *
 * Everything the loop depends on is injected. A full mission — observation,
 * decision, permission refusal, action, verification — runs in a test with no
 * network, no model and no API key.
 */

export type MissionDeps = {
  reasoner: Reasoner;
  runner: ToolRunner;
  tools: RoutableTool[];
  /** Tools the registry declares as actions, used as the risk floor. */
  actionTools: Set<string>;
  now: () => Date;
  /** Cooperative cancellation, checked between steps. */
  isCancelled: () => boolean;
  /** Called as the visible status changes. Never receives model reasoning. */
  onStatus?: (note: string) => void;
};

export async function defaultDeps(chatId?: string | null): Promise<MissionDeps> {
  const [tools, actionTools, runner] = await Promise.all([
    availableTools(),
    declaredActions(),
    registryRunner(chatId),
  ]);

  return {
    reasoner: llmReasoner("fast"),
    runner,
    tools,
    actionTools,
    now: () => new Date(),
    isCancelled: () => false,
  };
}

/* --------------------------------------------------------- Construction */

export function createMission(input: {
  ownerId: string;
  objective: string;
  permissionMode?: PermissionMode;
  now?: Date;
}): Mission {
  const now = input.now ?? new Date();
  const iso = now.toISOString();

  return {
    id: randomUUID(),
    ownerId: input.ownerId,
    objective: input.objective.trim().slice(0, 1_000),
    state: "planning",
    permissionMode: input.permissionMode ?? DEFAULT_PERMISSION_MODE,
    createdAt: iso,
    updatedAt: iso,
    deadlineAt: new Date(now.getTime() + LIMITS.missionTimeoutMs).toISOString(),
    iterations: 0,
    toolCalls: 0,
    evidence: [],
    steps: [{ at: iso, state: "planning", note: "Mission created." }],
    pendingAction: null,
    decisions: [],
    result: null,
    error: null,
  };
}

/**
 * The only way a mission changes state.
 *
 * Throws on an illegal move rather than logging one. A mission that reaches
 * `completed` from `acting` without passing through `verifying` would be
 * reporting an unverified action as done — the class of bug this guard exists to
 * make impossible, so it must be loud.
 */
export function transition(mission: Mission, to: MissionState, note: string, at: Date): Mission {
  if (!canTransition(mission.state, to)) throw new InvalidTransition(mission.state, to);

  const iso = at.toISOString();
  return {
    ...mission,
    state: to,
    updatedAt: iso,
    steps: [...mission.steps, { at: iso, state: to, note }].slice(-40),
  };
}

/* ------------------------------------------------------------- The loop */

export type AdvanceResult = {
  mission: Mission;
  /** True when the mission needs something before it can continue. */
  paused: boolean;
};

/**
 * Runs a mission until it finishes or needs a human.
 *
 * Bounded three ways — iterations, tool calls, wall clock — because an agent
 * that decides when to stop is an agent that can decide not to.
 */
export async function advanceMission(
  mission: Mission,
  overrides: Partial<MissionDeps> = {}
): Promise<AdvanceResult> {
  const deps: MissionDeps = {
    ...(await defaultDeps(mission.ownerId)),
    ...overrides,
  };

  let current = mission;

  if (isTerminal(current.state)) return { mission: current, paused: false };

  // A mission resumed after approval re-enters at the action; one that has never
  // run starts observing.
  if (current.state === "planning") {
    const routed = routeTools(current.objective, deps.tools);
    current = transition(
      current,
      "running",
      `Planned: ${routed.tools.length} tools selected${routed.tags.length ? ` (${routed.tags.join(", ")})` : ""}.`,
      deps.now()
    );
    deps.onStatus?.("OBSERVING");
  }

  const seen = new Set<string>(
    current.evidence.map((e) => callFingerprint(e.tool, e.args))
  );

  for (;;) {
    if (deps.isCancelled()) {
      return { mission: finish(current, "cancelled", "Cancelled.", deps.now()), paused: false };
    }

    if (current.state === "waiting_permission") {
      // Nothing to do until someone answers. Persisting here is what lets the
      // answer arrive in a different process, hours later.
      return { mission: current, paused: true };
    }

    if (current.state === "acting") {
      current = await runApprovedAction(current, deps, seen);
      continue;
    }

    if (isTerminal(current.state)) return { mission: current, paused: false };

    const budget = checkBudget(current, deps.now());

    // Out of budget: one final decision with no observations allowed, so the
    // mission concludes from what it has instead of stopping mid-thought.
    const routed = routeTools(current.objective, deps.tools);
    deps.onStatus?.(budget.ok ? "ANALYZING" : "DECIDING");

    const outcome = await decide(deps.reasoner, {
      objective: current.objective,
      ledger: current.evidence,
      tools: routed.tools,
      iteration: current.iterations + 1,
      remainingToolCalls: remainingToolCalls(current),
      mustConclude: !budget.ok,
    });

    current = {
      ...current,
      iterations: current.iterations + 1,
      decisions: [...current.decisions, outcome.decision].slice(-10),
      updatedAt: deps.now().toISOString(),
    };

    if (outcome.malformed) {
      console.warn(`[veltr][AGENT] mission=${current.id} decision rejected: ${outcome.malformed}`);
    }

    const { decision } = outcome;

    if (decision.verdict === "insufficient_evidence") {
      return {
        mission: conclude(current, deps, {
          summary: usableEvidence(current.evidence).length
            ? `Evidence is not sufficient. ${decision.reason}`
            : "Evidence is not sufficient — nothing could be observed for this objective.",
          evidenceIds: decision.evidenceIds,
          confidence: null,
          actionsTaken: [],
        }),
        paused: false,
      };
    }

    if (decision.verdict === "conclude") {
      return {
        mission: conclude(current, deps, {
          summary: decision.answer ?? decision.reason,
          evidenceIds: decision.evidenceIds,
          confidence: decision.confidence,
          actionsTaken: [],
        }),
        paused: false,
      };
    }

    if (decision.verdict === "act" && decision.action) {
      const { tool, args } = decision.action;
      const risk = riskOf(tool, deps.actionTools.has(tool));

      if (requiresApproval(risk, current.permissionMode)) {
        deps.onStatus?.("WAITING FOR APPROVAL");
        current = transition(
          current,
          "waiting_permission",
          `Approval needed: ${tool} (${describeRisk(risk)}).`,
          deps.now()
        );
        return {
          mission: { ...current, pendingAction: { tool, args, risk, rationale: decision.reason } },
          paused: true,
        };
      }

      deps.onStatus?.("ACTING");
      current = transition(current, "acting", `Acting: ${tool}.`, deps.now());
      current = { ...current, pendingAction: { tool, args, risk, rationale: decision.reason } };
      continue;
    }

    // investigate — but the budget check happens before spending, not after.
    if (!budget.ok) {
      return {
        mission: conclude(current, deps, {
          summary: `Evidence is not sufficient. ${budget.reason}`,
          evidenceIds: decision.evidenceIds,
          confidence: null,
          actionsTaken: [],
        }),
        paused: false,
      };
    }

    deps.onStatus?.("OBSERVING");
    current = await observe(current, deps, outcome.calls, seen);
  }
}

/* -------------------------------------------------------------- OBSERVE */

async function observe(
  mission: Mission,
  deps: MissionDeps,
  calls: { tool: string; args: Record<string, unknown> }[],
  seen: Set<string>
): Promise<Mission> {
  let current = mission;
  const capped = calls.slice(0, LIMITS.maxCallsPerRound);

  for (const call of capped) {
    if (deps.isCancelled()) break;
    if (current.toolCalls >= LIMITS.maxToolCalls) break;

    const outcome = await executeCall(deps.runner, call.tool, call.args, {
      mode: current.permissionMode,
      seen,
      declaresAction: deps.actionTools.has(call.tool),
    });

    // A duplicate never reached the network and its answer is already in the
    // ledger; recording it again would pad the evidence with repetition.
    if (outcome.blocked === "duplicate") continue;

    const entry = toEvidence(
      nextEvidenceId(current.evidence),
      { tool: call.tool, args: call.args, result: outcome.result, ok: outcome.ok },
      deps.now().toISOString()
    );

    current = {
      ...current,
      evidence: append(current.evidence, entry),
      toolCalls: current.toolCalls + 1,
      updatedAt: deps.now().toISOString(),
    };

    console.log(
      `[veltr][AGENT] mission=${current.id} observed tool=${call.tool} ok=${outcome.ok} evidence=${entry.id}`
    );
  }

  return current;
}

/* ------------------------------------------------------- ACT and VERIFY */

async function runApprovedAction(
  mission: Mission,
  deps: MissionDeps,
  seen: Set<string>
): Promise<Mission> {
  const pending = mission.pendingAction;
  if (!pending) {
    return finish(mission, "failed", "Reached the acting state with no action to run.", deps.now());
  }

  const outcome = await executeCall(deps.runner, pending.tool, pending.args, {
    mode: mission.permissionMode,
    seen,
    // Approval was either granted explicitly or not required; either way this
    // call has already passed the gate that decided it.
    approved: true,
    declaresAction: deps.actionTools.has(pending.tool),
  });

  let current: Mission = {
    ...mission,
    toolCalls: mission.toolCalls + 1,
    evidence: append(
      mission.evidence,
      toEvidence(
        nextEvidenceId(mission.evidence),
        { tool: pending.tool, args: pending.args, result: outcome.result, ok: outcome.ok },
        deps.now().toISOString()
      )
    ),
  };

  deps.onStatus?.("VERIFYING");
  current = transition(current, "verifying", `Verifying ${pending.tool}.`, deps.now());

  const verification = await verifyAction(pending.tool, pending.args, outcome.result, deps.runner);

  console.log(
    `[veltr][AGENT] mission=${current.id} acted tool=${pending.tool} ok=${outcome.ok} verified=${verification.verified}`
  );

  const actionsTaken = [
    ...(current.result?.actionsTaken ?? []),
    { tool: pending.tool, verified: verification.verified, detail: verification.detail },
  ];

  // The action failed outright. Say so — and let the mission carry on reasoning
  // if it has budget, rather than reporting a failure as an outcome.
  if (!outcome.ok) {
    const budget = checkBudget(current, deps.now());
    const summary = `The action did not succeed. ${verification.detail}`;

    if (!budget.ok) {
      return conclude({ ...current, pendingAction: null }, deps, {
        summary,
        evidenceIds: [],
        confidence: null,
        actionsTaken,
      });
    }

    return transition(
      { ...current, pendingAction: null, result: { summary, evidenceIds: [], confidence: null, actionsTaken } },
      "running",
      summary,
      deps.now()
    );
  }

  return conclude({ ...current, pendingAction: null }, deps, {
    summary: verification.verified
      ? `Done. ${verification.detail}`
      : `Ran, but not independently confirmed. ${verification.detail}`,
    evidenceIds: current.evidence.slice(-1).map((e) => e.id),
    confidence: null,
    actionsTaken,
  });
}

/* -------------------------------------------------------------- Endings */

/**
 * Records the result and closes the mission.
 *
 * Actions already attempted are carried forward rather than replaced. Without
 * this, a mission that tries something, fails, and then reasons its way to an
 * answer reports only the answer — quietly dropping the fact that it attempted
 * an action at all. An attempt that failed is exactly the thing a user must not
 * have to ask about.
 */
function conclude(mission: Mission, deps: MissionDeps, result: MissionResult): Mission {
  deps.onStatus?.("COMPLETED");

  const prior = mission.result?.actionsTaken ?? [];
  const actionsTaken = [
    ...prior,
    ...result.actionsTaken.filter(
      (action) => !prior.some((p) => p.tool === action.tool && p.detail === action.detail)
    ),
  ];

  const withResult = { ...mission, result: { ...result, actionsTaken } };
  return transition(withResult, "completed", "Completed.", deps.now());
}

function finish(mission: Mission, to: MissionState, note: string, at: Date): Mission {
  if (!canTransition(mission.state, to)) return mission;
  const next = transition(mission, to, note, at);
  return to === "failed" ? { ...next, error: note } : next;
}

/* ---------------------------------------------------------- Permissions */

/**
 * Answers a pending approval.
 *
 * A refusal completes the mission rather than looping back to reason again:
 * having been told no, an agent that immediately reconsiders how to achieve the
 * same end is not respecting the answer.
 */
export function answerPermission(
  mission: Mission,
  approved: boolean,
  now: Date = new Date()
): Mission {
  if (mission.state !== "waiting_permission" || !mission.pendingAction) return mission;

  if (!approved) {
    const pending = mission.pendingAction;
    const withResult: Mission = {
      ...mission,
      pendingAction: null,
      result: {
        summary: `Declined. ${pending.tool} was not run, so nothing changed.`,
        evidenceIds: [],
        confidence: null,
        actionsTaken: [],
      },
    };
    return transition(withResult, "completed", `Declined: ${pending.tool}.`, now);
  }

  return transition(mission, "acting", `Approved: ${mission.pendingAction.tool}.`, now);
}

export function cancelMission(mission: Mission, now: Date = new Date()): Mission {
  if (isTerminal(mission.state)) return mission;
  return transition(mission, "cancelled", "Cancelled by the user.", now);
}
