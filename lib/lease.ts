import { randomUUID } from "node:crypto";
import { mutateState, readState } from "./store";
import { kvAcquire, kvAvailable, kvHolder, kvRelease } from "./kv";

/**
 * Single-writer lease for the background scheduler.
 *
 * The failure this prevents has already happened here. A second instance was
 * started while the first was running, and Telegram answered the long-poll with:
 *
 *   Conflict: terminated by other getUpdates request
 *
 * Two pollers steal each other's updates, so messages are answered at random by
 * one instance or the other; two watchers each detect the same corporate action;
 * two monitors each send the alert. None of that is visible in a health check —
 * the second instance looks perfectly healthy while quietly halving the first.
 *
 * So the loops are gated on a lease. Exactly one process runs them; the others
 * serve HTTP and stay quiet. A lease is time-limited and heartbeated, so a
 * crashed holder is replaced automatically rather than blocking the product
 * until someone notices.
 *
 * Two backings, chosen at call time. With Redis configured the lease lives there
 * and is correct across machines; without it the lease lives in the shared state
 * file and is correct for several processes on one machine — which is the case
 * that actually broke here.
 *
 * The fallback is not a lesser mode to be embarrassed about: a single instance
 * with a volume needs nothing more, and a Redis outage should cost you
 * cross-machine coordination rather than the scheduler itself.
 */

export type Lease = {
  holder: string;
  /** ISO timestamp after which the lease may be taken by someone else. */
  expiresAt: string;
  renewedAt: string;
};

/** This process, for the life of this process. */
export const INSTANCE_ID = `${process.pid}-${randomUUID().slice(0, 8)}`;

/**
 * How long a lease survives without a heartbeat.
 *
 * Long enough that an event-loop stall does not hand the scheduler to another
 * instance mid-pass; short enough that a crash is recovered from in under a
 * minute rather than leaving the product silent.
 */
export const LEASE_TTL_MS = 45_000;

/**
 * Renewed at two thirds of the TTL, so one heartbeat may be missed before expiry.
 *
 * Chosen against the Upstash command budget rather than arbitrarily: at 15s this
 * one timer alone would spend roughly 175,000 commands a month, a third of the
 * free tier, to do nothing but say "still here".
 */
export const HEARTBEAT_MS = 30_000;

function expired(lease: Lease | null | undefined, now: Date): boolean {
  if (!lease) return true;
  return new Date(lease.expiresAt).getTime() <= now.getTime();
}

/**
 * Takes the lease if it is free, or renews it if we already hold it.
 *
 * The read and the write happen inside one queued mutation, so two processes
 * racing for a free lease cannot both win: the second sees the first's write.
 */
export async function acquireLease(
  name: string,
  options: { holder?: string; now?: Date; ttlMs?: number } = {}
): Promise<boolean> {
  const holder = options.holder ?? INSTANCE_ID;
  const now = options.now ?? new Date();
  const ttl = options.ttlMs ?? LEASE_TTL_MS;

  // One atomic round trip when Redis is configured; the file is the fallback.
  if (kvAvailable()) {
    const taken = await kvAcquire(name, holder, ttl);
    if (taken !== null) return taken;
    console.warn("[veltr][LEASE] Redis unreachable; falling back to the state file");
  }

  return mutateState<boolean>((state) => {
    const leases = state.leases ?? {};
    const current = leases[name];

    const mine = current?.holder === holder;
    if (!mine && !expired(current, now)) return { state, result: false };

    const lease: Lease = {
      holder,
      expiresAt: new Date(now.getTime() + ttl).toISOString(),
      renewedAt: now.toISOString(),
    };

    return { state: { ...state, leases: { ...leases, [name]: lease } }, result: true };
  });
}

/**
 * Renews a lease we hold. Returns false if it was lost.
 *
 * Losing a lease is not an error to retry through — it means another instance
 * has taken over, and continuing to run the loops would recreate the exact
 * double-poll this exists to prevent. The caller must stop.
 */
export async function renewLease(
  name: string,
  options: { holder?: string; now?: Date; ttlMs?: number } = {}
): Promise<boolean> {
  const holder = options.holder ?? INSTANCE_ID;
  const now = options.now ?? new Date();
  const ttl = options.ttlMs ?? LEASE_TTL_MS;

  // kvAcquire renews for the same holder, so acquire and renew are one call.
  if (kvAvailable()) {
    const held = await kvAcquire(name, holder, ttl);
    if (held !== null) return held;
    console.warn("[veltr][LEASE] Redis unreachable during renew; falling back");
  }

  return mutateState<boolean>((state) => {
    const leases = state.leases ?? {};
    const current = leases[name];

    // Taking it back after expiry is deliberate: a brief stall should not hand
    // the scheduler away permanently when nobody else has claimed it.
    if (current && current.holder !== holder && !expired(current, now)) {
      return { state, result: false };
    }

    const lease: Lease = {
      holder,
      expiresAt: new Date(now.getTime() + ttl).toISOString(),
      renewedAt: now.toISOString(),
    };

    return { state: { ...state, leases: { ...leases, [name]: lease } }, result: true };
  });
}

/** Gives up a lease so a restart does not have to wait out the TTL. */
export async function releaseLease(name: string, holder = INSTANCE_ID): Promise<void> {
  if (kvAvailable()) await kvRelease(name, holder);

  await mutateState((state) => {
    const leases = { ...(state.leases ?? {}) };
    if (leases[name]?.holder === holder) delete leases[name];
    return { state: { ...state, leases }, result: undefined };
  });
}

export async function leaseHolder(name: string): Promise<Lease | null> {
  if (kvAvailable()) {
    const holder = await kvHolder(name);
    // Redis stores only the holder; the expiry lives in its own TTL.
    if (holder) return { holder, expiresAt: "(redis ttl)", renewedAt: "(redis)" };
  }
  return (await readState()).leases?.[name] ?? null;
}

export type LeaseHandle = { stop: () => void };

/**
 * Holds a lease for as long as the process is alive.
 *
 * `onLost` fires if another instance takes over, which is the signal to stop
 * doing whatever the lease was protecting. The timer is unref'd so holding a
 * lease never keeps a process alive on its own.
 */
export function keepLease(name: string, onLost: () => void): LeaseHandle {
  const timer = setInterval(async () => {
    try {
      if (!(await renewLease(name))) {
        console.warn(`[veltr][LEASE] lost "${name}" to another instance; standing down`);
        clearInterval(timer);
        onLost();
      }
    } catch (error) {
      console.warn(`[veltr][LEASE] renew failed:`, error instanceof Error ? error.message : error);
    }
  }, HEARTBEAT_MS);

  timer.unref?.();

  const release = () => {
    clearInterval(timer);
    void releaseLease(name).catch(() => {});
  };

  // Best effort: a clean shutdown frees the lease immediately so a redeploy does
  // not sit idle waiting for it to expire.
  process.once("SIGINT", release);
  process.once("SIGTERM", release);
  process.once("beforeExit", release);

  return { stop: release };
}
