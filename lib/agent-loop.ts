import { chatWithTools, type ChatMessage } from "./llm";
import { toolSchemas, invokeTool, type ToolContext } from "./tools";
import { fetchMarketStatus } from "./stocks";
import { isCancelled } from "./inflight";
import { deliveredFilename, reconcileFileClaims } from "./delivery-guard";
import {
  CallMemo,
  classifyDepth,
  compressHistory,
  partitionCalls,
  transcriptSize,
  type PendingCall,
} from "./agent/orchestration";
import { declaredActions } from "./agent/execute";
import { routeTools } from "./agent/router";
import { getAttachment } from "./attachments";

/**
 * The acting agent.
 *
 * Rather than pre-fetching data and asking the model to narrate it, the model
 * decides what it needs, calls tools to get it, and may call more tools based on
 * what came back. That is the difference between a chatbot and an agent: it can
 * look something up it was not asked about, and it can do things — send a chart,
 * scope an alert — instead of telling the user which command to type.
 *
 * Every figure still comes from a tool. The model has no way to invent a price.
 */

const SYSTEM = `You are Veltr, a market analyst and operator for Robinhood Chain — an Arbitrum L2 where US equities exist as ERC-8056 tokens.

Domain facts:
- Stock tokens never rebase. Corporate actions move an on-chain "uiMultiplier"; raw balances stay fixed. True exposure = rawBalance × uiMultiplier ÷ 1e18.
- Each token has two prices: on-chain (DEX liquidity, trades 24/7) and the underlying equity's exchange price (weekdays 09:30–16:00 ET). The gap is the premium.
- When the equity market is closed the exchange price is a stale close, so the premium is drift, not a tradeable spread. Say so whenever it applies.
- Splits are the only corporate action that materially harms liquidity providers: a 4:1 lets arbitrage take about 20% of pooled value. Distributions are immaterial to LPs.
- These tokens are debt securities, not equity. Holders receive no shareholder rights.

How to work:
- ALWAYS call tools for facts. Never state a price, percentage, holder count or date you did not get from a tool.
- Call several tools when a question needs them. To explain a move, get the price AND the news.
- When the user asks to see a chart, call send_chart — do not describe the picture instead.
- When the user wants alerts narrowed to their wallet, call set_alert_scope rather than telling them to type a command.
- If a tool returns an error, say plainly what could not be retrieved.
- To produce a file, call write_code with deliverAs set to the filename. That writes and sends it in one step. Never retype generated content into another tool — it is held for you.
- NEVER state that a file has been created, written, sent or attached unless a tool call in this conversation returned "sent": true. If you did not call a tool, nothing was produced — say what you are about to do, not that it is done.
- If a file was delivered, say so in one clause. Do not paste its contents into the chat.

Voice:
- Always answer in English, whatever language the question is written in.
- When a name is given, address the person by it once at the start, then get to the substance. Never repeat it.
- Direct and quantitative. Under 200 words unless asked to expand.
- No buy/sell recommendations, no price predictions.
- If you performed an action, state what you did in one short clause.`;

/**
 * Ceiling across every depth.
 *
 * `classifyDepth` picks the working budget; this is the guard rail behind it, so
 * a misclassification costs a slower answer rather than an unbounded one.
 */
const MAX_ROUNDS_CEILING = 8;

/**
 * Below this many signals, the whole registry is offered.
 *
 * Routing trades breadth for focus, and on an open-ended chat the cost of
 * withholding a tool the user needed is higher than the tokens saved. So it only
 * narrows when the request actually indicates what it is about.
 */
const MIN_SIGNALS_TO_ROUTE = 2;

export type AgentResult = {
  answer: string;
  source: string;
  toolsUsed: string[];
  actions: string[];
  rounds: number;
  cancelled?: boolean;
  /** Documents that actually reached the chat. Never what the answer claims. */
  filesDelivered?: string[];
};

export async function runAgentLoop(
  question: string,
  ctx: ToolContext = {},
  userName?: string | null,
  /** Called as each tool starts, so a caller can show what is happening. */
  onTool?: (name: string) => void
): Promise<AgentResult> {
  const status = await fetchMarketStatus().catch(() => null);

  const preamble = [
    `Current time (UTC): ${new Date().toISOString()}`,
    status
      ? `US equity market: ${status.isOpen ? "OPEN" : "CLOSED"}${status.holiday ? ` (holiday: ${status.holiday})` : ""}`
      : "US equity market: session state unavailable",
    userName ? `The person asking is called ${userName}.` : "",
  ]
    .filter(Boolean)
    .join("\n");

  let messages: ChatMessage[] = [
    { role: "system", content: `${SYSTEM}\n\n${preamble}` },
    { role: "user", content: question },
  ];

  /**
   * Budget, chosen from the request rather than fixed.
   *
   * "thanks" and "investigate why this feature is failing" were given the same
   * five rounds and the same thirty-one tool schemas. Now the first gets a small
   * surface it will not use, and the second gets room to actually follow a chain
   * of reads to its end.
   */
  const plan = classifyDepth(question, {
    hasAttachment: Boolean(ctx.chatId && getAttachment(ctx.chatId)),
  });

  const allSchemas = toolSchemas();
  const routed = routeTools(
    question,
    allSchemas.map((s) => ({ name: s.function.name, description: s.function.description })),
    { limit: plan.toolBudget }
  );

  // Narrow when the request says enough about itself to narrow safely — or when
  // it is trivial, where offering thirty tools to answer "2 + 2" is pure cost.
  const narrow =
    routed.tools.length > 0 && (plan.depth === "fast" || routed.tags.length >= MIN_SIGNALS_TO_ROUTE);

  const schemas = narrow
    ? allSchemas.filter((s) => routed.tools.some((t) => t.name === s.function.name))
    : allSchemas;

  const actionTools = await declaredActions().catch(() => new Set<string>());
  const memo = new CallMemo();

  const toolsUsed: string[] = [];
  const actions: string[] = [];
  const filesDelivered: string[] = [];
  let model = "unknown";
  const startedAt = Date.now();

  console.log(
    `[veltr][AGENT] depth=${plan.depth} rounds=${plan.maxRounds} tools=${schemas.length}/${allSchemas.length}` +
      `${routed.tags.length ? ` signals=${routed.tags.join(",")}` : ""}`
  );

  /**
   * Final step for every exit path.
   *
   * The answer is checked against what the tools actually did before it is
   * returned, so a claim that a file was sent cannot leave this function unless
   * a file was sent. Applied here rather than at the call site because there are
   * four ways out of this loop and every one of them must be honest.
   */
  const settle = async (answer: string, source: string, rounds: number): Promise<AgentResult> => {
    const reconciled = await reconcileFileClaims(answer, ctx.chatId, filesDelivered).catch(() => null);
    if (reconciled?.recovered) filesDelivered.push(reconciled.recovered);

    return {
      answer: reconciled?.answer ?? answer,
      source,
      toolsUsed,
      actions,
      rounds,
      filesDelivered,
    };
  };

  const abandoned = (round: number): AgentResult => ({
    answer: "Cancelled. Nothing further was run.",
    source: model,
    toolsUsed,
    actions,
    rounds: round,
    cancelled: true,
  });

  const maxRounds = Math.min(plan.maxRounds, MAX_ROUNDS_CEILING);

  for (let round = 1; round <= maxRounds; round++) {
    if (isCancelled(ctx.chatId)) return abandoned(round - 1);
    if (round > 1) onTool?.("__thinking__");

    // Older tool output is shrunk before it is paid for again. The round just
    // completed stays intact — that is what the model is reasoning about.
    const before = transcriptSize(messages);
    messages = compressHistory(messages);
    const saved = before - transcriptSize(messages);
    if (saved > 0) console.log(`[veltr][AGENT] compressed transcript by ${saved} chars`);

    const turn = await chatWithTools("fast", messages, schemas, plan.responseTokens);

    if (!turn) {
      return settle(
        "The model is unavailable right now. The underlying data is still live — try /price, /premium, /chart or /market.",
        "unavailable",
        round - 1
      );
    }

    model = turn.model;
    const message = turn.message;
    const calls = message.tool_calls ?? [];

    // No tool calls means the model is done and this is the answer.
    if (calls.length === 0) {
      return settle((message.content ?? "").trim() || "No answer was produced.", model, round);
    }

    // The assistant message must be echoed back verbatim: providers reject a
    // tool result whose originating tool_call_id they cannot find.
    messages.push(message);

    const pending: PendingCall[] = calls.map((call) => {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        // A malformed argument string is the model's error to see and correct.
        args = {};
      }
      return { id: call.id, name: call.function.name, args };
    });

    if (isCancelled(ctx.chatId)) return abandoned(round);

    /**
     * Runs one call, or returns what it returned last time.
     *
     * The memo is what stops a loop re-reading the same file in round four that
     * it already read in round two — paid for twice, waited for twice, and
     * identical both times.
     */
    const runOne = async (call: PendingCall): Promise<{ id: string; name: string; result: unknown; acted: boolean }> => {
      const cached = memo.get(call.name, call.args);
      if (cached !== undefined) {
        console.log(`[veltr][AGENT] tool=${call.name} deduplicated`);
        return { id: call.id, name: call.name, acted: false, result: cached };
      }

      onTool?.(call.name);
      const at = Date.now();
      const invocation = await invokeTool(call.name, call.args, ctx);
      const ms = Date.now() - at;

      const failed = Boolean((invocation.result as { error?: string })?.error);
      console.log(`[veltr][AGENT] tool=${call.name} ${ms}ms ${failed ? "error" : "ok"}`);

      // Only a clean read is worth remembering: a failure may succeed on retry,
      // and an action must never be replayed from a memo.
      if (!failed && !invocation.acted) memo.remember(call.name, call.args, invocation.result);

      return { id: call.id, name: invocation.name, acted: invocation.acted, result: invocation.result };
    };

    const { reads, acts } = partitionCalls(pending, actionTools);

    // Reads have no dependency on each other, so serialising them is latency
    // paid for nothing. Actions stay sequential: two of them can touch the same
    // state, and the winner would be whichever response happened to land second.
    const roundStarted = Date.now();
    const readResults = await Promise.all(reads.map(runOne));
    const actResults: Awaited<ReturnType<typeof runOne>>[] = [];
    for (const call of acts) {
      if (isCancelled(ctx.chatId)) return abandoned(round);
      actResults.push(await runOne(call));
    }

    if (reads.length > 1) {
      console.log(`[veltr][AGENT] round ${round}: ${reads.length} reads in parallel, ${Date.now() - roundStarted}ms`);
    }

    // Replayed in the order the model asked for them: a provider rejects a
    // transcript whose tool_call_ids do not all come back.
    const byId = new Map([...readResults, ...actResults].map((r) => [r.id, r]));

    for (const call of pending) {
      const outcome = byId.get(call.id);
      if (!outcome) continue;

      toolsUsed.push(outcome.name);
      const failed = Boolean((outcome.result as { error?: string })?.error);
      if (outcome.acted && !failed) actions.push(outcome.name);

      // Read from the result, not from the intent: a tool that was asked to
      // deliver and returned an error delivered nothing.
      const delivered = deliveredFilename(outcome.result);
      if (delivered) filesDelivered.push(delivered);

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(outcome.result),
      });
    }
  }

  // Out of rounds. Rather than return nothing, ask for a final answer with no
  // tools available so the model must conclude from what it already gathered.
  const final = await chatWithTools("fast", [...compressHistory(messages), {
    role: "user",
    content: "Answer now using only what you have already retrieved. Do not call any more tools.",
  }], [], plan.responseTokens);

  console.log(
    `[veltr][AGENT] done rounds=${maxRounds} tools=${toolsUsed.length} deduped=${memo.size} ${Date.now() - startedAt}ms`
  );

  return settle(
    (final?.message.content ?? "").trim() ||
      "I gathered the data but could not summarise it. Try a narrower question.",
    final?.model ?? model,
    maxRounds
  );
}
