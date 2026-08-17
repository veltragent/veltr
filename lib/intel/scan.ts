import { codexToken, codexBars, codexFlowWindow } from "../codex";
import { fetchTopHolders } from "../blockscout";
import { buildRadarSnapshot } from "../tokens";
import { readPremium } from "../market";
import { readState } from "../store";
import { readBaselines } from "./baseline";
import { detectAnomalies, type AnomalyReport } from "./anomaly";
import { analyseFlow, type SmartMoneyRead } from "./smart-money";
import { readSecurity, type SecurityAssessment } from "./security";
import {
  blend,
  buyPressure,
  concentration,
  confidencePct,
  holderScore,
  liquidityScore,
  momentumScore,
  riskScore,
  turnoverRatio,
  volatilityPct,
  type Concentration,
  type Score,
} from "./score";

/**
 * Everything known about one token, assembled once.
 *
 * The point of doing this in one place is that the six reads it needs happen
 * concurrently and are shared: the flow window feeds smart money, buy pressure
 * and the whale check; the candle series feeds volatility and momentum. Asking
 * each feature to fetch its own would multiply the provider calls by four for
 * data that is identical.
 *
 * Anything unavailable stays null all the way to the surface. There is no
 * default-to-zero anywhere in this file, because a token with no holder data
 * scoring the same as a token with one holder is the kind of quiet wrongness
 * this product exists to avoid.
 */

export type DeepScan = {
  address: string;
  symbol: string;
  name: string | null;

  priceUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  poolCount: number | null;
  holders: number | null;
  change24hPct: number | null;

  /** Tokenised-stock specifics. Null for anything that is not one. */
  premiumPct: number | null;
  equityPriceUsd: number | null;
  premiumIsStale: boolean;
  multiplier: number | null;
  multiplierDrifted: boolean;

  turnover: number | null;
  volatilityPct: number | null;
  buyPressurePct: number | null;
  concentration: Concentration;

  tokenScore: Score;
  momentum: Score;
  liquidity: Score;
  holderHealth: Score;
  smartMoneyScore: Score;
  risk: Score;
  /** 0–95 across the whole scan — how much of it had data behind it. */
  confidence: number;

  smartMoney: SmartMoneyRead;
  anomalies: AnomalyReport;
  /** Contract-security findings, folded into `risk` rather than shown alone. */
  security: SecurityAssessment;

  /** Sources that answered, for the footer. */
  sources: string[];
  /** Reads that failed or were unavailable, named rather than hidden. */
  unavailable: string[];
  generatedAt: string;
};

/**
 * Reads and scores one token.
 *
 * Every provider call is wrapped so one outage degrades the scan instead of
 * failing it — a scan with no holder data is still worth having, and is marked
 * as missing that rather than silently scored without it.
 */
export async function deepScan(symbolOrAddress: string): Promise<DeepScan | null> {
  const query = symbolOrAddress.trim();
  const isAddress = /^0x[a-fA-F0-9]{40}$/.test(query);

  const snapshot = await buildRadarSnapshot().catch(() => null);
  const stock = snapshot?.tokens.find((t) =>
    isAddress ? t.address.toLowerCase() === query.toLowerCase() : t.symbol.toUpperCase() === query.toUpperCase()
  );

  const address = stock?.address ?? (isAddress ? query : null);
  if (!address) return null;

  const sources: string[] = [];
  const unavailable: string[] = [];

  const [detail, bars, flow, holders, premium, state, security] = await Promise.all([
    codexToken(address).catch(() => null),
    codexBars(address, "60", 48).catch(() => []),
    codexFlowWindow(address, { hours: 6 }).catch(() => ({ swaps: [], spanSec: 0, truncated: false })),
    fetchTopHolders(address, 2).catch(() => []),
    stock ? readPremium(stock.symbol, address).catch(() => null) : Promise.resolve(null),
    readState().catch(() => null),
    readSecurity(address).catch(() => null),
  ]);

  if (detail) sources.push("Codex");
  else unavailable.push("aggregate market data (Codex)");
  if (bars.length) sources.push("Codex OHLCV");
  else unavailable.push("price history");
  if (flow.swaps.length) sources.push("Codex flow");
  else unavailable.push("recent trade flow");
  if (holders.length) sources.push("Blockscout holders");
  else unavailable.push("holder distribution");
  if (security?.assessed) sources.push("GoPlus security");
  else unavailable.push("contract security (provider did not answer)");

  const symbol = stock?.symbol ?? detail?.symbol ?? "?";

  const smartMoney = analyseFlow(address, symbol, flow.swaps, flow.spanSec, flow.truncated);

  const buys = flow.swaps.filter((s) => s.side === "buy").length;
  const sells = flow.swaps.filter((s) => s.side === "sell").length;
  const pressure = buyPressure(buys, sells) ?? buyPressure(detail?.buys24 ?? null, detail?.sells24 ?? null);

  const conc = concentration(holders, 10);
  const closes = bars.map((b) => b.close);
  const vol = volatilityPct(closes);

  /*
   * The radar figure wins for anything that is a tokenised stock.
   *
   * Not a preference between providers but between measurements. The radar sums
   * liquidity and volume across every pair a token trades in — that summation
   * was the fix for a real defect, where reading a single pool reported NVDA at
   * a tenth of its actual depth. Codex publishes its own aggregate, and on the
   * same token the two currently differ by a factor of five.
   *
   * When two sources disagree, the one whose derivation is known and checked is
   * the one to use; Codex fills in for tokens the radar does not cover, which is
   * everything that is not a stock token.
   */
  const liquidityUsd = stock?.liquidityUsd ?? detail?.liquidityUsd ?? null;
  const volume24hUsd = stock?.volume24h ?? detail?.volume24Usd ?? null;
  const holderCount = stock?.holders ?? detail?.holders ?? null;
  const turnover = turnoverRatio(volume24hUsd, liquidityUsd);

  const multiplier = stock?.multiplier ?? null;
  const drifted = stock ? stock.severity !== "clear" : false;

  /*
   * Momentum from candles rather than a provider's change fields: the OHLCV
   * series is already fetched for volatility, and deriving both from the same
   * bars means the two can never disagree about what the price did.
   */
  const changeOverBars = (hours: number): number | null => {
    if (closes.length < 2) return null;
    const slice = closes.slice(-Math.min(hours, closes.length));
    const first = slice[0];
    return first > 0 ? ((slice[slice.length - 1] - first) / first) * 100 : null;
  };

  const momentum = momentumScore({
    change5m: null,
    change1h: changeOverBars(2),
    change6h: changeOverBars(6),
    change24h: detail?.change24Pct ?? changeOverBars(24),
  });

  const liquidity = liquidityScore(liquidityUsd, stock?.poolCount ?? null);
  const holderHealth = holderScore(holderCount, conc.topSharePct);

  /*
   * Smart money as a 0–100 component.
   *
   * Centred at 50 — neutral — so a token with balanced flow neither helps nor
   * hurts the headline score, and only a genuine lean moves it. Weighted by the
   * read's own confidence, so a one-sided read off six trades barely shifts it.
   */
  const smartMoneyScore: Score = (() => {
    if (smartMoney.verdict === "insufficient") {
      return { value: null, confidence: 0, present: [], missing: ["flow"] };
    }
    const gross = smartMoney.buyUsd + smartMoney.sellUsd;
    const lean = gross > 0 ? (smartMoney.netFlowUsd / gross) * 100 : 0;
    const weight = smartMoney.confidence / 100;
    return {
      value: Math.round(50 + lean * 0.5 * weight),
      confidence: weight,
      present: ["net flow"],
      missing: [],
    };
  })();

  const assessed = security ?? {
    address: address.toLowerCase(),
    concerns: [],
    unassessed: [],
    passed: [],
    score: null,
    confidence: 0,
    assessed: false,
    raw: null,
  };

  const risk = riskScore({
    liquidityUsd,
    topSharePct: conc.topSharePct,
    holders: holderCount,
    turnover,
    volatilityPct: vol,
    multiplierDrifted: drifted,
    securityScore: assessed.score,
  });

  /*
   * The headline. Risk is inverted into it — a token can be liquid, popular and
   * dangerous at once, and a single "token score" that ignored that would be
   * recommending the thing it is supposed to be warning about.
   */
  const tokenScore = blend([
    { label: "liquidity", score: liquidity.value, weight: 3 },
    { label: "holders", score: holderHealth.value, weight: 2 },
    { label: "momentum", score: momentum.value, weight: 2 },
    { label: "flow", score: smartMoneyScore.value, weight: 2 },
    { label: "safety", score: risk.value === null ? null : 100 - risk.value, weight: 3 },
  ]);

  const anomalies = detectAnomalies(
    {
      address,
      symbol,
      priceUsd: detail?.priceUsd ?? stock?.priceUsd ?? null,
      liquidityUsd,
      volume24hUsd,
      holders: holderCount,
      buyPressurePct: pressure,
      largestTradeUsd: smartMoney.wallets.length
        ? Math.max(...flow.swaps.map((s) => s.valueUsd ?? 0))
        : null,
      medianTradeUsd: smartMoney.medianTradeUsd,
    },
    readBaselines(state)
  );

  if (!anomalies.hasBaseline) unavailable.push("recorded history (baseline still building)");

  return {
    address: address.toLowerCase(),
    symbol,
    name: stock?.name ?? detail?.name ?? null,

    priceUsd: detail?.priceUsd ?? stock?.priceUsd ?? null,
    marketCapUsd: detail?.marketCapUsd ?? stock?.marketCap ?? null,
    liquidityUsd,
    volume24hUsd,
    poolCount: stock?.poolCount ?? null,
    holders: holderCount,
    change24hPct: detail?.change24Pct ?? null,

    premiumPct: premium?.premiumPct ?? null,
    equityPriceUsd: premium?.equityPriceUsd ?? null,
    premiumIsStale: premium ? !premium.marketOpen : true,
    multiplier,
    multiplierDrifted: drifted,

    turnover,
    volatilityPct: vol,
    buyPressurePct: pressure,
    concentration: conc,

    tokenScore,
    momentum,
    liquidity,
    holderHealth,
    smartMoneyScore,
    risk,
    confidence: confidencePct(tokenScore.confidence),

    smartMoney,
    anomalies,
    security: assessed,

    sources,
    unavailable,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Security, written for the model.
 *
 * The unassessed list is included deliberately and phrased as an instruction:
 * a model shown "no honeypot warning" will otherwise write "no honeypot", which
 * is the exact false reassurance this whole path is built to prevent.
 */
function securityEvidence(security: DeepScan["security"]): string {
  const head = `SECURITY concerns=${security.concerns.length} score=${security.score ?? "n/a"} confidence=${security.confidence}%`;

  const body = security.concerns.length
    ? security.concerns.map((c) => `  [${c.severity}] ${c.title} — ${c.detail}`).join("\n")
    : "  nothing flagged by the checks that ran";

  const gaps = security.unassessed.length
    ? `\n  NOT CHECKED on this chain — these are NOT passes and must not be reported as safe: ${security.unassessed.join(", ")}`
    : "";

  return `${head}\n${body}${gaps}`;
}

/** The compact evidence block handed to the model for a verdict. */
export function scanEvidence(scan: DeepScan): string {
  const n = (v: number | null, dp = 2) => (v === null ? "unavailable" : v.toFixed(dp));
  const m = (v: number | null) => (v === null ? "unavailable" : `$${Math.round(v).toLocaleString()}`);

  return [
    `TOKEN ${scan.symbol}${scan.name ? ` (${scan.name})` : ""} on Robinhood Chain`,
    `price=${m(scan.priceUsd)} marketCap=${m(scan.marketCapUsd)} liquidity=${m(scan.liquidityUsd)} volume24h=${m(scan.volume24hUsd)}`,
    `pools=${scan.poolCount ?? "unavailable"} holders=${scan.holders ?? "unavailable"} turnover=${n(scan.turnover)}`,
    `volatility=${n(scan.volatilityPct, 1)}% buyPressure=${n(scan.buyPressurePct, 0)}%`,
    scan.premiumPct !== null
      ? `premiumVsShare=${n(scan.premiumPct, 3)}% equityPrice=${m(scan.equityPriceUsd)} referenceStale=${scan.premiumIsStale}`
      : "premium=not a tokenised stock, or equity quote unavailable",
    scan.multiplier !== null ? `uiMultiplier=${scan.multiplier} drifted=${scan.multiplierDrifted}` : "",
    `topHolderConcentration=${n(scan.concentration.topSharePct, 1)}% across top ${scan.concentration.topN} wallets (PARTIAL — full holder set not obtainable)`,
    "",
    `SCORES token=${scan.tokenScore.value ?? "n/a"} momentum=${scan.momentum.value ?? "n/a"} liquidity=${scan.liquidity.value ?? "n/a"} holders=${scan.holderHealth.value ?? "n/a"} smartMoney=${scan.smartMoneyScore.value ?? "n/a"} risk=${scan.risk.value ?? "n/a"} confidence=${scan.confidence}%`,
    "",
    `FLOW verdict=${scan.smartMoney.verdict} confidence=${scan.smartMoney.confidence}% window=${scan.smartMoney.windowHours.toFixed(1)}h`,
    `  net=${m(scan.smartMoney.netFlowUsd)} activeWallets=${scan.smartMoney.activeWallets} accumulating=${scan.smartMoney.accumulating.length} distributing=${scan.smartMoney.distributing.length}`,
    "",
    scan.anomalies.anomalies.length
      ? `ANOMALIES\n${scan.anomalies.anomalies.map((a) => `  ${a.kind} score=${a.score} confidence=${a.confidence}% — ${a.detail}`).join("\n")}`
      : `ANOMALIES none${scan.anomalies.hasBaseline ? "" : " (no recorded history yet — cannot judge)"}`,
    "",
    scan.security.assessed ? securityEvidence(scan.security) : "SECURITY unavailable",
    "",
    scan.unavailable.length ? `UNAVAILABLE: ${scan.unavailable.join("; ")}` : "All sources answered.",
  ]
    .filter(Boolean)
    .join("\n");
}
