import { parseAbiItem, type Address, type Log } from "viem";
import { logsClient, WAD } from "./chain";
import { cached } from "./cache";

export const UI_MULTIPLIER_UPDATED = parseAbiItem(
  "event UIMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier, uint256 effectiveAtTimestamp)"
);

export type CorporateAction = {
  id: string;
  token: Address;
  symbol: string | null;
  blockNumber: string;
  /** When the action was committed on-chain. */
  committedAt: number;
  /** When it becomes effective, as declared by the contract. */
  effectiveAt: number;
  oldMultiplier: number;
  newMultiplier: number;
  /** Percent change applied to effective exposure. */
  deltaPct: number;
  /**
   * Hours between commitment and effect — the window in which a holder could
   * still act. Negative means the action was committed after it took effect.
   */
  leadTimeHours: number;
  kind: "split" | "distribution" | "adjustment";
  txHash: string;
};

/**
 * A 4× jump is a split; sub-percent creep is a reinvested distribution.
 * Anything between is reported neutrally rather than guessed at.
 */
function classifyAction(oldM: number, newM: number): CorporateAction["kind"] {
  const ratio = oldM === 0 ? 1 : newM / oldM;
  if (Math.abs(ratio - Math.round(ratio)) < 1e-6 && Math.round(ratio) !== 1) return "split";
  if (Math.abs(ratio - 1) < 0.05) return "distribution";
  return "adjustment";
}

type RawLog = Log<bigint, number, false, typeof UI_MULTIPLIER_UPDATED>;

/**
 * Full corporate-action history for the given tokens.
 *
 * The chain's public RPC accepts an unbounded block range across all token
 * addresses in a single request, so no chunking or indexer is required — the
 * complete history is one call.
 */
export async function fetchCorporateActions(
  tokens: { address: Address; symbol: string }[]
): Promise<CorporateAction[]> {
  if (tokens.length === 0) return [];

  const key = `actions:${tokens.length}`;
  return cached(key, 5 * 60_000, async () => {
    const logs = (await logsClient.getLogs({
      address: tokens.map((t) => t.address),
      event: UI_MULTIPLIER_UPDATED,
      fromBlock: 0n,
      toBlock: "latest",
    })) as RawLog[];

    // Block timestamps tell us when an action was committed; only a handful of
    // distinct blocks are ever involved, so this stays cheap.
    const blocks = [...new Set(logs.map((l) => l.blockNumber!))];
    const blockTimes = new Map<bigint, number>();
    await Promise.all(
      blocks.map(async (bn) => {
        try {
          const block = await logsClient.getBlock({ blockNumber: bn });
          blockTimes.set(bn, Number(block.timestamp));
        } catch {
          /* leave unset; rendered as unknown */
        }
      })
    );

    const symbolByAddress = new Map(tokens.map((t) => [t.address.toLowerCase(), t.symbol]));

    const actions = logs.map((log): CorporateAction => {
      const oldMultiplier = Number(log.args.oldMultiplier!) / Number(WAD);
      const newMultiplier = Number(log.args.newMultiplier!) / Number(WAD);
      const effectiveAt = Number(log.args.effectiveAtTimestamp!);
      const committedAt = blockTimes.get(log.blockNumber!) ?? 0;

      return {
        id: `${log.transactionHash}-${log.logIndex}`,
        token: log.address,
        symbol: symbolByAddress.get(log.address.toLowerCase()) ?? null,
        blockNumber: log.blockNumber!.toString(),
        committedAt,
        effectiveAt,
        oldMultiplier,
        newMultiplier,
        deltaPct: oldMultiplier === 0 ? 0 : (newMultiplier / oldMultiplier - 1) * 100,
        leadTimeHours: committedAt ? (effectiveAt - committedAt) / 3600 : 0,
        kind: classifyAction(oldMultiplier, newMultiplier),
        txHash: log.transactionHash!,
      };
    });

    actions.sort((a, b) => b.effectiveAt - a.effectiveAt || Number(b.blockNumber) - Number(a.blockNumber));
    return actions;
  });
}

export type ActionStats = {
  total: number;
  splits: number;
  distributions: number;
  tokensAffected: number;
  medianLeadTimeHours: number | null;
  earliest: number | null;
  latest: number | null;
};

export function summariseActions(actions: CorporateAction[]): ActionStats {
  const withLead = actions.map((a) => a.leadTimeHours).filter((h) => Number.isFinite(h) && h !== 0);
  withLead.sort((a, b) => a - b);

  const median = withLead.length
    ? withLead.length % 2
      ? withLead[(withLead.length - 1) / 2]
      : (withLead[withLead.length / 2 - 1] + withLead[withLead.length / 2]) / 2
    : null;

  const times = actions.map((a) => a.effectiveAt).filter(Boolean);

  return {
    total: actions.length,
    splits: actions.filter((a) => a.kind === "split").length,
    distributions: actions.filter((a) => a.kind === "distribution").length,
    tokensAffected: new Set(actions.map((a) => a.token.toLowerCase())).size,
    medianLeadTimeHours: median,
    earliest: times.length ? Math.min(...times) : null,
    latest: times.length ? Math.max(...times) : null,
  };
}
