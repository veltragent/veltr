import { NextResponse } from "next/server";
import { healthReport } from "@/lib/health";

export const dynamic = "force-dynamic";

/**
 * Liveness and readiness for whatever is hosting this.
 *
 * Deliberately unauthenticated and deliberately thin: a health check runs every
 * few seconds, so it must not read the chain, call a provider, or spend
 * anything. It answers one question — is this process able to do its job.
 *
 * Two things can say no. A state directory it cannot write to, which on a host
 * with no mounted volume is the failure that loses every subscriber on the next
 * deploy. And a background loop that has stopped reporting, which is the failure
 * nothing outside the process could otherwise see: the port still answers and
 * questions still get replies while alerts have silently stopped forever.
 *
 * It reports whether this instance holds the scheduler lease rather than
 * treating that as failure. A standby instance is healthy: it serves HTTP and
 * waits, which is exactly what it should do when another instance is driving.
 *
 * No secret, chat id or subscriber count is exposed. A public endpoint that
 * leaks how many people use a product is a small thing that cannot be taken
 * back.
 */
export async function GET() {
  const { httpStatus, body } = await healthReport();
  return NextResponse.json(body, { status: httpStatus });
}
