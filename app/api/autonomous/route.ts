import { NextResponse } from "next/server";
import { isAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  DELEGATES,
  DEFAULT_DELEGATE,
  DEFENSIVE_POLICY,
  readDelegationStatus,
  verifyDelegateDeployed,
} from "@/lib/autonomous";

export const dynamic = "force-dynamic";

/** Derives the configured accounts without ever exposing their keys. */
function accounts() {
  const delegatorKey = process.env.VELTR_DELEGATOR_PRIVATE_KEY;
  const sessionKey = process.env.VELTR_SESSION_PRIVATE_KEY;
  return {
    delegator: delegatorKey ? privateKeyToAccount(delegatorKey as Address).address : null,
    sessionKey: sessionKey ? privateKeyToAccount(sessionKey as Address).address : null,
  };
}

/**
 * Reports readiness for the autonomous tier: which delegate implementations are
 * live on this chain, what the session key would be allowed to do, and whether
 * the delegating account is funded and delegated yet.
 */
export async function GET(request: Request) {
  const override = new URL(request.url).searchParams.get("address");
  if (override && !isAddress(override)) {
    return NextResponse.json({ error: "Invalid address." }, { status: 400 });
  }

  const { delegator, sessionKey } = accounts();
  const target = (override as Address | null) ?? (delegator as Address | null);

  try {
    const [delegateStatus, status] = await Promise.all([
      Promise.all(DELEGATES.map(verifyDelegateDeployed)),
      target ? readDelegationStatus(target) : Promise.resolve(null),
    ]);

    const blockers: string[] = [];
    if (!delegator) blockers.push("VELTR_DELEGATOR_PRIVATE_KEY not configured.");
    if (!sessionKey) blockers.push("VELTR_SESSION_PRIVATE_KEY not configured.");
    if (status && !status.funded) {
      blockers.push(`Delegating account holds ${status.balanceEth.toFixed(6)} ETH — needs gas.`);
    }
    if (status && !status.delegated) {
      blockers.push("Account has not delegated yet — no EIP-7702 authorization on chain.");
    }

    return NextResponse.json({
      chainId: 4663,
      accounts: { delegator, sessionKey },
      selectedDelegate: DEFAULT_DELEGATE,
      delegates: delegateStatus,
      policy: DEFENSIVE_POLICY,
      status,
      ready: blockers.length === 0,
      blockers,
    });
  } catch (error) {
    console.error("[veltr] autonomous status failed:", error);
    return NextResponse.json({ error: "Chain read failed." }, { status: 502 });
  }
}
