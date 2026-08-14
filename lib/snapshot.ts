import { cache } from "react";
import { buildRadarSnapshot, type RadarSnapshot } from "./tokens";
import { publicClient } from "./chain";

export type SnapshotResult =
  | { ok: true; snapshot: RadarSnapshot }
  | { ok: false; error: string };

/**
 * Deduped per render pass. Page-level `revalidate` controls how often the
 * multicall actually re-runs; the Blockscout leg is cached independently by
 * fetch's own revalidate window.
 */
export const getSnapshot = cache(async (): Promise<SnapshotResult> => {
  try {
    const [snapshot, blockNumber] = await Promise.all([
      buildRadarSnapshot(),
      publicClient.getBlockNumber().catch(() => null),
    ]);
    return { ok: true, snapshot: { ...snapshot, blockNumber: blockNumber?.toString() ?? null } };
  } catch (error) {
    console.error("[veltr] snapshot failed:", error);
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Unable to read Robinhood Chain. The public RPC is rate-limited.",
    };
  }
});
