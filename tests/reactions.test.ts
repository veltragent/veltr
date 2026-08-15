import test from "node:test";
import assert from "node:assert/strict";

import {
  reactionFor,
  reactionDelayMs,
  MAX_REACTION_DELAY_MS,
  FILE_RECEIVED_EMOJI,
} from "../lib/reactions";

/** The auto-reaction: which emoji, and how long before it lands. */

function withEnv<T>(vars: Record<string, string | undefined>, run: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** No env set: the delay must fall inside the documented default band. */
const clean = { VELTR_REACT_DELAY_MS: undefined, VELTR_REACT_JITTER_MS: undefined };

test("by default the reaction is instant", () => {
  withEnv(clean, () => {
    // It goes out when the message is read, before any work on the reply — so
    // no amount of jitter may reintroduce a pause.
    assert.equal(reactionDelayMs(() => 0), 0);
    assert.equal(reactionDelayMs(() => 0.5), 0);
    assert.equal(reactionDelayMs(() => 1), 0, "jitter must not creep in on top of zero");
  });
});

test("a pause can be asked for, and jitter spreads it", () => {
  withEnv({ VELTR_REACT_DELAY_MS: "500" }, () => {
    assert.equal(reactionDelayMs(() => 0), 500, "the floor of the band");
    assert.equal(reactionDelayMs(() => 1), 1200, "the ceiling of the band");

    const samples = new Set(Array.from({ length: 20 }, (_, i) => reactionDelayMs(() => i / 20)));
    assert.ok(samples.size > 1, "a fixed pause is a metronome, which is the tell being avoided");
  });
});

test("jitter can be switched off for a fixed pause", () => {
  withEnv({ VELTR_REACT_DELAY_MS: "300", VELTR_REACT_JITTER_MS: "0" }, () => {
    assert.equal(reactionDelayMs(() => 0.9), 300);
  });
});

test("a delay outliving the reply is clamped", () => {
  withEnv({ VELTR_REACT_DELAY_MS: "600000" }, () => {
    assert.ok(reactionDelayMs(() => 1) <= MAX_REACTION_DELAY_MS);
  });
});

test("a malformed setting falls back to the default rather than inventing a pause", () => {
  for (const bad of ["abc", "-100", "NaN", ""]) {
    withEnv({ VELTR_REACT_DELAY_MS: bad, VELTR_REACT_JITTER_MS: "0" }, () => {
      assert.equal(reactionDelayMs(() => 0), 0, `"${bad}" must not silently change the behaviour`);
    });
  }
});

/* --------------------------------------------------------------- Emoji */

test("the reaction reflects what was understood, not merely receipt", () => {
  assert.equal(reactionFor("show me the AAPL chart"), "👀");
  assert.equal(reactionFor("what is NVDA trading at"), "💯");
  assert.equal(reactionFor("why is ETH moving"), "🤔");
  assert.equal(reactionFor("find the latest news on it"), "🤓");
  assert.equal(reactionFor("hi"), "🤝");
});

test("an unmatched message still gets something that does not look like an error", () => {
  assert.equal(reactionFor(""), "👀");
  assert.equal(reactionFor("zzzz"), "👀");
  assert.equal(FILE_RECEIVED_EMOJI, "👀");
});
