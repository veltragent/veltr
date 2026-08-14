/**
 * Process-local TTL cache.
 *
 * Discovery (which ERC-20s implement ERC-8056) changes only when Robinhood lists
 * a new symbol, so it is cached far longer than multiplier state. Serving stale
 * data while a refresh is in flight keeps a slow chain read from blocking a page.
 *
 * Single-instance only — move to Redis before running more than one server.
 */
type Entry<T> = { value: T; expires: number; refreshing?: Promise<T> };

const store = new Map<string, Entry<unknown>>();

/**
 * `isValid` guards against caching a degenerate result.
 *
 * Without it, one throttled RPC call that returns an empty token set gets stored
 * for the full TTL and the product serves nothing for half an hour — with no
 * error anywhere, because an empty array is a perfectly valid value. A failed
 * load must not become the cached truth.
 */
export async function cached<T>(
  key: string,
  ttlMs: number,
  load: () => Promise<T>,
  isValid: (value: T) => boolean = () => true
): Promise<T> {
  const hit = store.get(key) as Entry<T> | undefined;
  const now = Date.now();

  if (hit && hit.expires > now) return hit.value;

  if (hit) {
    // Stale-while-revalidate: hand back the old value, refresh in background.
    if (!hit.refreshing) {
      hit.refreshing = load()
        .then((value) => {
          if (isValid(value)) {
            store.set(key, { value, expires: Date.now() + ttlMs });
            return value;
          }
          console.warn(`[veltr] rejected invalid refresh for ${key}; keeping previous value`);
          hit.refreshing = undefined;
          return hit.value;
        })
        .catch((error) => {
          console.warn(`[veltr] cache refresh failed for ${key}:`, error);
          hit.refreshing = undefined;
          return hit.value;
        });
    }
    return hit.value;
  }

  const value = await load();
  if (isValid(value)) {
    store.set(key, { value, expires: now + ttlMs });
  } else {
    console.warn(`[veltr] not caching invalid result for ${key}; will retry next call`);
  }
  return value;
}
