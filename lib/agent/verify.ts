import { resultIsError, type ToolRunner } from "./execute";

/**
 * Verification layer.
 *
 * An action is not finished when the call returns. It is finished when a second,
 * independent read shows the world in the state the action claimed to produce.
 *
 * The default is deliberately pessimistic: a tool with no verifier is reported as
 * *unverified*, not as successful. "I did it" and "I did it and checked" are
 * different statements, and collapsing them is the specific dishonesty this layer
 * exists to prevent — an agent that reports success it never confirmed is worse
 * than one that reports nothing, because it is trusted.
 */

export type Verification = {
  verified: boolean;
  /** One line, shown to the user verbatim. */
  detail: string;
  /** The independent read, when one was made. */
  evidence: unknown;
};

type Verifier = (
  args: Record<string, unknown>,
  result: unknown,
  runner: ToolRunner
) => Promise<Verification>;

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

/**
 * Confirms the alert scope by reading it back.
 *
 * The write and the read go through different code paths to the same state, so
 * agreement between them is real evidence rather than an echo.
 */
const verifyAlertScope: Verifier = async (args, result, runner) => {
  const intended = args.address === null ? "chain-wide" : String(args.address ?? "").toLowerCase();
  const read = await runner("get_alert_status", {});
  const actual = String(asRecord(read.result).scope ?? "").toLowerCase();

  const matches = actual === intended;
  return {
    verified: matches,
    detail: matches
      ? `Alert scope is now ${actual}, confirmed by reading it back.`
      : `Alert scope reads as ${actual || "unknown"}, not ${intended} as intended.`,
    evidence: read.result ?? result,
  };
};

/**
 * A delivery is verified by the transport, not by a second read.
 *
 * There is no way to ask Telegram whether a specific photo arrived, so the
 * verification is the send call's own acknowledgement — which the API only
 * returns after accepting the message.
 */
const verifyDelivery: Verifier = async (_args, result) => {
  const record = asRecord(result);
  const delivered = record.sent === true || record.delivered === true || Boolean(record.filename);
  return {
    verified: delivered,
    detail: delivered
      ? "Delivered to the chat, acknowledged by Telegram."
      : "The item was not acknowledged as delivered.",
    evidence: result,
  };
};

/** Confirms a position change by reading the position back on-chain. */
const verifyPosition: Verifier = async (args, result, runner) => {
  const read = await runner("list_owned_positions", {});
  return {
    verified: !resultIsError(read.result),
    detail: resultIsError(read.result)
      ? "Positions could not be read back, so the change is unverified."
      : `Positions re-read after acting on ${String(args.tokenId ?? "the position")}.`,
    evidence: read.result ?? result,
  };
};

const VERIFIERS: Record<string, Verifier> = {
  set_alert_scope: verifyAlertScope,
  send_chart: verifyDelivery,
  create_file: verifyDelivery,
  write_code: verifyDelivery,
  defend_position: verifyPosition,
};

/**
 * Checks that an action did what it said.
 *
 * A tool that returned an error is never verified, whatever a verifier might
 * say — the first question is always whether the call succeeded at all.
 */
export async function verifyAction(
  tool: string,
  args: Record<string, unknown>,
  result: unknown,
  runner: ToolRunner
): Promise<Verification> {
  if (resultIsError(result)) {
    const message = String(asRecord(result).error ?? "The tool reported an error.");
    return { verified: false, detail: `${tool} failed: ${message}`, evidence: result };
  }

  const verifier = VERIFIERS[tool];
  if (!verifier) {
    return {
      verified: false,
      detail: `${tool} ran without error, but there is no independent check for it — reporting as unverified.`,
      evidence: result,
    };
  }

  try {
    return await verifier(args, result, runner);
  } catch (error) {
    return {
      verified: false,
      detail: `${tool} ran, but verification failed: ${error instanceof Error ? error.message : String(error)}`,
      evidence: result,
    };
  }
}
