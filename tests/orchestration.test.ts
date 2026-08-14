import test from "node:test";
import assert from "node:assert/strict";

import {
  CallMemo,
  classifyDepth,
  compressHistory,
  partitionCalls,
  transcriptSize,
  OLDER_RESULT_CHARS,
  RECENT_RESULT_CHARS,
} from "../lib/agent/orchestration";
import type { ChatMessage } from "../lib/llm";

/** Orchestration: how much budget a request gets, and what it costs to run. */

/* ----------------------------------------------------------- Depth */

test("a trivial message gets a small budget", () => {
  for (const text of ["hi", "thanks", "makasih", "2 + 2", "ok"]) {
    assert.equal(classifyDepth(text).depth, "fast", text);
  }
  assert.equal(classifyDepth("hi").maxRounds, 2);
});

test("an ordinary question gets the normal budget", () => {
  for (const text of ["what is NVDA trading at", "show me the AAPL chart", "berapa harga ETH"]) {
    assert.equal(classifyDepth(text).depth, "normal", text);
  }
  assert.equal(classifyDepth("what is NVDA trading at").maxRounds, 5);
});

test("work that needs a chain of reads gets room to finish it", () => {
  for (const text of [
    "inspect this repository and explain the architecture",
    "investigate why this feature might be failing in the codebase",
    "audit the repo for security issues and race conditions",
  ]) {
    const plan = classifyDepth(text);
    assert.equal(plan.depth, "deep", text);
    assert.ok(plan.maxRounds > 5, "five rounds truncates the answer, not the cost");
  }
});

test("an attachment lifts a request above trivial", () => {
  // "ok" with a file attached means "act on the file", not "acknowledged".
  assert.equal(classifyDepth("ok", { hasAttachment: true }).depth, "normal");
  assert.equal(classifyDepth("explain why this fails", { hasAttachment: true }).depth, "deep");
});

test("a long request is not treated as a lookup", () => {
  const long = "explain how the watcher decides that a corporate action has been scheduled, " +
    "and what happens to the subscribers when the multiplier moves before the effective timestamp";
  assert.equal(classifyDepth(long).depth, "deep");
});

/* ------------------------------------------------- Call partitioning */

const call = (name: string, args: Record<string, unknown> = {}) => ({ id: `c-${name}`, name, args });

test("reads are parallelisable, actions are not", () => {
  const { reads, acts } = partitionCalls(
    [call("get_price"), call("send_chart"), call("get_news"), call("set_alert_scope")],
    new Set(["send_chart", "set_alert_scope"])
  );

  assert.deepEqual(reads.map((c) => c.name), ["get_price", "get_news"]);
  assert.deepEqual(acts.map((c) => c.name), ["send_chart", "set_alert_scope"]);
});

test("an unknown tool is treated as a read, matching the loop's own default", () => {
  const { reads } = partitionCalls([call("something_new")], new Set());
  assert.equal(reads.length, 1);
});

test("action order is preserved so two writes cannot race", () => {
  const { acts } = partitionCalls(
    [call("set_alert_scope", { address: "0xa" }), call("set_alert_scope", { address: null })],
    new Set(["set_alert_scope"])
  );
  assert.deepEqual(acts.map((c) => c.args.address), ["0xa", null]);
});

/* ------------------------------------------------------ Deduplication */

test("the same call is remembered, a different one is not", () => {
  const memo = new CallMemo();
  memo.remember("github_read_file", { path: "a.ts" }, { content: "x" });

  assert.deepEqual(memo.get("github_read_file", { path: "a.ts" }), { content: "x" });
  assert.equal(memo.get("github_read_file", { path: "b.ts" }), undefined);
  assert.equal(memo.get("get_price", { path: "a.ts" }), undefined);
});

test("argument order does not create a second identity", () => {
  const memo = new CallMemo();
  memo.remember("t", { a: 1, b: 2 }, "cached");
  assert.equal(memo.get("t", { b: 2, a: 1 }), "cached");
});

test("a remembered undefined would be indistinguishable from a miss", () => {
  const memo = new CallMemo();
  memo.remember("t", {}, null);
  assert.equal(memo.get("t", {}), null, "null is a real cached value; undefined means not cached");
});

/* ------------------------------------------------- Context compression */

const toolMessage = (content: string): ChatMessage => ({
  role: "tool",
  tool_call_id: "x",
  content,
});

test("the most recent tool result is left intact", () => {
  const messages: ChatMessage[] = [
    { role: "user", content: "q" },
    toolMessage("a".repeat(20_000)),
    toolMessage("b".repeat(20_000)),
  ];

  const compressed = compressHistory(messages);

  assert.ok(compressed[2].content!.length > OLDER_RESULT_CHARS * 2, "the current round is what it reasons about");
  assert.ok(compressed[2].content!.length <= RECENT_RESULT_CHARS + 60);
  assert.ok(compressed[1].content!.length <= OLDER_RESULT_CHARS + 60, "the older one is shrunk");
});

test("compression marks what it cut, so a truncated list is not read as complete", () => {
  const compressed = compressHistory([toolMessage("x".repeat(50_000)), toolMessage("y")]);
  assert.match(compressed[0].content!, /truncated/);
});

test("short results are untouched", () => {
  const messages = [toolMessage("{}"), toolMessage("{}")];
  const compressed = compressHistory(messages);
  assert.equal(compressed[0].content, "{}");
  assert.equal(compressed[1].content, "{}");
});

test("non-tool messages are never compressed", () => {
  const system = "s".repeat(30_000);
  const compressed = compressHistory([
    { role: "system", content: system },
    toolMessage("t".repeat(30_000)),
  ]);
  assert.equal(compressed[0].content, system, "the instructions are not optional context");
});

test("compression does not mutate the transcript it was given", () => {
  const original = toolMessage("z".repeat(30_000));
  const messages = [original, toolMessage("y")];
  const before = original.content;

  compressHistory(messages);

  assert.equal(original.content, before, "a compression bug must not destroy the conversation");
});

test("compression measurably reduces a repository-sized transcript", () => {
  // A 24,000-character source file carried across four rounds is the case this
  // exists for.
  const messages: ChatMessage[] = [
    { role: "system", content: "s" },
    toolMessage("f".repeat(24_000)),
    toolMessage("g".repeat(24_000)),
    toolMessage("h".repeat(24_000)),
    toolMessage("i".repeat(4_000)),
  ];

  const before = transcriptSize(messages);
  const after = transcriptSize(compressHistory(messages));

  assert.ok(after < before / 3, `expected a large reduction, got ${before} → ${after}`);
});

test("a transcript with no tool results is returned unchanged", () => {
  const messages: ChatMessage[] = [{ role: "user", content: "hello" }];
  assert.equal(compressHistory(messages), messages);
});
