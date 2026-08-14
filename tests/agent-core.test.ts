import test from "node:test";
import assert from "node:assert/strict";

import { redact, redactValue, REDACTED } from "../lib/agent/redact";
import { riskOf, requiresApproval, DEFAULT_PERMISSION_MODE } from "../lib/agent/policy";
import { routeTools, signalsFor, signatureOf } from "../lib/agent/router";
import { parseJsonObject, stripReasoning } from "../lib/agent/reasoner";
import { decide, MIN_EVIDENCE_FOR_CONFIDENCE } from "../lib/agent/decide";
import { append, extractUrls, nextEvidenceId, resolveCitations, stripUnknownUrls, toEvidence } from "../lib/agent/evidence";
import { LIMITS, callFingerprint, truncate, withTimeout } from "../lib/agent/budget";
import { executeCall } from "../lib/agent/execute";
import { verifyAction } from "../lib/agent/verify";
import { reply, scriptedReasoner, stubRunner, TOOLS } from "./agent-helpers";
import type { Evidence } from "../lib/agent/types";

/* ------------------------------------------------------------ Redaction */

test("environment secrets are removed wherever they appear", () => {
  const env = { GITHUB_TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz012345", SHORT: "abc" };
  const text = redact("request failed with token ghp_abcdefghijklmnopqrstuvwxyz012345 attached", env);

  assert.ok(!text.includes("ghp_abcdefghijklmnopqrstuvwxyz012345"));
  assert.ok(text.includes(REDACTED));
});

test("credential shapes are removed even when the value is not ours", () => {
  const env = {};
  assert.ok(!redact("key=0x" + "a".repeat(64), env).includes("a".repeat(64)), "a private key");
  assert.ok(!redact("Authorization: Bearer abcdefghijklmnop1234", env).includes("abcdefghijklmnop1234"));
  assert.ok(!redact("https://x.test/a?api_key=supersecretvalue123", env).includes("supersecretvalue123"));
  assert.ok(redact("https://x.test/a?api_key=supersecretvalue123", env).includes("api_key="), "the parameter name survives");
});

test("short environment values are not treated as secrets", () => {
  const env = { API_KEY: "dev" };
  assert.equal(redact("running in dev mode", env), "running in dev mode");
});

test("addresses survive redaction but private keys do not", () => {
  const env = {};
  const address = "0x2e8c31162b855a2ffa90f6f8634643ad6f111e18";
  assert.ok(redact(`token ${address}`, env).includes(address), "40 hex chars is an address, not a key");
  assert.ok(!redact(`key 0x${"f".repeat(64)}`, env).includes("f".repeat(64)));
});

test("unserialisable values do not throw on the way into the ledger", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.equal(redactValue(cyclic, {}), "[unserialisable]");
});

/* --------------------------------------------------------- Permissions */

test("an unknown tool is high risk", () => {
  assert.equal(riskOf("something_new"), "high", "fail closed: an unclassified tool is not autonomous");
  assert.equal(requiresApproval(riskOf("something_new"), "auto_low_risk"), true);
});

test("risk is assigned by what a tool can do", () => {
  assert.equal(riskOf("get_price"), "low");
  assert.equal(riskOf("web_search"), "low");
  assert.equal(riskOf("set_alert_scope"), "medium");
  assert.equal(riskOf("send_chart"), "medium");
  assert.equal(riskOf("defend_position"), "high");
});

test("a read tool that declares itself an action is promoted, never demoted", () => {
  assert.equal(riskOf("get_price", true), "medium", "the registry's own flag is a floor");
});

test("high risk requires approval in every mode, with no override", () => {
  for (const mode of ["read_only", "auto_low_risk", "always_ask"] as const) {
    assert.equal(requiresApproval("high", mode), true, `mode ${mode} must not bypass the gate`);
  }
});

test("reversible caller-owned actions are autonomous only under auto_low_risk", () => {
  assert.equal(requiresApproval("medium", "auto_low_risk"), false);
  assert.equal(requiresApproval("medium", "read_only"), true);
  assert.equal(requiresApproval("medium", "always_ask"), true);
  assert.equal(requiresApproval("low", "read_only"), false, "reads always run");
  assert.equal(DEFAULT_PERMISSION_MODE, "auto_low_risk");
});

/* -------------------------------------------------------------- Routing */

test("an objective routes to the tools it implies, not to all of them", () => {
  const routed = routeTools("investigate why ETH is moving", TOOLS);
  const names = routed.tools.map((t) => t.name);

  assert.ok(names.includes("get_news") || names.includes("web_search"), "a why-question needs news");
  assert.ok(!names.includes("defend_position"), "and has no business touching a position");
});

test("routing never returns more than the cap", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ name: `get_thing_${i}`, description: "x" }));
  assert.ok(routeTools("price news chart wallet repo file", many).tools.length <= 8);
});

test("an objective matching nothing still gets a usable set", () => {
  const routed = routeTools("zzzz", TOOLS);
  assert.ok(routed.tools.length > 0, "an empty tool set would make the mission impossible");
});

test("tool signatures carry argument names into the prompt", () => {
  // A live run showed the model calling get_price({ticker}) when the tool takes
  // {symbol}: given only prose, argument names get invented and the call fails
  // as though the data were missing.
  const signature = signatureOf({
    name: "get_price",
    description: "Live price.",
    parameters: {
      type: "object",
      properties: { symbol: { type: "string" }, hours: { type: "number" } },
      required: ["symbol"],
    },
  });

  assert.equal(signature, "get_price(symbol: string, hours?: number)");
});

test("a tool with no parameters renders as taking none", () => {
  assert.equal(signatureOf({ name: "get_market", description: "State." }), "get_market()");
});

test("enum parameters show their permitted values", () => {
  const signature = signatureOf({
    name: "search_tokens",
    description: "Filter.",
    parameters: { type: "object", properties: { status: { type: "string", enum: ["all", "drifted"] } } },
  });
  assert.equal(signature, 'search_tokens(status?: "all"|"drifted")');
});

test("signals are read from Indonesian as well as English", () => {
  assert.ok(signalsFor("kenapa harga naik").includes("price"));
  assert.ok(signalsFor("pantau likuiditas").includes("liquidity"));
});

/* ---------------------------------------------------------- JSON output */

test("JSON survives code fences and surrounding prose", () => {
  assert.deepEqual(parseJsonObject('```json\n{"verdict":"conclude"}\n```'), { verdict: "conclude" });
  assert.deepEqual(parseJsonObject('Here you go:\n{"verdict":"act"}\nHope that helps!'), { verdict: "act" });
  assert.deepEqual(parseJsonObject('{"a":{"b":[1,2]}}'), { a: { b: [1, 2] } });
});

test("braces inside strings do not break extraction", () => {
  assert.deepEqual(parseJsonObject('{"reason":"a } brace","ok":true}'), { reason: "a } brace", ok: true });
});

test("unparseable output is null rather than an exception", () => {
  assert.equal(parseJsonObject("no json at all"), null);
  assert.equal(parseJsonObject(""), null);
  assert.equal(parseJsonObject(null), null);
  assert.equal(parseJsonObject("[1,2,3]"), null, "an array is not a decision");
});

test("chain-of-thought wrappers are stripped before anything is parsed", () => {
  const text = "<thinking>the user probably wants X, let me reason step by step</thinking>{\"verdict\":\"conclude\"}";
  assert.ok(!stripReasoning(text).includes("step by step"));
  assert.deepEqual(parseJsonObject(text), { verdict: "conclude" });
});

/* -------------------------------------------------------- Evidence ledger */

const evidence = (id: string, overrides: Partial<Evidence> = {}): Evidence => ({
  id,
  tool: "get_price",
  args: {},
  ok: true,
  summary: "{}",
  urls: [],
  at: "2026-08-14T00:00:00.000Z",
  ...overrides,
});

test("citations that do not resolve are discarded", () => {
  const ledger = [evidence("e1"), evidence("e2")];
  assert.deepEqual(resolveCitations(ledger, ["e1", "e9", "e2"]), ["e1", "e2"]);
  assert.deepEqual(resolveCitations(ledger, "e1"), [], "a non-array citation is not a citation");
  assert.deepEqual(resolveCitations(ledger, ["e1", "e1"]), ["e1"]);
});

test("only URLs a tool returned may appear in output", () => {
  const ledger = [evidence("e1", { urls: ["https://real.test/a"] })];

  const text = stripUnknownUrls("see https://real.test/a and https://invented.test/b", ledger);
  assert.ok(text.includes("https://real.test/a"));
  assert.ok(!text.includes("invented.test"));
  assert.ok(text.includes("[unverified link removed]"));
});

test("URLs are collected from the result as it arrives", () => {
  const entry = toEvidence("e1", {
    tool: "web_search",
    args: {},
    ok: true,
    result: { hits: [{ url: "https://example.test/story." }] },
  });
  assert.deepEqual(entry.urls, ["https://example.test/story"], "trailing punctuation is prose");
});

test("evidence ids continue past the existing ledger", () => {
  assert.equal(nextEvidenceId([]), "e1");
  assert.equal(nextEvidenceId([evidence("e1"), evidence("e2")]), "e3");
});

test("an overflowing ledger drops failures before findings", () => {
  const ledger = Array.from({ length: LIMITS.maxEvidence }, (_, i) =>
    evidence(`e${i + 1}`, { ok: i < 3 ? false : true })
  );
  const next = append(ledger, evidence("new"));

  assert.equal(next.length, LIMITS.maxEvidence);
  assert.ok(next.some((e) => e.id === "new"));
  assert.ok(!next.some((e) => e.id === "e1"), "the first failed lookup went first");
  assert.ok(next.some((e) => e.id === "e4"), "a successful observation was kept");
});

test("a secret in a tool result never reaches the ledger", () => {
  const entry = toEvidence(
    "e1",
    { tool: "github_repo", args: {}, ok: false, result: { error: "bad credentials: ghp_aaaaaaaaaaaaaaaaaaaa" } },
    "2026-08-14T00:00:00.000Z"
  );
  assert.ok(!entry.summary.includes("ghp_aaaaaaaaaaaaaaaaaaaa"));
});

test("extractUrls ignores anything absurd", () => {
  assert.deepEqual(extractUrls("no links here"), []);
  assert.deepEqual(extractUrls(`https://x.test/${"a".repeat(500)}`), []);
});

/* -------------------------------------------------------- Decision engine */

const decisionInput = (ledger: Evidence[], overrides = {}) => ({
  objective: "why is NVDA moving",
  ledger,
  tools: TOOLS,
  iteration: 1,
  remainingToolCalls: 10,
  ...overrides,
});

test("a conclusion citing nothing is downgraded to insufficient evidence", async () => {
  const reasoner = scriptedReasoner([
    reply({ verdict: "conclude", reason: "it went up", evidenceIds: [], answer: "NVDA rose 5%." }),
  ]);

  const outcome = await decide(reasoner, decisionInput([evidence("e1")]));

  assert.equal(outcome.decision.verdict, "insufficient_evidence");
  assert.equal(outcome.decision.answer, null, "the uncited claim does not survive");
  assert.equal(outcome.malformed, "uncited_conclusion");
});

test("a conclusion citing invented evidence is downgraded", async () => {
  const reasoner = scriptedReasoner([
    reply({ verdict: "conclude", reason: "per e9", evidenceIds: ["e9"], answer: "It rose." }),
  ]);

  const outcome = await decide(reasoner, decisionInput([evidence("e1")]));
  assert.equal(outcome.decision.verdict, "insufficient_evidence");
});

test("confidence needs more than one observation behind it", async () => {
  const single = await decide(
    scriptedReasoner([reply({ verdict: "conclude", reason: "r", evidenceIds: ["e1"], confidence: 0.9, answer: "a" })]),
    decisionInput([evidence("e1")])
  );
  assert.equal(single.decision.confidence, null, "one observation is not a basis for a number");

  const double = await decide(
    scriptedReasoner([reply({ verdict: "conclude", reason: "r", evidenceIds: ["e1", "e2"], confidence: 0.9, answer: "a" })]),
    decisionInput([evidence("e1"), evidence("e2")])
  );
  assert.equal(double.decision.confidence, 0.9);
  assert.equal(MIN_EVIDENCE_FOR_CONFIDENCE, 2);
});

test("confidence outside the range is clamped, and nonsense is dropped", async () => {
  const ledger = [evidence("e1"), evidence("e2")];
  const high = await decide(
    scriptedReasoner([reply({ verdict: "conclude", reason: "r", evidenceIds: ["e1", "e2"], confidence: 42, answer: "a" })]),
    decisionInput(ledger)
  );
  assert.equal(high.decision.confidence, 1);

  const nonsense = await decide(
    scriptedReasoner([reply({ verdict: "conclude", reason: "r", evidenceIds: ["e1", "e2"], confidence: "very sure", answer: "a" })]),
    decisionInput(ledger)
  );
  assert.equal(nonsense.decision.confidence, null);
});

test("an invented URL in the answer is removed before the user sees it", async () => {
  const ledger = [evidence("e1", { urls: ["https://real.test/a"] }), evidence("e2")];
  const outcome = await decide(
    scriptedReasoner([
      reply({
        verdict: "conclude",
        reason: "sourced",
        evidenceIds: ["e1", "e2"],
        answer: "Reported at https://fake-news.test/story and https://real.test/a",
      }),
    ]),
    decisionInput(ledger)
  );

  assert.ok(!outcome.decision.answer?.includes("fake-news.test"));
  assert.ok(outcome.decision.answer?.includes("https://real.test/a"));
});

test("investigating with no runnable calls does not spin the loop", async () => {
  const outcome = await decide(
    scriptedReasoner([reply({ verdict: "investigate", reason: "look into it", calls: [] })]),
    decisionInput([evidence("e1")])
  );
  assert.equal(outcome.decision.verdict, "insufficient_evidence");
});

test("a verdict outside the vocabulary is refused", async () => {
  const outcome = await decide(
    scriptedReasoner([reply({ verdict: "definitely_buy", reason: "trust me" })]),
    decisionInput([evidence("e1")])
  );
  assert.equal(outcome.decision.verdict, "insufficient_evidence");
  assert.equal(outcome.malformed, "unknown_verdict");
});

/* ------------------------------------------------------- Execution layer */

test("a call needing approval never reaches the tool", async () => {
  const runner = stubRunner({ defend_position: { __acted: true } });
  const outcome = await executeCall(runner, "defend_position", {}, { mode: "auto_low_risk" });

  assert.equal(outcome.blocked, "needs_approval");
  assert.equal(runner.calls.length, 0);
});

test("a tool returning an error is not retried", async () => {
  let calls = 0;
  const runner = stubRunner({
    get_price: () => {
      calls++;
      return { error: "No data for XYZ." };
    },
  });

  const outcome = await executeCall(runner, "get_price", {}, { mode: "auto_low_risk" });

  assert.equal(calls, 1, "the tool answered; asking again bills twice for the same answer");
  assert.equal(outcome.ok, false);
});

test("a tool that declares an action but errors did not act", async () => {
  const runner = stubRunner({ send_chart: { __acted: true, error: "could not deliver" } });
  const outcome = await executeCall(runner, "send_chart", {}, { mode: "auto_low_risk" });

  assert.equal(outcome.acted, false, "an action that failed changed nothing");
  assert.equal(outcome.ok, false);
});

test("a hanging tool is abandoned rather than blocking the mission", async () => {
  const hanging = (async () => new Promise(() => {})) as never;
  const outcome = await executeCall(hanging, "get_price", {}, { mode: "auto_low_risk", timeoutMs: 30, maxAttempts: 1 });

  assert.equal(outcome.ok, false);
  assert.match(String((outcome.result as { error: string }).error), /timed out/);
});

test("fingerprints ignore key order but not values", () => {
  assert.equal(callFingerprint("t", { a: 1, b: 2 }), callFingerprint("t", { b: 2, a: 1 }));
  assert.notEqual(callFingerprint("t", { a: 1 }), callFingerprint("t", { a: 2 }));
});

test("truncation is marked so a cut list is not read as complete", () => {
  const long = "x".repeat(LIMITS.evidenceChars + 100);
  assert.ok(truncate(long).includes("truncated"));
  assert.equal(truncate("short"), "short");
});

test("withTimeout resolves the value when work finishes in time", async () => {
  const result = await withTimeout(Promise.resolve(42), 1000, "test");
  assert.deepEqual(result, { ok: true, value: 42 });
});

/* ------------------------------------------------------------ Verification */

test("a tool with no verifier is reported unverified", async () => {
  const verification = await verifyAction("get_price", {}, { symbol: "NVDA" }, stubRunner({}));
  assert.equal(verification.verified, false);
  assert.match(verification.detail, /no independent check/);
});

test("an errored result is never verified, whatever the verifier would say", async () => {
  const verification = await verifyAction("send_chart", {}, { error: "nope" }, stubRunner({}));
  assert.equal(verification.verified, false);
});

test("alert scope is confirmed by reading it back, and disagreement fails", async () => {
  const agreeing = stubRunner({ get_alert_status: { scope: "0xabc" } });
  const ok = await verifyAction("set_alert_scope", { address: "0xABC" }, { scope: "0xabc" }, agreeing);
  assert.equal(ok.verified, true);

  const disagreeing = stubRunner({ get_alert_status: { scope: "chain-wide" } });
  const bad = await verifyAction("set_alert_scope", { address: "0xABC" }, { scope: "0xabc" }, disagreeing);
  assert.equal(bad.verified, false, "the write claimed one thing and the read another");
});

test("a verifier that throws fails closed", async () => {
  const throwing = (async () => {
    throw new Error("rpc down");
  }) as never;
  const verification = await verifyAction("set_alert_scope", { address: null }, { scope: "chain-wide" }, throwing);
  assert.equal(verification.verified, false);
});
