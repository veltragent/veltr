import type { Address } from "viem";

const BASE = "https://robinhoodchain.blockscout.com/api/v2";

export type BlockscoutToken = {
  address_hash: Address;
  symbol: string;
  name: string;
  decimals: string | null;
  holders_count: string | null;
  total_supply: string | null;
  exchange_rate: string | null;
  volume_24h: string | null;
  circulating_market_cap: string | null;
  icon_url: string | null;
  type: string;
};

/**
 * Blockscout is fully public here — no API key, no auth header. It supplies the
 * off-chain half of each row (USD price, 24h volume, holder count, official
 * Robinhood CDN logo) that the chain itself does not carry.
 */
export async function fetchErc20Tokens(maxPages = 12): Promise<BlockscoutToken[]> {
  const out: BlockscoutToken[] = [];
  let url: string | null = `${BASE}/tokens?type=ERC-20`;

  for (let page = 0; page < maxPages && url; page++) {
    const res: Response = await fetch(url, { next: { revalidate: 120 } });
    if (!res.ok) break;

    const json = (await res.json()) as {
      items?: BlockscoutToken[];
      next_page_params?: Record<string, string> | null;
    };

    out.push(...(json.items ?? []));
    const params = json.next_page_params;
    url = params ? `${BASE}/tokens?type=ERC-20&${new URLSearchParams(params).toString()}` : null;
  }

  return out;
}

/** Top holders of one token — used to offer a live example address to audit. */
export async function fetchTokenHolders(token: string, limit = 8) {
  const res = await fetch(`${BASE}/tokens/${token}/holders`, { next: { revalidate: 600 } });
  if (!res.ok) return [];
  const json = (await res.json()) as {
    items?: Array<{ address: { hash: Address; is_contract: boolean }; value: string }>;
  };
  return (json.items ?? []).slice(0, limit);
}

export async function fetchAddressTokenBalances(address: string) {
  const res = await fetch(`${BASE}/addresses/${address}/token-balances`, {
    next: { revalidate: 30 },
  });
  if (!res.ok) return [];
  return (await res.json()) as Array<{ token: BlockscoutToken; value: string }>;
}

/* ------------------------------------------------ Intelligence reads */

/**
 * Everything below exists because no provider on this chain sells it.
 *
 * Codex is the deeper market source but its holder list is behind a plan
 * upgrade, and its event history is shallow enough in time (measured: 600
 * events covered 2.6 hours on the busiest token) that wallet history has to
 * come from somewhere else. Blockscout is keyless, serves this chain natively,
 * and carries the address-scoped endpoints Codex does not — so the two are used
 * for what each is actually good at rather than forcing either to cover both.
 */

const json = async <T>(path: string, revalidate: number): Promise<T | null> => {
  try {
    const res = await fetch(`${BASE}${path}`, {
      next: { revalidate },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
};

export type HolderRow = { address: string; isContract: boolean; value: number };

/**
 * The largest holders of a token, walked a page at a time.
 *
 * Deliberately capped. A token here can have forty thousand holders and the
 * endpoint serves fifty per request, so a full distribution is not obtainable
 * and anything claiming a true Gini coefficient would be inventing one. What
 * this supports is a top-N concentration ratio, which is stated as exactly that
 * wherever it is shown.
 */
export async function fetchTopHolders(token: string, pages = 2): Promise<HolderRow[]> {
  const out: HolderRow[] = [];
  let query = "";

  for (let page = 0; page < pages; page++) {
    const data = await json<{
      items?: Array<{ address?: { hash?: string; is_contract?: boolean }; value?: string }>;
      next_page_params?: Record<string, string> | null;
    }>(`/tokens/${token}/holders${query}`, 300);
    if (!data?.items?.length) break;

    for (const item of data.items) {
      const value = Number(item.value);
      if (!item.address?.hash || !Number.isFinite(value)) continue;
      out.push({
        address: item.address.hash.toLowerCase(),
        isContract: Boolean(item.address.is_contract),
        value,
      });
    }

    const next = data.next_page_params;
    if (!next) break;
    query = `?${new URLSearchParams(next).toString()}`;
  }

  return out;
}

export type WalletCounters = {
  transactions: number | null;
  tokenTransfers: number | null;
};

export async function fetchWalletCounters(address: string): Promise<WalletCounters> {
  const data = await json<{ transactions_count?: string; token_transfers_count?: string }>(
    `/addresses/${address}/counters`,
    120
  );
  const n = (v: string | undefined) => {
    const parsed = Number(v);
    return Number.isFinite(parsed) ? parsed : null;
  };
  return { transactions: n(data?.transactions_count), tokenTransfers: n(data?.token_transfers_count) };
}

/**
 * When an address was first seen receiving anything.
 *
 * `filter=to` is the cheap way in: inbound transactions are usually few enough
 * that the last page is reachable, where the outbound list on an active trader
 * runs to thousands. A wallet funded before it traded gives its true age this
 * way; one that has only ever sent returns null rather than a guess.
 */
export async function fetchWalletFirstSeen(address: string): Promise<number | null> {
  let query = "?filter=to";
  let oldest: number | null = null;

  for (let page = 0; page < 3; page++) {
    const data = await json<{
      items?: Array<{ timestamp?: string }>;
      next_page_params?: Record<string, string> | null;
    }>(`/addresses/${address}/transactions${query}`, 3600);
    if (!data?.items?.length) break;

    const last = data.items.at(-1)?.timestamp;
    if (last) {
      const t = Date.parse(last);
      if (Number.isFinite(t)) oldest = Math.floor(t / 1000);
    }

    const next = data.next_page_params;
    if (!next) break;
    query = `?filter=to&${new URLSearchParams(next).toString()}`;
  }

  return oldest;
}

export type TokenTransfer = {
  timestamp: number;
  token: string;
  symbol: string | null;
  from: string;
  to: string;
  units: number;
};

/**
 * A wallet's ERC-20 transfer history.
 *
 * This is the raw material for holding periods and trade counts. It is
 * transfers, not trades: a transfer to a pool is a sale and a transfer from one
 * is a purchase, but a transfer between two wallets is neither, and nothing
 * here pretends otherwise — direction is left to the caller, which knows which
 * counterparties are pools.
 */
export async function fetchWalletTransfers(address: string, pages = 2): Promise<TokenTransfer[]> {
  const out: TokenTransfer[] = [];
  let query = "?type=ERC-20";

  for (let page = 0; page < pages; page++) {
    const data = await json<{
      items?: Array<{
        timestamp?: string;
        token?: { address_hash?: string; address?: string; symbol?: string; decimals?: string };
        from?: { hash?: string };
        to?: { hash?: string };
        total?: { value?: string; decimals?: string };
      }>;
      next_page_params?: Record<string, string> | null;
    }>(`/addresses/${address}/token-transfers${query}`, 60);
    if (!data?.items?.length) break;

    for (const item of data.items) {
      const raw = Number(item.total?.value);
      const decimals = Number(item.total?.decimals ?? item.token?.decimals ?? 18);
      const at = Date.parse(item.timestamp ?? "");
      const token = (item.token?.address_hash ?? item.token?.address ?? "").toLowerCase();
      if (!token || !Number.isFinite(raw) || !Number.isFinite(at)) continue;

      out.push({
        timestamp: Math.floor(at / 1000),
        token,
        symbol: item.token?.symbol ?? null,
        from: (item.from?.hash ?? "").toLowerCase(),
        to: (item.to?.hash ?? "").toLowerCase(),
        units: raw / 10 ** (Number.isFinite(decimals) ? decimals : 18),
      });
    }

    const next = data.next_page_params;
    if (!next) break;
    query = `?type=ERC-20&${new URLSearchParams(next).toString()}`;
  }

  return out;
}

export type ChainStats = {
  totalTransactions: number | null;
  transactionsToday: number | null;
  totalAddresses: number | null;
  averageBlockTimeMs: number | null;
};

/** Chain-wide activity, for the market-wide read. */
export async function fetchChainStats(): Promise<ChainStats> {
  const data = await json<{
    total_transactions?: string;
    transactions_today?: string;
    total_addresses?: string;
    average_block_time?: number;
  }>("/stats", 300);

  const n = (v: string | number | undefined) => {
    const parsed = Number(v);
    return Number.isFinite(parsed) ? parsed : null;
  };

  return {
    totalTransactions: n(data?.total_transactions),
    transactionsToday: n(data?.transactions_today),
    totalAddresses: n(data?.total_addresses),
    averageBlockTimeMs: n(data?.average_block_time),
  };
}

export const explorerTokenUrl = (address: string) =>
  `https://robinhoodchain.blockscout.com/token/${address}`;

export const explorerAddressUrl = (address: string) =>
  `https://robinhoodchain.blockscout.com/address/${address}`;
