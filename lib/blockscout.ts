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

export const explorerTokenUrl = (address: string) =>
  `https://robinhoodchain.blockscout.com/token/${address}`;

export const explorerAddressUrl = (address: string) =>
  `https://robinhoodchain.blockscout.com/address/${address}`;
