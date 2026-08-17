import { tokenSecurity, type Flag, type TokenSecurity } from "../goplus";
import { clamp, confidencePct } from "./score";

/**
 * Security, as Veltr assesses it rather than as GoPlus reports it.
 *
 * The brief was explicit that a GoPlus score must not simply be displayed, and
 * on this chain that would be wrong anyway: GoPlus answers 21 of its 36 checks
 * for Robinhood Chain, and the 15 it omits are the ones that carry the most
 * weight — honeypot, mintable, pausable, ownership. A score computed as though
 * those had passed would be a fabricated reassurance.
 *
 * So this module does three things:
 *
 *  1. Reads the checks that ARE answered and scores them.
 *  2. Names every check that is not answered, and caps confidence accordingly —
 *     a token can never reach a high-confidence "clean" verdict on a chain where
 *     the honeypot test does not run.
 *  3. Adds the concerns Veltr can establish itself and GoPlus cannot: an
 *     upgradeable proxy sitting under a tokenised equity, LP concentrated in one
 *     provider, a creator holding a large share.
 *
 * The output is a concern list, not a grade. "Nothing was flagged, and here is
 * what was never checked" is an honest sentence; "SAFE 92/100" is not.
 */

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export type Concern = {
  severity: Severity;
  /** Short label, e.g. "Sell tax 12%". */
  title: string;
  /** Why it matters, in one sentence a non-specialist can act on. */
  detail: string;
  /** Which system established it. */
  source: "goplus" | "veltr";
};

export type SecurityAssessment = {
  address: string;
  /** Concerns found, worst first. */
  concerns: Concern[];
  /** Checks this chain does not answer. Never treated as passing. */
  unassessed: string[];
  /** Checks that ran and came back clean. */
  passed: string[];
  /**
   * 0–100, where 100 is the most concerning.
   *
   * Contributes to the overall risk score rather than standing alone — see
   * scan.ts, where it is one weighted input among liquidity, concentration,
   * churn and volatility.
   */
  score: number | null;
  /** 0–95. Bounded hard by how many checks this chain actually runs. */
  confidence: number;
  /** True when GoPlus answered at all. */
  assessed: boolean;
  raw: TokenSecurity | null;
};

const SEVERITY_WEIGHT: Record<Severity, number> = {
  critical: 100,
  high: 70,
  medium: 40,
  low: 15,
  info: 0,
};

/** A flag is only a concern when it was actually assessed and came back set. */
const raised = (f: Flag): boolean => f.assessed && f.value;
const cleared = (f: Flag): boolean => f.assessed && !f.value;

/**
 * Thresholds for the checks that return a number rather than a flag.
 *
 * A tax above 10% is the level at which round-tripping a position costs more
 * than most moves are worth; above 50% the token is effectively one-way.
 */
export const TAX_HIGH_PCT = 10;
export const TAX_CRITICAL_PCT = 50;
/** One provider holding this much of the pool can withdraw the market. */
export const LP_CONCENTRATION_PCT = 60;
/** A creator holding this much can move the price alone. */
export const CREATOR_HOLDING_PCT = 20;

/** Pure, so the whole judgement is testable without a network. */
export function assess(security: TokenSecurity | null, address: string): SecurityAssessment {
  if (!security) {
    return {
      address: address.toLowerCase(),
      concerns: [],
      unassessed: [],
      passed: [],
      score: null,
      confidence: 0,
      assessed: false,
      raw: null,
    };
  }

  const concerns: Concern[] = [];
  const passed: string[] = [];

  /* ---- Checks GoPlus answers on this chain. */

  const tax = (value: number | null, label: string, side: string) => {
    if (value === null) return;
    const pct = value * 100;
    if (pct >= TAX_CRITICAL_PCT) {
      concerns.push({
        severity: "critical",
        title: `${label} ${pct.toFixed(0)}%`,
        detail: `Over half of every ${side} is taken by the contract.`,
        source: "goplus",
      });
    } else if (pct >= TAX_HIGH_PCT) {
      concerns.push({
        severity: "high",
        title: `${label} ${pct.toFixed(1)}%`,
        detail: `A ${pct.toFixed(1)}% cut on every ${side} has to be recovered before a position breaks even.`,
        source: "goplus",
      });
    } else if (pct > 0) {
      concerns.push({
        severity: "low",
        title: `${label} ${pct.toFixed(1)}%`,
        detail: `A small cut is taken on every ${side}.`,
        source: "goplus",
      });
    } else {
      passed.push(`${label.toLowerCase()} is zero`);
    }
  };

  tax(security.buyTaxPct, "Buy tax", "purchase");
  tax(security.sellTaxPct, "Sell tax", "sale");
  tax(security.transferTaxPct, "Transfer tax", "transfer");

  if (raised(security.cannotSellAll)) {
    concerns.push({
      severity: "critical",
      title: "Cannot sell entire balance",
      detail: "The contract prevents selling a full position, which is a hallmark of a trap.",
      source: "goplus",
    });
  } else if (cleared(security.cannotSellAll)) passed.push("a full balance can be sold");

  if (raised(security.cannotBuy)) {
    concerns.push({
      severity: "high",
      title: "Cannot buy",
      detail: "The contract blocks purchases.",
      source: "goplus",
    });
  } else if (cleared(security.cannotBuy)) passed.push("buying is not blocked");

  if (raised(security.honeypotSameCreator)) {
    concerns.push({
      severity: "critical",
      title: "Creator has deployed a honeypot before",
      detail: "The same address previously deployed a token that traps buyers.",
      source: "goplus",
    });
  } else if (cleared(security.honeypotSameCreator)) passed.push("creator has no known honeypot history");

  if (security.isOpenSource.assessed && !security.isOpenSource.value) {
    concerns.push({
      severity: "high",
      title: "Source code not verified",
      detail: "The contract's behaviour cannot be reviewed because its source was never published.",
      source: "goplus",
    });
  } else if (cleared(security.isOpenSource) === false && security.isOpenSource.assessed) {
    passed.push("source code is verified");
  }

  /* ---- What Veltr establishes that GoPlus does not flag here. */

  if (raised(security.isProxy)) {
    concerns.push({
      severity: "medium",
      title: "Upgradeable contract",
      detail:
        "This is a proxy, so its logic can be replaced by whoever controls it. GoPlus does not report the owner on this chain, so who that is cannot be established here.",
      source: "veltr",
    });
  }

  if (security.creatorPercent !== null && security.creatorPercent >= CREATOR_HOLDING_PCT) {
    concerns.push({
      severity: "high",
      title: `Creator holds ${security.creatorPercent.toFixed(1)}%`,
      detail: "A single address holds enough supply to move the price on its own.",
      source: "veltr",
    });
  }

  /*
   * Liquidity provider concentration.
   *
   * GoPlus returns the LP holder list but draws no conclusion from it. One
   * provider holding most of a pool means the market can be withdrawn in a
   * single transaction, which matters more on a thin chain than almost anything
   * else the security scan reports.
   */
  const topLp = security.lpHolders
    .filter((h) => h.percent !== null)
    .sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0))[0];

  if (topLp && (topLp.percent ?? 0) >= LP_CONCENTRATION_PCT) {
    concerns.push({
      severity: "high",
      title: `One provider holds ${topLp.percent!.toFixed(0)}% of liquidity`,
      detail: "The tradeable market here can be withdrawn by a single address.",
      source: "veltr",
    });
  } else if (topLp) {
    passed.push(`liquidity spread across ${security.lpHolderCount ?? security.lpHolders.length} providers`);
  }

  /* ---- Score and confidence. */

  const order: Severity[] = ["critical", "high", "medium", "low", "info"];
  concerns.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));

  /*
   * The worst concern sets the level; additional ones add less than the first.
   *
   * Summing severities would let five cosmetic findings outrank one critical
   * trap, which inverts the only judgement that matters.
   */
  const worst = concerns[0] ? SEVERITY_WEIGHT[concerns[0].severity] : 0;
  const rest = concerns.slice(1).reduce((s, c) => s + SEVERITY_WEIGHT[c.severity] * 0.15, 0);
  const score = clamp(worst + rest);

  /*
   * Confidence is bounded by coverage, and this chain's coverage is partial by
   * construction. A token where the honeypot test never ran cannot be reported
   * as confidently clean, however many other checks passed.
   */
  const answered = passed.length + concerns.filter((c) => c.source === "goplus").length;
  const coverage = answered / (answered + security.unassessed.length || 1);

  return {
    address: security.address,
    concerns,
    unassessed: security.unassessed,
    passed,
    score,
    confidence: confidencePct(coverage),
    assessed: true,
    raw: security,
  };
}

export async function readSecurity(address: string): Promise<SecurityAssessment> {
  return assess(await tokenSecurity(address).catch(() => null), address);
}

/** Telegram rendering, kept beside the judgement it renders. */
export function renderSecurity(a: SecurityAssessment): string {
  if (!a.assessed) {
    return "Security: not available — the provider did not answer for this token.";
  }

  const lines: string[] = [];

  if (a.concerns.length === 0) {
    lines.push("Security: nothing flagged by the checks that ran.");
  } else {
    lines.push("Security concerns:");
    for (const c of a.concerns.slice(0, 5)) {
      lines.push(`  [${c.severity.toUpperCase()}] ${c.title}`);
      lines.push(`     ${c.detail}`);
    }
  }

  if (a.unassessed.length) {
    lines.push(
      "",
      `Not checked on this chain: ${a.unassessed.join(", ").replace(/_/g, " ")}.`,
      "These are not passes — the provider does not run them on Robinhood Chain."
    );
  }

  lines.push("", `Security confidence ${a.confidence}% — bounded by how many checks this chain answers.`);
  return lines.join("\n");
}
