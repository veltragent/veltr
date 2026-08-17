import type { DeepScan } from "./scan";
import type { WhyReport } from "./why";
import type { MarketPulse } from "./pulse";
import type { SmartMoneyRead } from "./smart-money";
import type { WalletIntel } from "./wallet";
import type { Overlap } from "./relationships";
import type { Signal } from "./signals";
import { band, type Score } from "./score";

/**
 * Telegram rendering.
 *
 * The brief asked for concise cards, and the constraint that enforces it is
 * real: a phone shows about fifteen lines before a message becomes a wall
 * somebody scrolls past. So each card leads with the verdict, carries only the
 * figures that would change a decision, and ends with what is missing.
 *
 * One rule holds throughout: a null is written as "—" or omitted, never as a
 * zero and never quietly dropped. A reader must be able to tell "we looked and
 * it is zero" from "we could not see".
 */

export const money = (v: number | null | undefined): string => {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  const sign = v < 0 ? "−" : "";
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(2)}`;
};

export const pct = (v: number | null | undefined, dp = 1): string =>
  v === null || v === undefined || !Number.isFinite(v)
    ? "—"
    : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(dp)}%`;

const scoreLine = (label: string, s: Score, invert = false): string => {
  if (s.value === null) return `${label.padEnd(14)}—  (no data)`;
  const b = band(invert ? 100 - s.value : s.value);
  const partial = s.confidence < 0.999 ? `  ·${Math.round(s.confidence * 100)}% covered` : "";
  return `${label.padEnd(14)}${String(s.value).padStart(3)}/100  ${b ?? ""}${partial}`;
};

/* --------------------------------------------------------- Deep scan */

export function renderScan(s: DeepScan): string {
  const lines: string[] = [
    `${s.symbol}${s.name ? ` — ${s.name}` : ""}`,
    "",
    `Price      ${money(s.priceUsd)}   ${pct(s.change24hPct)} 24h`,
    `Liquidity  ${money(s.liquidityUsd)}${s.poolCount ? `  ·  ${s.poolCount} pools` : ""}`,
    `Volume 24h ${money(s.volume24hUsd)}`,
    `Market cap ${money(s.marketCapUsd)}`,
    `Holders    ${s.holders?.toLocaleString() ?? "—"}`,
  ];

  if (s.premiumPct !== null) {
    lines.push(
      `Premium    ${pct(s.premiumPct, 3)} vs ${money(s.equityPriceUsd)} share${s.premiumIsStale ? "  (market shut — drift, not a spread)" : ""}`
    );
  }
  if (s.multiplierDrifted) {
    lines.push("", "⚠ A corporate action has moved this token's multiplier — balanceOf misreports it.");
  }

  lines.push(
    "",
    "```",
    scoreLine("TOKEN", s.tokenScore),
    scoreLine("MOMENTUM", s.momentum),
    scoreLine("LIQUIDITY", s.liquidity),
    scoreLine("HOLDERS", s.holderHealth),
    scoreLine("SMART MONEY", s.smartMoneyScore),
    scoreLine("RISK", s.risk),
    "```",
    `Confidence ${s.confidence}%`
  );

  if (s.concentration.topSharePct !== null) {
    lines.push(
      "",
      `Top ${s.concentration.topN} wallets hold ${s.concentration.topSharePct.toFixed(0)}% of the holdings examined (partial — the full holder set is not obtainable).`
    );
  }

  if (s.smartMoney.verdict !== "insufficient") {
    lines.push(
      "",
      `Flow: ${s.smartMoney.verdict.toUpperCase()} over ${s.smartMoney.windowHours.toFixed(1)}h · ${s.smartMoney.confidence}% confidence`,
      `  net ${money(s.smartMoney.netFlowUsd)} across ${s.smartMoney.activeWallets} wallets`
    );
  }

  if (s.anomalies.anomalies.length) {
    lines.push("", "Anomalies:");
    for (const a of s.anomalies.anomalies.slice(0, 3)) {
      lines.push(`  ${a.score}/100  ${a.detail}`);
    }
  }

  /*
   * Security last, and never as a grade.
   *
   * The concerns are listed, then the checks this chain does not run are named
   * explicitly — because a reader who sees no honeypot warning will assume one
   * was looked for, and on Robinhood Chain it was not.
   */
  if (s.security.assessed) {
    if (s.security.concerns.length) {
      lines.push("", "Security:");
      for (const c of s.security.concerns.slice(0, 4)) {
        lines.push(`  [${c.severity.toUpperCase()}] ${c.title}`);
      }
    } else {
      lines.push("", "Security: nothing flagged by the checks that ran.");
    }
    if (s.security.unassessed.length) {
      const shown = s.security.unassessed.slice(0, 6).join(", ").replace(/_/g, " ");
      lines.push(
        `  Not checked on this chain: ${shown}${s.security.unassessed.length > 6 ? "…" : ""}`,
        "  Those are not passes."
      );
    }
  }

  if (s.unavailable.length) lines.push("", `Not available: ${s.unavailable.join("; ")}.`);

  return lines.join("\n");
}

/* --------------------------------------------------------------- Why */

export function renderWhy(w: WhyReport): string {
  const groups = {
    confirmed: w.drivers.filter((d) => d.standing === "confirmed"),
    signal: w.drivers.filter((d) => d.standing === "signal"),
    possible: w.drivers.filter((d) => d.standing === "possible"),
  };

  const lines = [`WHY ${w.symbol} IS MOVING`, ""];

  if (groups.confirmed.length) {
    lines.push("Measured:");
    for (const d of groups.confirmed) lines.push(`  • ${d.text}`);
  }
  if (groups.signal.length) {
    lines.push("", "Signals — unusual for this token:");
    for (const d of groups.signal) lines.push(`  • ${d.text}`);
  }
  if (groups.possible.length) {
    lines.push("", "Possible explanations — consistent with the data, not established by it:");
    for (const d of groups.possible) lines.push(`  • ${d.text}`);
  }
  if (!w.drivers.length) lines.push("Nothing measurable is moving this token right now.");

  lines.push("", `Confidence ${w.confidence}%`);
  if (w.caveat) lines.push("", w.caveat);

  return lines.join("\n");
}

/* ------------------------------------------------------------- Pulse */

export function renderPulse(p: MarketPulse): string {
  const rows = (movers: MarketPulse["gainers"]) =>
    movers.length
      ? movers.map((m, i) => `  ${i + 1}. ${m.symbol.padEnd(8)}${pct(m.changePct).padStart(8)}   ${money(m.volume24Usd)}`)
      : ["  —"];

  const lines = [
    "MARKET PULSE — Robinhood Chain",
    "",
    `Momentum    ${p.momentum}`,
    `Liquidity   ${money(p.totalLiquidityUsd)}${p.liquidityChangePct !== null ? `   ${pct(p.liquidityChangePct)} 6h` : ""}`,
    `Volume 24h  ${money(p.totalVolume24Usd)}${p.volumeChangePct !== null ? `   ${pct(p.volumeChangePct)} 6h` : ""}`,
    /*
     * The indexed total is only printed when it is plausibly a total. Codex
     * returns a per-page `count`, so it comes back as the page size whenever
     * paging stopped early — printing "50 active of 10 indexed" is worse than
     * printing nothing, and a figure that reads as nonsense discredits the ones
     * beside it that are correct.
     */
    `Tokens      ${p.activeTokens} active${p.indexedTokens > p.activeTokens ? ` of ${p.indexedTokens} indexed` : ""}`,
    `Stock tokens ${p.stockTokens}${p.driftedTokens ? `  ·  ${p.driftedTokens} drifting` : ""}${p.scheduledActions ? `  ·  ${p.scheduledActions} action(s) queued` : ""}`,
  ];

  if (p.chain.transactionsToday !== null) {
    lines.push(`Chain today ${p.chain.transactionsToday.toLocaleString()} transactions`);
  }

  lines.push("", "Gainers", ...rows(p.gainers), "", "Losers", ...rows(p.losers));

  if (p.anomalous.length) {
    lines.push("", "Anomalies");
    for (const a of p.anomalous.slice(0, 3)) {
      lines.push(`  ${a.symbol ?? a.address.slice(0, 10)}  ${a.topScore}/100  ${a.anomalies[0].detail}`);
    }
  }

  lines.push(
    "",
    `Movers filtered to tokens with real depth. /scan SYM for one in full.`
  );

  return lines.join("\n");
}

/* ------------------------------------------------------- Smart money */

export function renderSmartMoney(s: SmartMoneyRead): string {
  if (s.verdict === "insufficient") {
    return [
      `SMART MONEY — ${s.symbol ?? s.address.slice(0, 10)}`,
      "",
      "Not enough trade flow in the readable window to say anything.",
      `${s.activeWallets} wallets traded over ${s.windowHours.toFixed(1)}h.`,
      "",
      "Veltr reports nothing rather than guessing from a handful of trades.",
    ].join("\n");
  }

  const side = s.verdict === "accumulation" ? s.accumulating : s.distributing;

  const lines = [
    `SMART MONEY — ${s.symbol ?? s.address.slice(0, 10)}`,
    "",
    `Signal      ${s.verdict.toUpperCase()}`,
    `Confidence  ${s.confidence}%`,
    "",
    `Buy volume  ${money(s.buyUsd)}`,
    `Sell volume ${money(s.sellUsd)}`,
    `Net flow    ${money(s.netFlowUsd)}`,
    `Wallets     ${s.activeWallets} active · ${s.accumulating.length} accumulating · ${s.distributing.length} distributing`,
    `Window      ${s.windowHours.toFixed(1)}h${s.truncated ? " (older trades not read)" : ""}`,
  ];

  if (side.length) {
    lines.push("", "Most notable:");
    for (const w of side.slice(0, 3)) {
      lines.push(
        `  ${w.address.slice(0, 10)}…  score ${w.score.value}  net ${money(w.netUsd)}  ${w.buys + w.sells} trades`
      );
    }
  }

  lines.push(
    "",
    "Ranked on current behaviour — size, conviction and repetition — not on past performance. Trade history deep enough to prove a track record is not available on this chain."
  );

  return lines.join("\n");
}

/* ------------------------------------------------------------ Wallet */

export function renderWallet(w: WalletIntel): string {
  const lines = [
    `WALLET ${w.address.slice(0, 10)}…${w.address.slice(-6)}`,
    "",
    `Age          ${w.ageDays === null ? "—" : `${w.ageDays.toFixed(0)}d`}`,
    `Transactions ${w.transactions?.toLocaleString() ?? "—"}`,
    `Portfolio    ${money(w.totalValueUsd)} across ${w.distinctTokens} token(s)`,
  ];

  if (w.concentrationPct !== null) {
    lines.push(`Largest      ${w.concentrationPct.toFixed(0)}% of the portfolio`);
  }
  if (w.transfersPerDay !== null) {
    lines.push(`Activity     ${w.transfersPerDay.toFixed(1)} transfers/day`);
  }

  lines.push("", `Score ${w.score.value ?? "—"}/100 · ${w.confidence}% confidence`);

  if (w.holdings.length) {
    lines.push("", "Holdings:");
    for (const h of w.holdings.slice(0, 6)) {
      lines.push(`  ${h.symbol.padEnd(7)}${money(h.valueUsd).padStart(11)}`);
    }
  }

  if (w.realised.length) {
    lines.push("", "Visible trade flow:");
    for (const r of w.realised) {
      lines.push(`  ${(r.symbol ?? "?").padEnd(7)}buys ${money(r.buyUsd)}  sells ${money(r.sellUsd)}`);
    }
  }

  lines.push(
    "",
    w.realisedCoverage,
    "",
    "The score reflects how established and active this address is, not trading skill. An address is not a person."
  );

  if (w.unavailable.length) lines.push("", `Not available: ${w.unavailable.join("; ")}.`);

  return lines.join("\n");
}

/* ------------------------------------------------------ Relationship */

export function renderRelationship(o: Overlap): string {
  return [
    "TOKEN RELATIONSHIP",
    "",
    `${o.a.symbol ?? o.a.address.slice(0, 8)} ↔ ${o.b.symbol ?? o.b.address.slice(0, 8)}`,
    "",
    `${o.shared.length} wallets traded both`,
    `${o.sharedBuyers} bought both`,
    `${o.nearSimultaneous} within an hour of each other`,
    o.overlapPct !== null ? `${o.overlapPct.toFixed(0)}% of the smaller token's traders` : "",
    "",
    `Strength   ${o.strength}/100`,
    `Confidence ${o.confidence}%`,
    // Minutes below a tenth of an hour: "0.0h" reads as a broken figure, and the
    // window on a heavily traded token genuinely is only a few minutes deep.
    `Window     ${o.windowHours < 0.1 ? `${Math.round(o.windowHours * 60)}m` : `${o.windowHours.toFixed(1)}h`}`,
    "",
    o.caveat,
  ]
    .filter(Boolean)
    .join("\n");
}

/* ------------------------------------------------------------ Signal */

/**
 * Renders a signal for delivery.
 *
 * `unsolicited` is not cosmetic. A signal reaching someone through /signals was
 * asked for — they turned it on for a token they chose, and telling them how to
 * stop it every time would be nagging. A chain-wide alert was never asked for:
 * it arrives because they once ran /start, possibly months ago, and the sentence
 * explaining that lives in a message they will never see again.
 *
 * So an unsolicited push carries its own way out. Anything else leaves a person
 * with a buzzing phone and no way to know it can be stopped short of guessing.
 */
export function renderSignal(s: Signal, options: { unsolicited?: boolean } = {}): string {
  const lines = [
    `🔥 VELTR SIGNAL`,
    "",
    `${s.symbol ? `$${s.symbol}` : s.address.slice(0, 10)}`,
    "",
    `Signal      ${s.title}`,
    `Strength    ${s.strength}/100`,
    `Confidence  ${s.confidence}%`,
    "",
    ...s.facts.map((f) => `  ${f}`),
    "",
    `/scan ${s.symbol ?? s.address} for the full read.`,
  ];

  if (options.unsolicited) {
    lines.push(
      "",
      "You are getting this because Veltr watches the whole chain for everyone. It only speaks when something is unusual and well evidenced.",
      "/alerts off to stop these. Your own watches are unaffected."
    );
  }

  return lines.join("\n");
}
