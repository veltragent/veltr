import type { Reasoner, ReasonerReply } from "../lib/agent/reasoner";
import type { ToolRunner } from "../lib/agent/execute";
import type { MissionDeps } from "../lib/agent/mission";
import type { RoutableTool } from "../lib/agent/router";

/**
 * Fixtures for the agent core.
 *
 * Every dependency the loop has is a function, so a whole mission — observation,
 * decision, permission, action, verification — runs here with no network, no
 * model and no API key.
 */

/** A reasoner that replays scripted replies in order. */
export function scriptedReasoner(replies: (string | null)[]): Reasoner & { calls: number } {
  let index = 0;
  const reasoner = {
    name: "scripted",
    calls: 0,
    async think(): Promise<ReasonerReply> {
      reasoner.calls++;
      const reply = replies[Math.min(index, replies.length - 1)];
      index++;
      return reply === null ? null : { text: reply, model: "scripted" };
    },
  };
  return reasoner;
}

/** Renders a decision object as the model would return it. */
export function reply(decision: Record<string, unknown>): string {
  return JSON.stringify(decision);
}

export type RecordedCall = { tool: string; args: Record<string, unknown> };

/** A tool registry stand-in: canned results, and a log of what was asked for. */
export function stubRunner(
  results: Record<string, unknown | ((args: Record<string, unknown>) => unknown)>
): ToolRunner & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];

  const runner = (async (tool: string, args: Record<string, unknown>) => {
    calls.push({ tool, args });
    const entry = results[tool];
    if (entry === undefined) return { name: tool, acted: false, result: { error: `Unknown tool: ${tool}` } };
    const value = typeof entry === "function" ? (entry as (a: Record<string, unknown>) => unknown)(args) : entry;
    if (value instanceof Error) throw value;
    const acted = Boolean((value as { __acted?: boolean })?.__acted);
    return { name: tool, acted, result: value };
  }) as ToolRunner & { calls: RecordedCall[] };

  runner.calls = calls;
  return runner;
}

export const TOOLS: RoutableTool[] = [
  { name: "get_price", description: "Live price for a ticker." },
  { name: "get_news", description: "Recent headlines for a ticker." },
  { name: "get_market", description: "Overall market state." },
  { name: "web_search", description: "Search the web." },
  { name: "get_alert_status", description: "What the user is subscribed to." },
  { name: "set_alert_scope", description: "Scope alerts to a wallet." },
  { name: "send_chart", description: "Send a chart to the chat." },
  { name: "defend_position", description: "Withdraw liquidity from a position." },
];

export function deps(overrides: Partial<MissionDeps> = {}): Partial<MissionDeps> {
  let clock = Date.parse("2026-08-14T00:00:00.000Z");
  return {
    reasoner: scriptedReasoner([reply({ verdict: "insufficient_evidence", reason: "nothing" })]),
    runner: stubRunner({}),
    tools: TOOLS,
    actionTools: new Set(["set_alert_scope", "send_chart", "defend_position"]),
    // Advances a second per read, so ordering is visible without real waiting.
    now: () => new Date((clock += 1000)),
    isCancelled: () => false,
    ...overrides,
  };
}
