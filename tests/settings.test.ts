import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SETTINGS,
  formatFieldValue,
  normaliseSettings,
  parseNumericInput,
  validateField,
  MIN_INTERVAL_SEC,
} from "../lib/watch/settings";
import { parseCallback } from "../lib/watch/keyboard";

/** Settings parsing, validation and the callback vocabulary behind the buttons. */

test("the documented defaults are what a new user gets", () => {
  assert.equal(DEFAULT_SETTINGS.priceUpPct, 10);
  assert.equal(DEFAULT_SETTINGS.priceDownPct, 10);
  assert.equal(DEFAULT_SETTINGS.marketCapAbove, null);
  assert.equal(DEFAULT_SETTINGS.liquidityBelow, null);
  assert.equal(DEFAULT_SETTINGS.volumeAbove, null);
  assert.equal(DEFAULT_SETTINGS.checkIntervalSec, 30);
  assert.equal(DEFAULT_SETTINGS.alertCooldownSec, 900);
  assert.equal(DEFAULT_SETTINGS.useDexScreener, true);
  assert.equal(DEFAULT_SETTINGS.useGeckoTerminal, true);
});

test("custom values are read the way people write them", () => {
  assert.equal(parseNumericInput("15"), 15);
  assert.equal(parseNumericInput("7.5"), 7.5);
  assert.equal(parseNumericInput("+20%"), 20);
  assert.equal(parseNumericInput("250k"), 250_000);
  assert.equal(parseNumericInput("1.5M"), 1_500_000);
  assert.equal(parseNumericInput("$1,000,000"), 1_000_000);
  assert.equal(parseNumericInput("  12500  "), 12_500);
  assert.equal(parseNumericInput("2b"), 2_000_000_000);
});

test("input that is not a number is rejected rather than coerced", () => {
  for (const bad of ["", "abc", "1e9999x", "--5", "0x10", "1,2,3.4.5", "NaN", "Infinity"]) {
    assert.equal(parseNumericInput(bad), null, `${bad} must not parse`);
  }
});

test("a percentage is stored as a magnitude; the direction is the field", () => {
  assert.deepEqual(validateField("priceDownPct", -10), { ok: true, value: 10 });
  assert.deepEqual(validateField("priceUpPct", 7.5), { ok: true, value: 7.5 });
});

test("thresholds outside a usable range are refused with a reason", () => {
  assert.equal(validateField("priceUpPct", 0).ok, false);
  assert.equal(validateField("marketCapAbove", 0).ok, false, "a zero market cap threshold is meaningless");
  assert.equal(validateField("marketCapAbove", -5).ok, false);
  assert.equal(validateField("checkIntervalSec", 1).ok, false, "below the shared-resource floor");
  assert.deepEqual(validateField("checkIntervalSec", MIN_INTERVAL_SEC), { ok: true, value: 15 });
  assert.equal(validateField("alertCooldownSec", 0).ok, true, "no cooldown is a legitimate choice");
});

test("settings from disk are repaired field by field, never wholesale", () => {
  const restored = normaliseSettings({
    priceUpPct: 5,
    priceDownPct: "nonsense",
    marketCapAbove: null,
    checkIntervalSec: 1,
    useGeckoTerminal: false,
  });

  assert.equal(restored.priceUpPct, 5, "a valid stored value survives");
  assert.equal(restored.priceDownPct, 10, "a corrupt one falls back to the default");
  assert.equal(restored.marketCapAbove, null, "an explicit disable is preserved");
  assert.equal(restored.checkIntervalSec, 30, "an out-of-range interval falls back");
  assert.equal(restored.useGeckoTerminal, false);
});

test("a settings record predating a field gets that field's default", () => {
  const restored = normaliseSettings({ priceUpPct: 25 });
  assert.equal(restored.priceUpPct, 25);
  assert.equal(restored.volumeAbove, null);
  assert.equal(restored.alertCooldownSec, 900);
});

test("disabling every source is repaired rather than stored", () => {
  const restored = normaliseSettings({ useDexScreener: false, useGeckoTerminal: false });
  assert.equal(restored.useDexScreener, true, "no sources means no alerts, silently — never store it");
});

test("settings render the way the panel shows them", () => {
  const settings = normaliseSettings({ priceUpPct: 10, priceDownPct: 10, marketCapAbove: 1_000_000 });
  assert.equal(formatFieldValue("priceUpPct", settings), "+10%");
  assert.equal(formatFieldValue("priceDownPct", settings), "−10%");
  assert.equal(formatFieldValue("marketCapAbove", settings), "$1.00M");
  assert.equal(formatFieldValue("marketCapBelow", settings), "Disabled");
  assert.equal(formatFieldValue("checkIntervalSec", settings), "30s");
  assert.equal(formatFieldValue("alertCooldownSec", settings), "15m");
});

/* ------------------------------------------------------- Callback safety */

test("callback payloads are parsed strictly", () => {
  assert.deepEqual(parseCallback("w:menu"), { kind: "menu" });
  assert.deepEqual(parseCallback("w:s:priceUpPct:20"), { kind: "set", field: "priceUpPct", value: 20 });
  assert.deepEqual(parseCallback("w:s:volumeAbove:off"), { kind: "set", field: "volumeAbove", value: null });
  assert.deepEqual(parseCallback("w:t:gt"), { kind: "toggleSource", source: "gt" });
});

test("a crafted callback cannot reach a field that does not exist", () => {
  assert.equal(parseCallback("w:s:__proto__:1"), null);
  assert.equal(parseCallback("w:s:constructor:1"), null);
  assert.equal(parseCallback("w:f:toString"), null);
  assert.equal(parseCallback("w:s:useDexScreener:0"), null, "booleans are not numeric fields");
});

test("callbacks outside this feature's namespace are ignored", () => {
  assert.equal(parseCallback("reset"), null);
  assert.equal(parseCallback("other:menu"), null);
  assert.equal(parseCallback(""), null);
  assert.equal(parseCallback("w:" + "x".repeat(80)), null, "Telegram caps callback data at 64 bytes");
});

test("an address in a callback must look like an address", () => {
  assert.deepEqual(parseCallback("w:u:0x2E8C31162B855a2FFa90f6F8634643Ad6F111E18"), {
    kind: "unwatch",
    address: "0x2e8c31162b855a2ffa90f6f8634643ad6f111e18",
  });
  assert.equal(parseCallback("w:u:0xnope"), null);
  assert.equal(parseCallback("w:u:../../etc/passwd"), null);
  assert.equal(parseCallback("w:u:"), null);
});

test("a non-finite value in a callback is refused", () => {
  assert.equal(parseCallback("w:s:priceUpPct:NaN"), null);
  assert.equal(parseCallback("w:s:priceUpPct:abc"), null);
});
