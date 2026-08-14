import type { RadarSnapshot, StockToken } from "./tokens";
import { multiplier as fmtMultiplier, signedPct, usd } from "./format";
import { complete } from "./llm";

const SYSTEM = `You are Veltr, an analyst covering corporate actions on Robinhood Chain.

Context you must reason from:
- Stock tokens are ERC-8056. They never rebase. A holder's raw balance is fixed; corporate actions move an on-chain "uiMultiplier" instead.
- True exposure = rawBalance * uiMultiplier / 1e18. Any wallet or tracker reading plain balanceOf misstates exposure whenever the multiplier is not exactly 1.0.
- newUIMultiplier + effectiveAt expose a SCHEDULED action before it lands.
- Stock tokens are debt securities, not equity. Holders have no shareholder rights.
- Chainlink prices for these assets already include the multiplier.

Rules:
- Ground every claim in the supplied live data. Never invent a ticker, multiplier or date.
- Be precise and plain. Explain what the number means for the holder.
- State risk factually. Do not give buy/sell recommendations or price predictions.
- Keep answers under 200 words unless asked to expand.`;

function describe(t: StockToken): string {
  const parts = [
    `${t.symbol} (${t.name})`,
    `multiplier=${fmtMultiplier(t.multiplier)}`,
    `rawBalanceMisstatesBy=${signedPct(t.reportingErrorPct)}`,
    `holders=${t.holders}`,
    `price=${usd(t.priceUsd)}`,
    `status=${t.severity}`,
  ];
  if (t.pendingMultiplier !== null && t.actionDeltaPct !== null) {
    parts.push(
      `SCHEDULED_ACTION: multiplier -> ${fmtMultiplier(t.pendingMultiplier)} (${signedPct(t.actionDeltaPct)})`,
      t.effectiveAt ? `effectiveAt=${new Date(t.effectiveAt * 1000).toISOString()}` : "effectiveAt=unknown"
    );
  }
  return parts.join(", ");
}

/** Compact, grounded view of chain state handed to the model as evidence. */
export function buildEvidence(snapshot: RadarSnapshot): string {
  const notable = snapshot.tokens.filter((t) => t.severity !== "clear");
  const rest = snapshot.tokens.filter((t) => t.severity === "clear").slice(0, 25);

  return [
    `LIVE CHAIN STATE (Robinhood Chain mainnet, chainId 4663, block ${snapshot.blockNumber ?? "?"}, read ${snapshot.generatedAt})`,
    `Tracked stock tokens: ${snapshot.stats.tracked}`,
    `Scheduled corporate actions: ${snapshot.stats.scheduled}`,
    `Tokens whose raw balance already misreports: ${snapshot.stats.drifted}`,
    "",
    "TOKENS WITH ACTIVE MULTIPLIER STATE:",
    ...notable.map((t) => `- ${describe(t)}`),
    "",
    `TOKENS AT MULTIPLIER 1.0 (no action applied): ${rest.map((t) => t.symbol).join(", ")}`,
  ].join("\n");
}

/**
 * Deterministic briefing derived purely from chain state. This is the answer of
 * record when no LLM key is configured — the product stays useful without one,
 * and the model only ever adds narration on top of these same numbers.
 */
export function deterministicBriefing(snapshot: RadarSnapshot): string {
  const { stats } = snapshot;
  const scheduled = snapshot.tokens.filter((t) => t.severity === "scheduled");
  const drifted = snapshot.tokens.filter((t) => t.severity === "drifted");

  const lines: string[] = [
    `Veltr is tracking ${stats.tracked} ERC-8056 stock tokens on Robinhood Chain.`,
    "",
  ];

  if (scheduled.length) {
    lines.push(`${scheduled.length} corporate action(s) are scheduled on-chain and have not landed yet:`);
    for (const t of scheduled) {
      const when = t.hoursUntilEffective;
      const timing =
        when === null ? "timing not published" : when > 0 ? `in ~${when.toFixed(1)}h` : `overdue by ${Math.abs(when).toFixed(1)}h`;
      lines.push(
        `• ${t.symbol} — multiplier ${fmtMultiplier(t.multiplier)} → ${fmtMultiplier(t.pendingMultiplier!)} (${signedPct(t.actionDeltaPct)}), effective ${timing}. ${t.holders.toLocaleString()} holders affected.`
      );
    }
    lines.push("");
  } else {
    lines.push("No corporate action is currently queued on-chain. Nothing is pending in newUIMultiplier across the tracked set.", "");
  }

  if (drifted.length) {
    lines.push(`${drifted.length} token(s) have already applied a multiplier. For these, any wallet or tracker reading plain balanceOf reports the wrong exposure right now:`);
    for (const t of drifted.slice(0, 8)) {
      lines.push(
        `• ${t.symbol} — multiplier ${fmtMultiplier(t.multiplier)}; raw balance understates true exposure by ${signedPct(t.reportingErrorPct)} across ${t.holders.toLocaleString()} holders.`
      );
    }
    lines.push("");
  }

  lines.push(
    "Effective exposure = rawBalance × uiMultiplier ÷ 1e18. Verify positions against balanceOfUI() rather than balanceOf() before filing tax reports or sizing collateral.",
    "",
    "Informational only. Not investment advice."
  );

  return lines.join("\n");
}

const BRIEF_SYSTEM = `${SYSTEM}

You are writing the daily brief for holders of stock tokens on Robinhood Chain.
Open with what a holder must do today, if anything. Then the state of the chain.
Be specific and quantitative. No preamble, no sign-off, no markdown headers.
Under 250 words.`;

/**
 * The daily brief runs once per day and is broadcast to every subscriber, so it
 * is the one place where paying for the stronger model is justified.
 */
export async function runDailyBrief(snapshot: RadarSnapshot) {
  const evidence = buildEvidence(snapshot);
  const result = await complete(
    "deep",
    BRIEF_SYSTEM,
    `${evidence}\n\nWrite today's brief.`,
    600
  );

  if (result) return { brief: result.text, source: result.model };
  return { brief: deterministicBriefing(snapshot), source: "deterministic" };
}
