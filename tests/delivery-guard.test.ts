import test from "node:test";
import assert from "node:assert/strict";

import { claimsFileDelivery, deliveredFilename, reconcileFileClaims } from "../lib/delivery-guard";

/**
 * The guard that stopped the bot claiming it had sent files it never sent.
 *
 * The two strings below are verbatim from the conversation that exposed the bug,
 * so a regression reproduces the exact failure rather than an approximation.
 */

const REPORTED_1 = "Sudah, file **index.html** versi premium terminal UI dan demo mode sudah dibuat.";
const REPORTED_2 = "Dim, sudah—file **dika-rezz-premium-console.html** telah dibuat dan dikirim.";

test("the claims that started this are detected", () => {
  const first = claimsFileDelivery(REPORTED_1);
  assert.equal(first.claimed, true);
  assert.equal(first.filename, "index.html");

  const second = claimsFileDelivery(REPORTED_2);
  assert.equal(second.claimed, true);
  assert.equal(second.filename, "dika-rezz-premium-console.html");
});

test("English completion claims are detected", () => {
  for (const text of [
    "Your file report.md has been created and sent.",
    "I've generated the file and attached it.",
    "Done — I created the file index.html for you.",
    "The file is ready and attached.",
  ]) {
    assert.equal(claimsFileDelivery(text).claimed, true, text);
  }
});

test("an offer is not a claim", () => {
  for (const text of [
    "I can build you an HTML page — want me to?",
    "Shall I write that to a file?",
    "Mau saya buatkan file HTML-nya?",
    "I will create index.html once you confirm the layout.",
  ]) {
    assert.equal(claimsFileDelivery(text).claimed, false, text);
  }
});

test("a completion claim about something other than a file is not flagged", () => {
  // These are true statements about real, verified actions elsewhere in the bot.
  for (const text of [
    "Your alert scope has been created.",
    "Watch sudah dibuat untuk token itu.",
    "The position has been closed.",
  ]) {
    assert.equal(claimsFileDelivery(text).claimed, false, text);
  }
});

test("a filename mentioned in passing is not a claim", () => {
  const check = claimsFileDelivery("Send me your index.html and I will review it.");
  assert.equal(check.claimed, false);
  assert.equal(check.filename, "index.html", "the name is still read, for recovery");
});

test("a version number is not a filename", () => {
  assert.equal(claimsFileDelivery("Market cap has been created at 3.5 million.").filename, null);
});

test("Indonesian clitics do not hide the noun", () => {
  // "filenya" and "dokumennya" are the ordinary forms; a closing word boundary
  // misses both, which is how the first version of this guard let a claim past.
  for (const text of ["Filenya sudah dikirim.", "Dokumennya sudah dibuat.", "Berkasnya sudah jadi."]) {
    assert.equal(claimsFileDelivery(text).claimed, true, text);
  }
});

/* ------------------------------------------------------- deliveredFilename */

test("delivery is read from the result, never from the request", () => {
  assert.equal(deliveredFilename({ sent: true, filename: "index.html" }), "index.html");
  assert.equal(deliveredFilename({ sent: true, filename: "a.md", error: "nope" }), null, "an error is not a delivery");
  assert.equal(deliveredFilename({ filename: "index.html" }), null, "a name without sent is not a delivery");
  assert.equal(deliveredFilename({ error: "could not deliver" }), null);
  assert.equal(deliveredFilename(null), null);
  assert.equal(deliveredFilename("sent"), null);
});

/* --------------------------------------------------------- Reconciliation */

const noStore = { getGenerated: () => null, sendDocument: async () => true };

test("a supported claim passes through untouched", async () => {
  const result = await reconcileFileClaims(REPORTED_1, "111", ["index.html"], noStore);

  assert.equal(result.answer, REPORTED_1);
  assert.equal(result.corrected, false);
  assert.equal(result.recovered, null);
});

test("an answer that claims nothing is untouched even with nothing delivered", async () => {
  const text = "NVDA trades at $226.06, about 0.34% above its last close.";
  const result = await reconcileFileClaims(text, "111", [], noStore);

  assert.equal(result.answer, text);
  assert.equal(result.corrected, false);
});

test("an unsupported claim is contradicted in the same message", async () => {
  const result = await reconcileFileClaims(REPORTED_2, "111", [], noStore);

  assert.equal(result.corrected, true);
  assert.match(result.answer, /no file was actually sent/i);
  assert.ok(result.answer.startsWith(REPORTED_2), "the original is kept so the correction reads as one");
});

test("content that exists is delivered, making the claim true", async () => {
  const sent: { filename: string; content: string }[] = [];
  const result = await reconcileFileClaims(REPORTED_1, "111", [], {
    getGenerated: () => ({ content: "<!doctype html><title>x</title>", language: "html" }),
    sendDocument: async (_chat, filename, content) => {
      sent.push({ filename, content });
      return true;
    },
  });

  assert.equal(result.recovered, "index.html", "the name the answer promised");
  assert.equal(result.corrected, false, "the claim became true, so it needs no correction");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].filename, "index.html");
});

test("recovery falls back to a sensible name when the answer named none", async () => {
  const result = await reconcileFileClaims("Sudah dibuat, dokumennya sudah dikirim.", "111", [], {
    getGenerated: () => ({ content: "<html></html>", language: "html" }),
    sendDocument: async () => true,
  });

  assert.equal(result.recovered, "index.html");
});

test("a failed recovery falls back to correcting, never to silence", async () => {
  const result = await reconcileFileClaims(REPORTED_1, "111", [], {
    getGenerated: () => ({ content: "<html></html>", language: "html" }),
    sendDocument: async () => false,
  });

  assert.equal(result.recovered, null);
  assert.equal(result.corrected, true);
  assert.match(result.answer, /no file was actually sent/i);
});

test("no chat to recover into still yields a correction", async () => {
  const result = await reconcileFileClaims(REPORTED_1, null, [], noStore);
  assert.equal(result.corrected, true);
});
