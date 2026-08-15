/**
 * Provider transport.
 *
 * Every market call goes through here so timeout, retry, 429 handling and the
 * request budget are defined once rather than per provider. A provider that is
 * being rate-limited is put to sleep for the whole process — the limits below are
 * per API key, and there is no key, so they are per IP and therefore shared by
 * every user of this instance.
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export type FetchLike = typeof fetch;

export type ProviderTag = "DEXSCREENER" | "GECKOTERMINAL";

type Budget = {
  /** Requests permitted inside the trailing window. */
  limit: number;
  windowMs: number;
  hits: number[];
  /** Epoch ms before which no request is attempted, set by a 429. */
  cooldownUntil: number;
};

/**
 * Documented ceilings, with headroom.
 *
 * GeckoTerminal's free public API states 30 calls/minute; DexScreener documents
 * 300/minute on the token endpoints. Both are set below the published figure
 * because the website shares this process and its own market calls count too.
 */
const BUDGETS: Record<ProviderTag, Budget> = {
  GECKOTERMINAL: { limit: 20, windowMs: 60_000, hits: [], cooldownUntil: 0 },
  DEXSCREENER: { limit: 200, windowMs: 60_000, hits: [], cooldownUntil: 0 },
};

/** Reason a provider is currently unavailable, for the caller's log line. */
export type ProviderFailure = { provider: ProviderTag; status: number | "timeout" | "error" };

function budgetAllows(budget: Budget, now: number): boolean {
  if (now < budget.cooldownUntil) return false;
  budget.hits = budget.hits.filter((t) => now - t < budget.windowMs);
  return budget.hits.length < budget.limit;
}

/**
 * The same budget, counted across every instance.
 *
 * These limits are enforced by the provider per IP, not per process. Two
 * replicas each politely staying under twenty GeckoTerminal calls a minute make
 * forty against a published limit of thirty — and every process involved
 * believes it behaved. Only a shared counter can see that.
 *
 * The window is the wall clock rounded down, so every instance agrees which
 * minute it is without needing to agree on anything else.
 *
 * Returns true when the store is unreachable: a key-value outage must not stop
 * the product from reading a price. The process-local budget still applies, so
 * the fallback is exactly the old behaviour.
 */
async function sharedBudgetAllows(provider: ProviderTag, budget: Budget, now: number): Promise<boolean> {
  const { kvAvailable, kvIncr } = await import("../kv");
  if (!kvAvailable()) return true;

  const window = Math.floor(now / budget.windowMs);
  const used = await kvIncr(`budget:${provider}:${window}`, budget.windowMs * 2);
  if (used === null) return true;

  if (used > budget.limit) {
    console.warn(
      `[veltr][${provider}] shared budget exhausted: ${used}/${budget.limit} across all instances this window`
    );
    return false;
  }
  return true;
}

/** Test seam: clears the process-wide budget between cases. */
export function resetBudgets(): void {
  for (const budget of Object.values(BUDGETS)) {
    budget.hits = [];
    budget.cooldownUntil = 0;
  }
}

export function budgetSnapshot(): Record<ProviderTag, { used: number; limit: number; coolingForMs: number }> {
  const now = Date.now();
  const out = {} as Record<ProviderTag, { used: number; limit: number; coolingForMs: number }>;
  for (const [tag, budget] of Object.entries(BUDGETS) as [ProviderTag, Budget][]) {
    out[tag] = {
      used: budget.hits.filter((t) => now - t < budget.windowMs).length,
      limit: budget.limit,
      coolingForMs: Math.max(0, budget.cooldownUntil - now),
    };
  }
  return out;
}

export type GetJsonOptions = {
  timeoutMs?: number;
  retries?: number;
  fetchImpl?: FetchLike;
  /** Redacted in logs; only the token address is ever printed. */
  subject?: string;
};

/**
 * GETs JSON, or returns null.
 *
 * Never throws. A market provider going down must degrade the reading, not take
 * out the watcher pass that reads twenty other tokens — so the caller's contract
 * is "data or nothing", and the decision about what nothing means belongs to the
 * aggregator.
 */
export async function getJson<T>(
  provider: ProviderTag,
  url: string,
  options: GetJsonOptions = {}
): Promise<T | null> {
  const { timeoutMs = 12_000, retries = 1, fetchImpl = fetch, subject } = options;
  const budget = BUDGETS[provider];

  for (let attempt = 0; attempt <= retries; attempt++) {
    const now = Date.now();

    if (!budgetAllows(budget, now)) {
      const waiting = Math.max(0, budget.cooldownUntil - now);
      console.warn(
        `[veltr][${provider}] request skipped${subject ? ` token=${subject}` : ""} reason=${
          waiting > 0 ? `cooling_off_${Math.ceil(waiting / 1000)}s` : "local_budget_exhausted"
        }`
      );
      return null;
    }

    // Checked after the local budget, so an instance that is already over its own
    // share never spends a shared counter increment to find that out.
    if (!(await sharedBudgetAllows(provider, budget, now))) {
      console.warn(
        `[veltr][${provider}] request skipped${subject ? ` token=${subject}` : ""} reason=shared_budget_exhausted`
      );
      return null;
    }

    budget.hits.push(now);

    try {
      const res = await fetchImpl(url, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (res.status === 429) {
        // Respect Retry-After when offered; otherwise sit out the rest of the
        // window. Retrying immediately is what turns a throttle into a ban.
        const header = Number(res.headers?.get?.("retry-after"));
        const waitMs = Number.isFinite(header) && header > 0 ? header * 1000 : 60_000;
        budget.cooldownUntil = Date.now() + waitMs;
        console.warn(
          `[veltr][${provider}] request failed${subject ? ` token=${subject}` : ""} status=429 backoff=${Math.round(
            waitMs / 1000
          )}s`
        );
        return null;
      }

      if (!res.ok) {
        console.warn(
          `[veltr][${provider}] request failed${subject ? ` token=${subject}` : ""} status=${res.status}`
        );
        // 4xx is a bad request, not bad luck — retrying cannot change the answer.
        if (res.status < 500 || attempt === retries) return null;
        continue;
      }

      return (await res.json()) as T;
    } catch (error) {
      const timedOut = error instanceof Error && /timeout|abort/i.test(error.name + error.message);
      console.warn(
        `[veltr][${provider}] request failed${subject ? ` token=${subject}` : ""} status=${
          timedOut ? "timeout" : "error"
        }`
      );
      if (attempt === retries) return null;
    }
  }

  return null;
}

/** Splits addresses into provider-sized batches. Both providers cap at 30. */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
