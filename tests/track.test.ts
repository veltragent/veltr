import test from "node:test";
import assert from "node:assert/strict";

import {
  describeChange,
  fingerprintPage,
  parseCommits,
  parseTarget,
  readableText,
  stripVolatile,
  type Signal,
} from "../lib/track/signals";
import { isDue, runTrackCycle, type TrackDeps } from "../lib/track/engine";
import { MAX_FAILURES, type Track } from "../lib/track/store";

/**
 * Change monitoring.
 *
 * The one property everything else serves: a notification requires a genuinely
 * different fingerprint. Not a new timestamp on the same page, not a rephrasing,
 * and never the first reading.
 */

/* ----------------------------------------------------------- Targets */

test("a target is read from what someone would type", () => {
  assert.deepEqual(parseTarget("vercel/next.js"), { kind: "repo", ref: "vercel/next.js" });
  assert.deepEqual(parseTarget("https://example.com/blog"), { kind: "page", ref: "https://example.com/blog" });
  assert.deepEqual(parseTarget("  vercel/swr  "), { kind: "repo", ref: "vercel/swr" });
});

test("a GitHub URL is a repository, not a page", () => {
  // The rendered HTML changes with every CI badge and star count; the commit
  // feed is the signal.
  assert.deepEqual(parseTarget("https://github.com/vercel/swr"), { kind: "repo", ref: "vercel/swr" });
  assert.deepEqual(parseTarget("https://github.com/vercel/swr.git"), { kind: "repo", ref: "vercel/swr" });
  assert.deepEqual(parseTarget("https://github.com/vercel/swr/"), { kind: "repo", ref: "vercel/swr" });
});

test("something that is neither is refused", () => {
  for (const bad of ["", "   ", "just some words", "ftp://x.test", "one/two/three"]) {
    assert.equal(parseTarget(bad), null, bad);
  }
});

/* ------------------------------------------------------- Page fingerprints */

test("markup and scripts do not count as content", () => {
  const text = readableText(
    `<html><head><style>.a{color:red}</style><script>var t=Date.now()</script></head>
     <body><!-- build 8821 --><h1>Hello</h1><p>World</p></body></html>`
  );
  assert.equal(text, "Hello World");
});

test("a page whose only change is its clock has not changed", () => {
  // This is the whole reason stripVolatile exists: without it every page with a
  // timestamp notifies on every poll, which is the same as having no filter.
  const a = fingerprintPage("<p>Updated 14:05:11 — 3 minutes ago</p><p>Price is 226</p>");
  const b = fingerprintPage("<p>Updated 14:09:52 — 7 minutes ago</p><p>Price is 226</p>");
  assert.equal(a.fingerprint, b.fingerprint);
});

test("an ISO timestamp is also ignored", () => {
  const a = fingerprintPage("<p>2026-08-15T10:00:00Z</p><p>Body</p>");
  const b = fingerprintPage("<p>2026-08-15T11:30:00Z</p><p>Body</p>");
  assert.equal(a.fingerprint, b.fingerprint);
});

test("a real edit does change the fingerprint", () => {
  const a = fingerprintPage("<p>The price is 226</p>");
  const b = fingerprintPage("<p>The price is 231</p>");
  assert.notEqual(a.fingerprint, b.fingerprint);
});

test("whitespace and markup churn alone do not", () => {
  const a = fingerprintPage("<div><p>Hello   World</p></div>");
  const b = fingerprintPage("<section>\n  <p>Hello World</p>\n</section>");
  assert.equal(a.fingerprint, b.fingerprint);
});

test("stripVolatile leaves ordinary numbers alone", () => {
  assert.match(stripVolatile("liquidity 1401755 usd"), /1401755/);
});

/* ------------------------------------------------------------- Commits */

test("commits are reduced to the subject line", () => {
  const commits = parseCommits([
    {
      sha: "abcdef1234567890",
      commit: { message: "fix: stop double-sending alerts\n\nLong body that nobody wants in a notification.", author: { name: "Dimas", date: "2026-08-15T10:00:00Z" } },
      author: { login: "dimxbt" },
    },
  ]);

  assert.equal(commits[0].sha, "abcdef1");
  assert.equal(commits[0].message, "fix: stop double-sending alerts");
  assert.equal(commits[0].author, "dimxbt");
});

test("a malformed commit payload yields nothing rather than throwing", () => {
  assert.deepEqual(parseCommits(null), []);
  assert.deepEqual(parseCommits({ message: "not an array" }), []);
  assert.equal(parseCommits([{}])[0].message, "");
});

/* ---------------------------------------------------------- Descriptions */

test("a change is described from facts, not from a model", () => {
  const before: Signal = { fingerprint: "a", summary: "at 111", facts: { stars: 100 } };
  const after: Signal = { fingerprint: "b", summary: "at 222", facts: { stars: 103 }, detail: "222 new feature" };

  const text = describeChange({ kind: "repo", ref: "a/b" }, before, after);
  assert.match(text, /222 new feature/);
  assert.match(text, /Stars \+3/);
});

test("a page change reports the direction of the edit", () => {
  const grew = describeChange(
    { kind: "page", ref: "https://x.test" },
    { fingerprint: "a", summary: "", facts: { length: 1000 } },
    { fingerprint: "b", summary: "", facts: { length: 1200 } }
  );
  assert.match(grew, /grew by 200/);

  const same = describeChange(
    { kind: "page", ref: "https://x.test" },
    { fingerprint: "a", summary: "", facts: { length: 1000 } },
    { fingerprint: "b", summary: "", facts: { length: 1000 } }
  );
  assert.match(same, /reworded/);
});

/* -------------------------------------------------------------- Engine */

function track(overrides: Partial<Track> = {}): Track {
  return {
    id: "t1",
    userId: "111",
    kind: "repo",
    ref: "vercel/swr",
    fingerprint: null,
    lastSummary: null,
    lastFacts: {},
    lastCheckedAt: null,
    lastChangedAt: null,
    failures: 0,
    intervalSec: 900,
    enabled: true,
    createdAt: "2026-08-15T00:00:00.000Z",
    ...overrides,
  };
}

function harness(options: { tracks: Track[]; signal: Signal | { error: string } }) {
  const sent: { userId: string; text: string }[] = [];
  const persisted: Track[] = [];
  let fetches = 0;

  const deps: Partial<TrackDeps> = {
    loadTracks: async () => options.tracks,
    read: async () => {
      fetches++;
      return "error" in options.signal
        ? { ok: false as const, error: options.signal.error }
        : { ok: true as const, signal: options.signal };
    },
    persist: async (updated) => void persisted.push(...updated),
    send: async (userId, text) => {
      sent.push({ userId, text });
      return true;
    },
    now: () => new Date("2026-08-15T12:00:00.000Z"),
  };

  return { deps, sent, persisted, fetchCount: () => fetches };
}

const SIGNAL: Signal = { fingerprint: "aaa", summary: "at 111 — first", facts: { head: "111" } };

test("the first reading establishes a baseline and notifies nobody", async () => {
  const h = harness({ tracks: [track()], signal: SIGNAL });
  const report = await runTrackCycle(h.deps);

  assert.equal(report.changed, 0);
  assert.deepEqual(h.sent, [], "a target you just started watching has not changed");
  assert.equal(h.persisted[0].fingerprint, "aaa");
});

test("an unchanged fingerprint notifies nobody", async () => {
  const h = harness({ tracks: [track({ fingerprint: "aaa", lastCheckedAt: null })], signal: SIGNAL });
  const report = await runTrackCycle(h.deps);

  assert.equal(report.changed, 0);
  assert.deepEqual(h.sent, []);
});

test("a changed fingerprint notifies exactly once", async () => {
  const h = harness({
    tracks: [track({ fingerprint: "old", lastSummary: "at 000" })],
    signal: { ...SIGNAL, detail: "111 fix the thing" },
  });

  const report = await runTrackCycle(h.deps);

  assert.equal(report.changed, 1);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].text, /Repository changed/);
  assert.match(h.sent[0].text, /111 fix the thing/);
  assert.match(h.sent[0].text, /vercel\/swr/);
  assert.equal(h.persisted[0].lastChangedAt, "2026-08-15T12:00:00.000Z");
});

test("two people tracking the same target cost one fetch and get one alert each", async () => {
  const h = harness({
    tracks: [
      track({ id: "a", userId: "111", fingerprint: "old" }),
      track({ id: "b", userId: "222", fingerprint: "old" }),
    ],
    signal: SIGNAL,
  });

  await runTrackCycle(h.deps);

  assert.equal(h.fetchCount(), 1, "the reading is a property of the target, not the watcher");
  assert.deepEqual(h.sent.map((s) => s.userId).sort(), ["111", "222"]);
});

test("a user who is already up to date is not told about someone else's change", async () => {
  const h = harness({
    tracks: [
      track({ id: "a", userId: "111", fingerprint: "old" }),
      track({ id: "b", userId: "222", fingerprint: "aaa" }),
    ],
    signal: SIGNAL,
  });

  await runTrackCycle(h.deps);

  assert.deepEqual(h.sent.map((s) => s.userId), ["111"]);
});

test("a failing target backs off and is eventually paused", async () => {
  const h = harness({
    tracks: [track({ fingerprint: "old", failures: MAX_FAILURES - 1 })],
    signal: { error: "HTTP 404" },
  });

  const report = await runTrackCycle(h.deps);

  assert.equal(report.failed, 1);
  assert.equal(report.paused, 1);
  assert.equal(h.persisted[0].enabled, false, "a deleted repo must not be fetched forever");
  assert.deepEqual(h.sent, [], "and the user is not told about it every cycle");
});

test("a failure does not overwrite the last good fingerprint", async () => {
  const h = harness({ tracks: [track({ fingerprint: "old" })], signal: { error: "timed out" } });
  await runTrackCycle(h.deps);

  assert.equal(h.persisted[0].fingerprint, "old", "otherwise the next success would look like a change");
});

test("a recovered target has its failure count cleared", async () => {
  const h = harness({ tracks: [track({ fingerprint: "aaa", failures: 3 })], signal: SIGNAL });
  await runTrackCycle(h.deps);
  assert.equal(h.persisted[0].failures, 0);
});

test("a paused track is never fetched", async () => {
  const h = harness({ tracks: [track({ enabled: false })], signal: SIGNAL });
  const report = await runTrackCycle(h.deps);

  assert.equal(report.due, 0);
  assert.equal(h.fetchCount(), 0);
});

test("only tracks whose interval has elapsed are due", () => {
  const now = new Date("2026-08-15T12:00:00.000Z");
  assert.equal(isDue(track({ lastCheckedAt: null }), now), true);
  assert.equal(isDue(track({ lastCheckedAt: "2026-08-15T11:59:00.000Z" }), now), false);
  assert.equal(isDue(track({ lastCheckedAt: "2026-08-15T11:40:00.000Z" }), now), true);
  assert.equal(isDue(track({ lastCheckedAt: "2027-01-01T00:00:00.000Z" }), now), true, "a backwards clock");
});
