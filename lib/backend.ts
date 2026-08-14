/**
 * Where the stateful half of the product lives.
 *
 * The website and the agent split cleanly: every page reads the chain and the
 * market APIs directly and touches no stored state, while six API routes — the
 * Telegram sync, subscriptions, the watcher, the brief, missions and the Finnhub
 * webhook — read and write the state file.
 *
 * That makes a two-host deployment possible: pages on a CDN, the agent on a host
 * with a disk and a process that stays alive. What it needs is for the handful of
 * browser-side calls to reach the agent rather than the CDN.
 *
 * The important case is `/api/telegram/sync`. Its POST drains Telegram updates.
 * Called against a second host it becomes a second `getUpdates` consumer, and
 * Telegram answers one of them with "Conflict: terminated by other getUpdates
 * request" while messages are answered at random by whichever won. That is not a
 * hypothetical — it happened here with two local instances.
 *
 * Unset, everything is same-origin and a single-host deployment behaves exactly
 * as before.
 */

/** Public because the browser reads it; it is a URL, not a secret. */
const BACKEND = process.env.NEXT_PUBLIC_VELTR_BACKEND_URL?.trim().replace(/\/+$/, "") ?? "";

/**
 * Resolves an API path against the backend, or leaves it same-origin.
 *
 * `path` is expected to start with "/api/".
 */
export function backendUrl(path: string): string {
  if (!BACKEND) return path;
  return `${BACKEND}${path.startsWith("/") ? path : `/${path}`}`;
}

/** True when the stateful half is deployed somewhere else. */
export function hasSeparateBackend(): boolean {
  return BACKEND.length > 0;
}
