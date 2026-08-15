import test from "node:test";
import assert from "node:assert/strict";

import { describeSpend, usageFrom, type SpendToday } from "../lib/spend";

/**
 * The daily model ceiling.
 *
 * Until missions ran on a timer, spend was bounded by a person having to ask.
 * These cover the two things that keeps honest: counting a call whose provider
 * reported nothing, and never inventing a price.
 */

test("reported usage is believed", () => {
  assert.deepEqual(usageFrom({ usage: { prompt_tokens: 1200, completion_tokens: 300 } }, 0, 0), {
    promptTokens: 1200,
    completionTokens: 300,
  });
});

test("the other spelling of the same field is understood", () => {
  assert.deepEqual(usageFrom({ usage: { input_tokens: 10, output_tokens: 5 } }, 0, 0), {
    promptTokens: 10,
    completionTokens: 5,
  });
});

test("a provider that reports nothing is still counted", () => {
  // Otherwise the cheapest way past a ceiling is to route everything through
  // the one gateway the meter cannot see.
  const usage = usageFrom({}, 4000, 800);
  assert.equal(usage.promptTokens, 1000);
  assert.equal(usage.completionTokens, 200);
});

test("a malformed usage block falls back to measuring rather than to zero", () => {
  for (const json of [null, {}, { usage: null }, { usage: { prompt_tokens: "lots" } }, { usage: { prompt_tokens: 0, completion_tokens: 0 } }]) {
    const usage = usageFrom(json, 400, 400);
    assert.equal(usage.promptTokens + usage.completionTokens, 200, JSON.stringify(json));
  }
});

/* -------------------------------------------------------------- Report */

const spend: SpendToday = { day: "2026-08-16", tokens: 1_234_567, calls: 890, shared: true };

test("the report states tokens and calls, and no price", () => {
  delete process.env.VELTR_USD_PER_MTOK;
  const text = describeSpend(spend);

  assert.match(text, /1,234,567 tokens across 890 calls/);
  assert.ok(!text.includes("$"), "a dollar figure here would have to be invented, and would be believed");
});

test("a price appears only when one was configured, and says it is an estimate", () => {
  process.env.VELTR_USD_PER_MTOK = "3";
  try {
    const text = describeSpend(spend);
    assert.match(text, /\$3\.70/, "1.234567M tokens at $3/M");
    assert.match(text, /estimate/);
  } finally {
    delete process.env.VELTR_USD_PER_MTOK;
  }
});

test("a report from an instance counting alone says so", () => {
  // Two replicas each counting privately both stay under a shared ceiling that
  // has already been passed; the report must not imply otherwise.
  assert.match(describeSpend({ ...spend, shared: false }), /this instance only/);
});
