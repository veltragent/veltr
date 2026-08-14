import test from "node:test";
import assert from "node:assert/strict";

import { advanceMission, answerPermission, cancelMission, createMission, transition } from "../lib/agent/mission";
import { InvalidTransition, canTransition, isTerminal } from "../lib/agent/types";
import { LIMITS } from "../lib/agent/budget";
import { deps, reply, scriptedReasoner, stubRunner, TOOLS } from "./agent-helpers";

/** The mission loop end to end: state machine, budget, permission, verification. */

function mission(overrides: Parameters<typeof createMission>[0] = { ownerId: "u1", objective: "why is NVDA moving" }) {
  return createMission({ ...overrides, now: new Date("2026-08-14T00:00:00.000Z") });
}

/* ------------------------------------------------------ State machine */

test("only declared transitions are permitted", () => {
  assert.equal(canTransition("planning", "running"), true);
  assert.equal(canTransition("acting", "verifying"), true);
  assert.equal(canTransition("verifying", "running"), true, "a failed verification may be reconsidered");

  assert.equal(canTransition("acting", "completed"), false, "acting must pass through verifying");
  assert.equal(canTransition("planning", "acting"), false);
  assert.equal(canTransition("completed", "running"), false);
});

test("terminal states accept nothing", () => {
  for (const state of ["completed", "failed", "cancelled"] as const) {
    assert.equal(isTerminal(state), true);
    for (const to of ["running", "acting", "completed"] as const) {
      assert.equal(canTransition(state, to), false, `${state} → ${to} must be refused`);
    }
  }
});

test("an invalid transition throws rather than being logged", () => {
  const m = mission();
  assert.throws(
    () => transition(m, "completed", "skipping the work", new Date()),
    (error: unknown) => error instanceof InvalidTransition
  );
});

/* ----------------------------------------------------- Normal missions */

test("a mission observes, then concludes from what it observed", async () => {
  const reasoner = scriptedReasoner([
    reply({ verdict: "investigate", reason: "need the price and the news", calls: [{ tool: "get_price", args: { symbol: "NVDA" } }] }),
    reply({ verdict: "conclude", reason: "premium widened on a closed market", evidenceIds: ["e1"], confidence: 0.8, answer: "NVDA trades 1.2% above its last close." }),
  ]);
  const runner = stubRunner({ get_price: { symbol: "NVDA", premiumPct: 1.2 } });

  const { mission: done, paused } = await advanceMission(mission(), deps({ reasoner, runner }));

  assert.equal(paused, false);
  assert.equal(done.state, "completed");
  assert.equal(done.result?.summary, "NVDA trades 1.2% above its last close.");
  assert.deepEqual(done.result?.evidenceIds, ["e1"]);
  assert.equal(done.evidence.length, 1);
  assert.equal(runner.calls.length, 1);
});

test("a multi-step mission carries evidence between rounds", async () => {
  const reasoner = scriptedReasoner([
    reply({ verdict: "investigate", reason: "start with price", calls: [{ tool: "get_price", args: { symbol: "NVDA" } }] }),
    reply({ verdict: "investigate", reason: "now the news", calls: [{ tool: "get_news", args: { symbol: "NVDA" } }] }),
    reply({ verdict: "conclude", reason: "earnings drove it", evidenceIds: ["e1", "e2"], confidence: 0.7, answer: "Earnings." }),
  ]);
  const runner = stubRunner({ get_price: { premiumPct: 1.2 }, get_news: { articles: [] } });

  const { mission: done } = await advanceMission(mission(), deps({ reasoner, runner }));

  assert.equal(done.state, "completed");
  assert.equal(done.iterations, 3);
  assert.deepEqual(done.evidence.map((e) => e.id), ["e1", "e2"]);
  assert.equal(done.result?.confidence, 0.7);
});

/* --------------------------------------------------------- Permission */

/** An objective whose wording routes the position tools. */
const positionMission = () =>
  mission({ ownerId: "u1", objective: "protect my liquidity position before the split" });

test("a high-risk action stops the mission and asks", async () => {
  const reasoner = scriptedReasoner([
    reply({ verdict: "act", reason: "liquidity is at risk before the split", evidenceIds: [], action: { tool: "defend_position", args: { tokenId: "42" } } }),
  ]);
  const runner = stubRunner({ defend_position: { __acted: true, withdrawn: true } });

  const { mission: paused, paused: isPaused } = await advanceMission(positionMission(), deps({ reasoner, runner }));

  assert.equal(isPaused, true);
  assert.equal(paused.state, "waiting_permission");
  assert.equal(paused.pendingAction?.tool, "defend_position");
  assert.equal(paused.pendingAction?.risk, "high");
  assert.equal(runner.calls.length, 0, "nothing may run before the answer");
});

test("declining completes the mission and runs nothing", async () => {
  const reasoner = scriptedReasoner([
    reply({ verdict: "act", reason: "would exit the position", action: { tool: "defend_position", args: { tokenId: "42" } } }),
  ]);
  const runner = stubRunner({ defend_position: { __acted: true } });

  const { mission: waiting } = await advanceMission(positionMission(), deps({ reasoner, runner }));
  const declined = answerPermission(waiting, false, new Date());

  assert.equal(declined.state, "completed");
  assert.equal(declined.pendingAction, null);
  assert.match(declined.result?.summary ?? "", /Declined/);
  assert.deepEqual(declined.result?.actionsTaken, []);
  assert.equal(runner.calls.length, 0, "a refusal must not be reconsidered into running anyway");
});

test("approving runs the action and verifies it", async () => {
  const reasoner = scriptedReasoner([
    reply({ verdict: "act", reason: "scope the alerts", action: { tool: "set_alert_scope", args: { address: "0x1111111111111111111111111111111111111111" } } }),
  ]);
  const runner = stubRunner({
    set_alert_scope: { __acted: true, scope: "0x1111111111111111111111111111111111111111" },
    get_alert_status: { scope: "0x1111111111111111111111111111111111111111" },
  });

  // always_ask forces the gate even for a reversible action.
  const start = createMission({ ownerId: "u1", objective: "narrow my alerts", permissionMode: "always_ask" });
  const { mission: waiting } = await advanceMission(start, deps({ reasoner, runner }));
  assert.equal(waiting.state, "waiting_permission");

  const approved = answerPermission(waiting, true, new Date());
  const { mission: done } = await advanceMission(approved, deps({ reasoner, runner }));

  assert.equal(done.state, "completed");
  assert.equal(done.result?.actionsTaken[0]?.tool, "set_alert_scope");
  assert.equal(done.result?.actionsTaken[0]?.verified, true);
  assert.ok(runner.calls.some((c) => c.tool === "get_alert_status"), "verification reads the state back");
});

test("a reversible action runs unattended, a consequential one never does", async () => {
  const chart = scriptedReasoner([
    reply({ verdict: "act", reason: "user asked to see it", action: { tool: "send_chart", args: { symbol: "NVDA" } } }),
  ]);
  const runner = stubRunner({ send_chart: { __acted: true, sent: true } });

  const { mission: done } = await advanceMission(
    mission({ ownerId: "u1", objective: "show me the NVDA chart" }),
    deps({ reasoner: chart, runner })
  );

  assert.equal(done.state, "completed", "medium risk runs under the default mode");
  assert.equal(done.result?.actionsTaken[0]?.verified, true);
});

test("an action unrelated to the objective is not reachable", async () => {
  // Routing is a control, not a hint. A mission about news has no business
  // reaching a tool that moves a liquidity position, whatever the model decides.
  const reasoner = scriptedReasoner([
    reply({ verdict: "act", reason: "unrelated", action: { tool: "defend_position", args: { tokenId: "42" } } }),
  ]);
  const runner = stubRunner({ defend_position: { __acted: true } });

  const { mission: done } = await advanceMission(
    mission({ ownerId: "u1", objective: "what is the latest news on NVDA" }),
    deps({ reasoner, runner })
  );

  assert.equal(runner.calls.length, 0);
  assert.notEqual(done.state, "waiting_permission", "it is refused outright, not escalated to the user");
  assert.match(done.result?.summary ?? "", /not sufficient/i);
});

/* -------------------------------------------------------- Verification */

test("an action that failed is never reported as done", async () => {
  const reasoner = scriptedReasoner([
    reply({ verdict: "act", reason: "send it", action: { tool: "send_chart", args: { symbol: "NVDA" } } }),
    reply({ verdict: "insufficient_evidence", reason: "the chart could not be sent" }),
  ]);
  const runner = stubRunner({ send_chart: { error: "The image could not be delivered." } });

  const { mission: done } = await advanceMission(
    mission({ ownerId: "u1", objective: "show me the NVDA chart" }),
    deps({ reasoner, runner })
  );

  assert.equal(done.state, "completed");
  const action = done.result?.actionsTaken.find((a) => a.tool === "send_chart");
  assert.equal(action?.verified, false);
  assert.match(done.result?.summary ?? "", /not sufficient|did not succeed/i);
});

test("an action with no verifier is reported as unverified, not as success", async () => {
  const reasoner = scriptedReasoner([
    reply({ verdict: "act", reason: "do the thing", action: { tool: "get_price", args: {} } }),
  ]);
  // get_price is not an action, so it has no verifier — the honest answer is
  // "ran, not confirmed", never "done".
  const runner = stubRunner({ get_price: { symbol: "NVDA" } });

  const { mission: done } = await advanceMission(mission(), deps({ reasoner, runner }));

  assert.equal(done.result?.actionsTaken[0]?.verified, false);
  assert.match(done.result?.summary ?? "", /not independently confirmed/i);
});

/* ------------------------------------------------------------- Failure */

test("a tool that throws is retried, then recorded as failed evidence", async () => {
  let attempts = 0;
  const runner = stubRunner({
    get_price: () => {
      attempts++;
      return new Error("socket hang up");
    },
  });
  const reasoner = scriptedReasoner([
    reply({ verdict: "investigate", reason: "try the price", calls: [{ tool: "get_price", args: { symbol: "NVDA" } }] }),
    reply({ verdict: "insufficient_evidence", reason: "the price could not be read" }),
  ]);

  const { mission: done } = await advanceMission(mission(), deps({ reasoner, runner }));

  assert.equal(attempts, LIMITS.maxAttempts, "retried up to the ceiling, no further");
  assert.equal(done.evidence[0].ok, false);
  assert.equal(done.state, "completed");
  assert.match(done.result?.summary ?? "", /not sufficient/i);
});

test("a provider outage ends the mission honestly rather than inventing an answer", async () => {
  const reasoner = scriptedReasoner([null]);
  const { mission: done } = await advanceMission(mission(), deps({ reasoner }));

  assert.equal(done.state, "completed");
  assert.match(done.result?.summary ?? "", /not sufficient/i);
  assert.equal(done.result?.confidence, null);
});

test("a malformed model reply does not crash the loop", async () => {
  const reasoner = scriptedReasoner(["I think you should probably check the price, honestly."]);
  const { mission: done } = await advanceMission(mission(), deps({ reasoner }));

  assert.equal(done.state, "completed");
  assert.match(done.result?.summary ?? "", /not sufficient/i);
});

/* ------------------------------------------------- Limits and stopping */

test("the iteration ceiling stops a model that will not conclude", async () => {
  // Always asks for another observation; only the ceiling ends this.
  const reasoner = scriptedReasoner([
    reply({ verdict: "investigate", reason: "more", calls: [{ tool: "get_price", args: { n: 1 } }] }),
  ]);
  let counter = 0;
  const runner = stubRunner({ get_price: () => ({ tick: counter++ }) });

  const { mission: done } = await advanceMission(mission(), deps({ reasoner, runner }));

  assert.equal(done.state, "completed");
  assert.ok(done.iterations <= LIMITS.maxIterations + 1, `iterations bounded, got ${done.iterations}`);
  assert.ok(runner.calls.length <= LIMITS.maxToolCalls, "tool calls stay inside the ceiling");
});

test("identical tool calls are not paid for twice", async () => {
  const reasoner = scriptedReasoner([
    reply({ verdict: "investigate", reason: "one", calls: [{ tool: "get_price", args: { symbol: "NVDA" } }] }),
    reply({ verdict: "investigate", reason: "again", calls: [{ tool: "get_price", args: { symbol: "NVDA" } }] }),
    reply({ verdict: "conclude", reason: "done", evidenceIds: ["e1"], answer: "Answered." }),
  ]);
  const runner = stubRunner({ get_price: { symbol: "NVDA" } });

  const { mission: done } = await advanceMission(mission(), deps({ reasoner, runner }));

  assert.equal(runner.calls.length, 1, "the second identical call never reached the tool");
  assert.equal(done.evidence.length, 1, "and did not pad the ledger");
});

test("more calls than a round allows are trimmed", async () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ tool: "get_price", args: { symbol: `T${i}` } }));
  const reasoner = scriptedReasoner([
    reply({ verdict: "investigate", reason: "everything at once", calls: many }),
    reply({ verdict: "conclude", reason: "done", evidenceIds: ["e1"], answer: "Answered." }),
  ]);
  const runner = stubRunner({ get_price: { ok: true } });

  await advanceMission(mission(), deps({ reasoner, runner }));

  assert.ok(runner.calls.length <= LIMITS.maxCallsPerRound, `capped per round, ran ${runner.calls.length}`);
});

test("a mission past its deadline concludes instead of running on", async () => {
  const reasoner = scriptedReasoner([
    reply({ verdict: "conclude", reason: "out of time", evidenceIds: [], answer: "x" }),
  ]);
  const expired = { ...mission(), deadlineAt: "2020-01-01T00:00:00.000Z" };

  const { mission: done } = await advanceMission(expired, deps({ reasoner }));

  assert.equal(done.state, "completed");
  assert.ok(done.iterations <= 1, "no observation rounds after the deadline");
});

test("cancellation stops the loop and says nothing further ran", async () => {
  const reasoner = scriptedReasoner([
    reply({ verdict: "investigate", reason: "go", calls: [{ tool: "get_price", args: {} }] }),
  ]);
  const runner = stubRunner({ get_price: { ok: true } });

  const { mission: done } = await advanceMission(
    mission(),
    deps({ reasoner, runner, isCancelled: () => true })
  );

  assert.equal(done.state, "cancelled");
  assert.equal(runner.calls.length, 0);
});

test("cancelMission is a no-op on a finished mission", () => {
  const finished = { ...mission(), state: "completed" as const };
  assert.equal(cancelMission(finished).state, "completed");
});

/* ----------------------------------------------------------- Isolation */

test("a tool outside the routed set is never run", async () => {
  const reasoner = scriptedReasoner([
    reply({ verdict: "investigate", reason: "sneak one in", calls: [{ tool: "rm_rf", args: { path: "/" } }] }),
  ]);
  const runner = stubRunner({ rm_rf: { deleted: true } });

  const { mission: done } = await advanceMission(mission(), deps({ reasoner, runner, tools: TOOLS }));

  assert.equal(runner.calls.length, 0, "an unrouted tool is not callable, whatever the model asks for");
  assert.equal(done.state, "completed");
});

test("an action naming an unavailable tool is refused, not attempted", async () => {
  const reasoner = scriptedReasoner([
    reply({ verdict: "act", reason: "delete everything", action: { tool: "shell", args: { cmd: "rm -rf /" } } }),
  ]);
  const runner = stubRunner({ shell: { ok: true } });

  const { mission: done } = await advanceMission(mission(), deps({ reasoner, runner }));

  assert.equal(runner.calls.length, 0);
  assert.equal(done.state, "completed");
  assert.match(done.result?.summary ?? "", /not sufficient/i);
});
