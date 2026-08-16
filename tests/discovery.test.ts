import test from "node:test";
import assert from "node:assert/strict";

/**
 * Stock-token discovery under a throttled node.
 *
 * The defect: the probe reports only what answered, so a call the node dropped
 * is indistinguishable from a contract that is not a stock token. A throttled
 * pass returned 44 of the chain's 95 tokens, the guard — reject an empty set —
 * was satisfied by 44, and the site served two fifths of the chain for the full
 * thirty-minute cache window with nothing reporting a fault.
 */

type Probe = { found: { address: string; uiMultiplier: bigint }[]; checked: number; failed: number };

/**
 * The rule under test, isolated from the RPC.
 *
 * Mirrors lib/tokens.ts: union what a probe confirms into everything already
 * confirmed, and treat a pass with unanswered calls as unfit to cache.
 */
function discover(known: Map<string, bigint>, probe: Probe) {
  for (const f of probe.found) known.set(f.address.toLowerCase(), f.uiMultiplier);
  return { tokens: new Map(known), complete: probe.failed === 0 };
}

const cacheable = (r: { complete: boolean; tokens: Map<string, bigint> }) => r.complete && r.tokens.size > 0;

const probe = (addresses: string[], failed = 0, checked = addresses.length): Probe => ({
  found: addresses.map((address) => ({ address, uiMultiplier: 10n ** 18n })),
  checked,
  failed,
});

test("a complete probe is cacheable", () => {
  const r = discover(new Map(), probe(["0xa", "0xb", "0xc"]));
  assert.equal(r.tokens.size, 3);
  assert.equal(cacheable(r), true);
});

test("a partial probe is never cached, however many it found", () => {
  // 44 of 95 satisfied the old guard. Size is not evidence of completeness.
  const found = Array.from({ length: 44 }, (_, i) => `0x${i}`);
  const r = discover(new Map(), probe(found, 51, 95));
  assert.equal(r.tokens.size, 44);
  assert.equal(cacheable(r), false, "it answers this call, but it does not become the answer");
});

test("a partial probe never shrinks what is already known", () => {
  // The property that makes a short answer safe: a contract that answered
  // uiMultiplier() once will answer it again, so a probe can only be missing
  // tokens — it cannot disprove them.
  const known = new Map<string, bigint>();
  discover(known, probe(["0xa", "0xb", "0xc", "0xd"]));

  const degraded = discover(known, probe(["0xa"], 3, 4));
  assert.equal(degraded.tokens.size, 4, "the three it failed to reach are still there");
  assert.equal(cacheable(degraded), false);
});

test("a partial probe still contributes what it did find", () => {
  const known = new Map<string, bigint>();
  discover(known, probe(["0xa", "0xb"]));
  const next = discover(known, probe(["0xc"], 2, 3));

  assert.deepEqual([...next.tokens.keys()].sort(), ["0xa", "0xb", "0xc"]);
});

test("recovery restores a cacheable answer without losing anything", () => {
  const known = new Map<string, bigint>();
  discover(known, probe(["0xa", "0xb", "0xc"]));
  discover(known, probe(["0xa"], 2, 3));

  const recovered = discover(known, probe(["0xa", "0xb", "0xc", "0xd"]));
  assert.equal(recovered.tokens.size, 4);
  assert.equal(cacheable(recovered), true);
});

test("an empty result is still refused", () => {
  // The original guard, kept: a probe that found nothing is a failure, not a
  // chain without stock tokens.
  assert.equal(cacheable(discover(new Map(), probe([]))), false);
});

test("addresses are matched case-insensitively", () => {
  const known = new Map<string, bigint>();
  discover(known, probe(["0xAbC"]));
  discover(known, probe(["0xabc"]));
  assert.equal(known.size, 1, "one contract, however the explorer capitalised it");
});
