import { join, isAbsolute } from "node:path";

/**
 * Where runtime state lives.
 *
 * Defaults to `./data`, which is what a local checkout wants and what the
 * project has always used. A deployment wants something else: the state file
 * holds subscribers, watchlists, missions, tracks and the Telegram cursor, so it
 * has to sit on a disk that survives a redeploy rather than inside the image.
 *
 * Point `VELTR_DATA_DIR` at a mounted volume and nothing else changes. Without
 * it, every deploy starts with an empty subscriber list and a reset long-poll
 * cursor — which reprocesses old messages and loses everyone's watchlists.
 *
 * Resolved per call rather than at import, so the working directory is read when
 * it is actually needed. Tests rely on that: they move to a sandbox before
 * touching the store.
 */
export function dataDir(): string {
  const configured = process.env.VELTR_DATA_DIR?.trim();
  if (!configured) return join(process.cwd(), "data");
  return isAbsolute(configured) ? configured : join(process.cwd(), configured);
}

export function dataFile(name: string): string {
  return join(dataDir(), name);
}
