/**
 * Shared key-value store, for the few things that must be true across instances.
 *
 * Deliberately narrow. Redis is not a cache layer here — the process-local TTL
 * cache stays exactly where it is, because it is read on every page render and
 * every tool call, and routing that through a network round trip would spend the
 * entire command budget on data that is perfectly correct when duplicated per
 * instance. A few extra cache misses cost nothing; the command quota is finite.
 *
 * What genuinely has to be shared is smaller: which instance holds the scheduler
 * lease, and the counters that guard a per-IP provider limit. Two replicas each
 * politely staying under 20 GeckoTerminal calls a minute make 40 against a limit
 * of 30 — a bug no amount of per-process care can fix.
 *
 * Upstash over REST rather than a TCP client: there is no connection pool to
 * manage, it works unchanged from a serverless function if the website ever
 * needs it, and a failed request is an ordinary HTTP failure rather than a
 * socket in an unknown state.
 *
 * Without credentials every function here falls back to process-local memory, so
 * a single instance behaves exactly as it did before Redis existed.
 */

const URL_ENV = "UPSTASH_REDIS_REST_URL";
const TOKEN_ENV = "UPSTASH_REDIS_REST_TOKEN";

/** Prefixed so one database can host several environments without collision. */
const NAMESPACE = process.env.VELTR_KV_NAMESPACE?.trim() || "veltr";

function config(): { url: string; token: string } | null {
  const url = process.env[URL_ENV]?.trim().replace(/\/+$/, "");
  const token = process.env[TOKEN_ENV]?.trim();
  if (!url || !token) return null;
  return { url, token };
}

export function kvAvailable(): boolean {
  return config() !== null;
}

const key = (name: string) => `${NAMESPACE}:${name}`;

/* ------------------------------------------------------- Local fallback */

type LocalEntry = { value: string; expiresAt: number };
const local = new Map<string, LocalEntry>();

function localGet(k: string): string | null {
  const hit = local.get(k);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    local.delete(k);
    return null;
  }
  return hit.value;
}

/** Test seam, and the reset a fresh process gets for free. */
export function resetLocalKv(): void {
  local.clear();
}

/* ---------------------------------------------------------- Transport */

type Command = (string | number)[];

/**
 * Sends one command.
 *
 * Never throws. A key-value store that is unreachable must degrade the thing it
 * was guarding, not take down the caller — the scheduler falling back to its
 * file-based lease is far better than the scheduler crashing.
 */
async function send<T>(command: Command, timeoutMs = 5_000): Promise<T | null> {
  const cfg = config();
  if (!cfg) return null;

  try {
    const res = await fetch(cfg.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      // The token is never logged; only the status is useful anyway.
      console.warn(`[veltr][KV] ${command[0]} failed status=${res.status}`);
      return null;
    }

    const json = (await res.json()) as { result?: T; error?: string };
    if (json.error) {
      console.warn(`[veltr][KV] ${command[0]} error=${json.error.slice(0, 120)}`);
      return null;
    }
    return (json.result ?? null) as T | null;
  } catch (error) {
    const timedOut = error instanceof Error && /timeout|abort/i.test(error.name + error.message);
    console.warn(`[veltr][KV] ${command[0]} ${timedOut ? "timed out" : "unreachable"}`);
    return null;
  }
}

/* -------------------------------------------------------------- Values */

export async function kvGet(name: string): Promise<string | null> {
  if (!kvAvailable()) return localGet(key(name));
  return send<string>(["GET", key(name)]);
}

export async function kvSet(name: string, value: string, ttlMs: number): Promise<void> {
  if (!kvAvailable()) {
    local.set(key(name), { value, expiresAt: Date.now() + ttlMs });
    return;
  }
  await send(["SET", key(name), value, "PX", ttlMs]);
}

export async function kvDel(name: string): Promise<void> {
  if (!kvAvailable()) {
    local.delete(key(name));
    return;
  }
  await send(["DEL", key(name)]);
}

/**
 * Increments a counter that expires as a whole.
 *
 * The TTL is set only when the counter is created, so a window is a fixed period
 * from its first hit rather than one that slides forward forever — which is what
 * a naive `INCR` plus `EXPIRE` on every call produces, and it never resets.
 *
 * Returns null when the store is unreachable, so the caller can decide whether
 * to fall back rather than being handed a fabricated count.
 */
export async function kvIncr(name: string, windowMs: number): Promise<number | null> {
  if (!kvAvailable()) {
    const k = key(name);
    const current = Number(localGet(k) ?? 0) + 1;
    const existing = local.get(k);
    local.set(k, {
      value: String(current),
      expiresAt: existing && existing.expiresAt > Date.now() ? existing.expiresAt : Date.now() + windowMs,
    });
    return current;
  }

  const script = `
    local n = redis.call('INCR', KEYS[1])
    if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
    return n
  `;
  return send<number>(["EVAL", script, 1, key(name), windowMs]);
}

/* --------------------------------------------------------------- Lease */

/**
 * Takes a lease, or renews one already held.
 *
 * One round trip, and atomic: the read and the write happen inside Redis, so two
 * instances racing for a free lease cannot both win. Doing this as GET then SET
 * from the client leaves a window between them that is exactly the failure the
 * lease exists to prevent.
 */
export async function kvAcquire(name: string, holder: string, ttlMs: number): Promise<boolean | null> {
  if (!kvAvailable()) return null;

  const script = `
    local current = redis.call('GET', KEYS[1])
    if current == false or current == ARGV[1] then
      redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
      return 1
    end
    return 0
  `;
  const result = await send<number>(["EVAL", script, 1, key(name), holder, ttlMs]);
  return result === null ? null : result === 1;
}

/** Releases a lease, but only if we still hold it. */
export async function kvRelease(name: string, holder: string): Promise<void> {
  if (!kvAvailable()) return;

  const script = `
    if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
    return 0
  `;
  await send(["EVAL", script, 1, key(name), holder]);
}

/**
 * Who holds a lease right now, and for how much longer.
 *
 * The remaining time is read rather than assumed: a standby instance reports
 * when it expects to be able to take over, and inventing that number would make
 * the log line say something nobody checked.
 */
export async function kvHolder(name: string): Promise<{ holder: string; ttlMs: number | null } | null> {
  if (!kvAvailable()) return null;
  const holder = await send<string>(["GET", key(name)]);
  if (!holder) return null;

  // Negative replies mean no key (-2) or no expiry (-1); neither is a duration.
  const pttl = await send<number>(["PTTL", key(name)]);
  return { holder, ttlMs: typeof pttl === "number" && pttl >= 0 ? pttl : null };
}

/** Round-trip check used by the health endpoint. */
export async function kvPing(): Promise<{ ok: boolean; ms: number } | null> {
  if (!kvAvailable()) return null;
  const started = Date.now();
  const pong = await send<string>(["PING"], 3_000);
  return { ok: pong === "PONG", ms: Date.now() - started };
}
