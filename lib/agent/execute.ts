import { LIMITS, callFingerprint, withTimeout } from "./budget";
import { redactValue } from "./redact";
import { requiresApproval, riskOf } from "./policy";
import type { PermissionMode, RiskLevel } from "./types";

/**
 * Execution engine.
 *
 * Runs tool calls under the constraints the rest of the core assumes: a timeout,
 * a retry ceiling, deduplication, and — before any of that — the permission gate.
 * The gate is checked here rather than by the caller so there is exactly one path
 * from "the agent wants to do this" to "this happened", and it cannot be
 * bypassed by a caller that forgot to ask.
 *
 * The tool registry is injected. The core does not import lib/tools.ts directly,
 * which keeps the loop testable without the chain client and means the registry
 * can grow without the engine knowing.
 */

export type ToolRunner = (
  tool: string,
  args: Record<string, unknown>
) => Promise<{ name: string; acted: boolean; result: unknown }>;

export type ExecuteOutcome = {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  result: unknown;
  risk: RiskLevel;
  /** True when the tool ran and reported no error. */
  acted: boolean;
  attempts: number;
  /** Set when the call never ran. */
  blocked?: "needs_approval" | "duplicate" | "budget";
};

/**
 * Did the tool report a failure inside a successful call?
 *
 * The registry's convention is to return `{ error }` rather than throw, so a
 * result that is technically a value can still be a failure. Missing this is how
 * an agent ends up reporting an action as done because the call did not throw.
 */
export function resultIsError(result: unknown): boolean {
  return Boolean(result && typeof result === "object" && "error" in (result as Record<string, unknown>));
}

export type ExecuteOptions = {
  mode: PermissionMode;
  /** Fingerprints already run in this mission. */
  seen?: Set<string>;
  /** Pre-approved for this specific call, from an answered permission request. */
  approved?: boolean;
  declaresAction?: boolean;
  timeoutMs?: number;
  maxAttempts?: number;
};

/**
 * Runs one tool call.
 *
 * Retries only what a retry can fix. A tool that returned `{ error: ... }` has
 * answered the question — running it again produces the same answer and bills
 * for it twice — so only a throw or a timeout is retried.
 */
export async function executeCall(
  runner: ToolRunner,
  tool: string,
  args: Record<string, unknown>,
  options: ExecuteOptions
): Promise<ExecuteOutcome> {
  const risk = riskOf(tool, options.declaresAction ?? false);
  const base = { tool, args, risk, acted: false, attempts: 0 };

  if (requiresApproval(risk, options.mode) && !options.approved) {
    return {
      ...base,
      ok: false,
      result: { error: "Requires explicit approval before running." },
      blocked: "needs_approval",
    };
  }

  const fingerprint = callFingerprint(tool, args);
  if (options.seen?.has(fingerprint)) {
    return {
      ...base,
      ok: false,
      result: { error: "Already run in this mission; the earlier result stands." },
      blocked: "duplicate",
    };
  }

  const maxAttempts = options.maxAttempts ?? LIMITS.maxAttempts;
  const timeoutMs = options.timeoutMs ?? LIMITS.toolTimeoutMs;
  let lastError = "Tool did not run.";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const run = await withTimeout(runner(tool, args), timeoutMs, tool).catch((error) => ({
      ok: false as const,
      error: error instanceof Error ? error.message : String(error),
    }));

    if (!run.ok) {
      lastError = redactValue(run.error);
      console.warn(`[veltr][AGENT] tool=${tool} attempt=${attempt}/${maxAttempts} failed: ${lastError}`);
      continue;
    }

    options.seen?.add(fingerprint);

    const failed = resultIsError(run.value.result);
    return {
      ...base,
      ok: !failed,
      result: run.value.result,
      // "Acted" means the world changed. A tool that declares itself an action
      // but returned an error changed nothing, and must never be reported as if
      // it had.
      acted: Boolean(run.value.acted) && !failed,
      attempts: attempt,
    };
  }

  return { ...base, ok: false, result: { error: lastError }, attempts: maxAttempts };
}

/** The live registry as a runner. Lazy so the core stays importable without viem. */
export async function registryRunner(chatId?: string | null): Promise<ToolRunner> {
  const { invokeTool } = await import("../tools");
  return async (tool, args) => {
    const invocation = await invokeTool(tool, args, { chatId: chatId ?? null });
    return { name: invocation.name, acted: invocation.acted, result: invocation.result };
  };
}

/** Whether the registry itself declares a tool an action, for the risk floor. */
export async function declaredActions(): Promise<Set<string>> {
  const { TOOLS } = await import("../tools");
  const { EXTENDED_TOOLS } = await import("../tools-extended");
  return new Set([...TOOLS, ...EXTENDED_TOOLS].filter((t) => t.acts).map((t) => t.name));
}
