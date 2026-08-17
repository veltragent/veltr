import type { ToolSpec } from "./tools";

/**
 * Intelligence tools for the existing agent.
 *
 * A separate array rather than a second agent: these are appended to the same
 * registry that `lib/agent/execute.ts` already resolves, so Ask Veltr can call
 * them exactly as it calls `get_price`, with the same routing, budget, evidence
 * ledger and citation checks applied. Nothing about the reasoning loop changes.
 *
 * Every handler returns the structured read rather than prose. The evidence
 * layer is what stops the model inventing figures, and it can only check a
 * number it was actually given — a tool that returned a paragraph would defeat
 * it, because there would be nothing to check the paragraph against.
 */

const str = (v: unknown): string => String(v ?? "").trim();

export const INTEL_TOOLS: ToolSpec[] = [
  {
    name: "deep_scan_token",
    description:
      "Full intelligence read on one token: price, liquidity, volume, market cap, holders, concentration, volatility, buy pressure, recent wallet flow, anomalies against its own recorded history, and six scores (token, momentum, liquidity, holders, smart money, risk) each with the confidence behind it. Use for 'what is happening with X', 'is X safe', 'analyse X'.",
    parameters: {
      type: "object",
      properties: {
        token: { type: "string", description: "Ticker like NVDA, or a 0x contract address." },
      },
      required: ["token"],
    },
    handler: async (args) => {
      const { deepScan, scanEvidence } = await import("./intel/scan");
      const scan = await deepScan(str(args.token));
      if (!scan) return { found: false, reason: "Not a token on this chain." };
      return {
        found: true,
        evidence: scanEvidence(scan),
        scores: {
          token: scan.tokenScore.value,
          momentum: scan.momentum.value,
          liquidity: scan.liquidity.value,
          holders: scan.holderHealth.value,
          smartMoney: scan.smartMoneyScore.value,
          risk: scan.risk.value,
          confidence: scan.confidence,
        },
        unavailable: scan.unavailable,
      };
    },
  },
  {
    name: "explain_token_move",
    description:
      "Why a token is moving, with each driver labelled as measured, a statistical signal, or merely consistent with the data. Use when asked why something moved, pumped, dumped or dislocated. Never present a 'possible' driver as a cause.",
    parameters: {
      type: "object",
      properties: {
        token: { type: "string", description: "Ticker or 0x address." },
        hours: { type: "number", description: "Window in hours. Defaults to 1." },
      },
      required: ["token"],
    },
    handler: async (args) => {
      const { explainMove } = await import("./intel/why");
      const hours = Number(args.hours);
      const report = await explainMove(str(args.token), Number.isFinite(hours) ? hours * 3600 : 3600);
      if (!report) return { found: false };
      return {
        found: true,
        symbol: report.symbol,
        confidence: report.confidence,
        caveat: report.caveat,
        measured: report.drivers.filter((d) => d.standing === "confirmed").map((d) => d.text),
        signals: report.drivers.filter((d) => d.standing === "signal").map((d) => d.text),
        possible: report.drivers.filter((d) => d.standing === "possible").map((d) => d.text),
      };
    },
  },
  {
    name: "market_pulse",
    description:
      "Whole-chain read of Robinhood Chain: total liquidity and volume across the most active tokens, breadth momentum, biggest gainers and losers filtered to tokens with real depth, and any token behaving unusually against its own recorded history. Use for 'how is the market', 'what is moving', 'anything interesting today'.",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      const { readPulse, pulseEvidence } = await import("./intel/pulse");
      const pulse = await readPulse();
      return { evidence: pulseEvidence(pulse), momentum: pulse.momentum, anomalies: pulse.anomalous.length };
    },
  },
  {
    name: "smart_money_activity",
    description:
      "Which wallets are accumulating or distributing a token right now, scored on trade size, conviction and repetition relative to that token's own typical trade. IMPORTANT: this reflects current behaviour over a window of hours, not proven track record — historical wallet performance is not obtainable on this chain. Never describe these wallets as proven winners.",
    parameters: {
      type: "object",
      properties: { token: { type: "string", description: "Ticker or 0x address." } },
      required: ["token"],
    },
    handler: async (args) => {
      const { readSmartMoney } = await import("./intel/smart-money");
      const { buildRadarSnapshot } = await import("./tokens");
      const query = str(args.token);

      const snapshot = await buildRadarSnapshot().catch(() => null);
      const stock = snapshot?.tokens.find((t) => t.symbol.toUpperCase() === query.toUpperCase());
      const address = stock?.address ?? (/^0x[a-fA-F0-9]{40}$/.test(query) ? query : null);
      if (!address) return { found: false };

      const read = await readSmartMoney(address, stock?.symbol ?? null);
      return {
        found: true,
        verdict: read.verdict,
        confidence: read.confidence,
        netFlowUsd: read.netFlowUsd,
        buyUsd: read.buyUsd,
        sellUsd: read.sellUsd,
        activeWallets: read.activeWallets,
        accumulating: read.accumulating.length,
        distributing: read.distributing.length,
        windowHours: Number(read.windowHours.toFixed(2)),
        limitation:
          "Ranked on current behaviour only. Deep trade history is not available on this chain, so no claim about past performance is supported.",
      };
    },
  },
  {
    name: "analyse_wallet",
    description:
      "Read one address: age, transaction count, holdings, portfolio concentration, activity rate, and buy/sell flow over the trades that were visible. IMPORTANT: nothing on chain records what an address paid, so true profit and loss cannot be computed and must never be stated.",
    parameters: {
      type: "object",
      properties: { address: { type: "string", description: "0x wallet address." } },
      required: ["address"],
    },
    handler: async (args) => {
      const { isAddress } = await import("viem");
      const address = str(args.address);
      if (!isAddress(address)) return { error: "Not a valid address." };

      const { readWalletIntel, walletEvidence } = await import("./intel/wallet");
      const intel = await readWalletIntel(address);
      return {
        evidence: walletEvidence(intel),
        score: intel.score.value,
        confidence: intel.confidence,
        coverage: intel.realisedCoverage,
        unavailable: intel.unavailable,
      };
    },
  },
  {
    name: "related_tokens",
    description:
      "Tokens being traded by the same wallets as a given token, with how many overlap, how many bought both, and how many did so within an hour. IMPORTANT: overlap does not establish common ownership or coordination — say so if asked what it means.",
    parameters: {
      type: "object",
      properties: { token: { type: "string", description: "Ticker or 0x address." } },
      required: ["token"],
    },
    handler: async (args) => {
      const { relatedTokens, CAVEAT } = await import("./intel/relationships");
      const { codexTopTokens } = await import("./codex");
      const { buildRadarSnapshot } = await import("./tokens");
      const query = str(args.token);

      const snapshot = await buildRadarSnapshot().catch(() => null);
      const stock = snapshot?.tokens.find((t) => t.symbol.toUpperCase() === query.toUpperCase());
      const address = stock?.address ?? (/^0x[a-fA-F0-9]{40}$/.test(query) ? query : null);
      if (!address) return { found: false };

      const { tokens } = await codexTopTokens("volume24", 12);
      const overlaps = await relatedTokens(
        { address, symbol: stock?.symbol ?? null },
        tokens.map((t) => ({ address: t.address, symbol: t.symbol }))
      );

      return {
        found: true,
        caveat: CAVEAT,
        related: overlaps.slice(0, 4).map((o) => ({
          symbol: o.b.symbol,
          address: o.b.address,
          sharedWallets: o.shared.length,
          sharedBuyers: o.sharedBuyers,
          nearSimultaneous: o.nearSimultaneous,
          strength: o.strength,
          confidence: o.confidence,
        })),
      };
    },
  },
];
