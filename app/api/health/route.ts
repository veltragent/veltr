import { NextResponse } from "next/server";
import { access, constants } from "node:fs/promises";
import { dataDir } from "@/lib/paths";
import { leaseHolder } from "@/lib/lease";

export const dynamic = "force-dynamic";

/**
 * Liveness and readiness for whatever is hosting this.
 *
 * Deliberately unauthenticated and deliberately thin: a health check runs every
 * few seconds, so it must not read the chain, call a provider, or spend
 * anything. It answers one question — is this process able to do its job — and
 * the only thing that can stop it is a state directory it cannot write to.
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
  const startedAt = Date.now();

  let storage: "writable" | "unwritable" = "unwritable";
  try {
    await access(dataDir(), constants.W_OK);
    storage = "writable";
  } catch {
    // Left as unwritable: on a host with no mounted volume this is the failure
    // that loses every subscriber on the next deploy, and it should be loud.
  }

  const lease = await leaseHolder("scheduler").catch(() => null);
  const schedulerHeld = Boolean(lease);

  const healthy = storage === "writable";

  return NextResponse.json(
    {
      status: healthy ? "ok" : "degraded",
      storage,
      // "standby" is a normal, correct state — not an error.
      scheduler: schedulerHeld ? "running" : "standby",
      uptimeSeconds: Math.round(process.uptime()),
      checkedInMs: Date.now() - startedAt,
    },
    { status: healthy ? 200 : 503 }
  );
}
