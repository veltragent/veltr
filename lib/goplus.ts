import { createHash } from "node:crypto";
import { cached } from "./cache";

/**
 * GoPlus — contract and address security.
 *
 * Robinhood Chain is genuinely supported: it appears in `supported_chains` as
 * "Robinhood", id 4663, and `token_security` returns populated fields for it.
 * That was verified before this file existed, because the alternative — an
 * integration that returns an empty object and gets rendered as a clean bill of
 * health — is the worst possible outcome for a security feature.
 *
 * The critical finding, and the thing this module is built around:
 *
 *   Chain 1 returns 36 fields. Chain 4663 returns 21.
 *
 * The 15 absent ones include `is_honeypot`, `is_mintable`, `owner_address`,
 * `transfer_pausable`, `selfdestruct`, `can_take_back_ownership` and
 * `hidden_owner` — precisely the checks a reader would most want. So every
 * absent field is reported as UNASSESSED and never as passing. A missing
 * honeypot flag means nobody checked, not that the token is safe, and the
 * distinction is preserved all the way to the screen.
 *
 * Two neighbouring endpoints were probed and rejected:
 *   - `rugpull_detecting` answers with every field null on this chain.
 *   - `token_approval_security` answers "Main chain does not exist".
 * Neither is used. An endpoint that returns nulls is not a data source.
 */

export const GOPLUS_CHAIN_ID = "4663";

const BASE = "https://api.gopluslabs.io/api/v1";

/* ------------------------------------------------------------ Auth */

type TokenCache = { token: string; expiresAt: number };
let authToken: TokenCache | null = null;

/**
 * An access token, reused until shortly before it expires.
 *
 * GoPlus issues two-hour tokens and signs the request with
 * sha1(app_key + unix_seconds + app_secret). Fetching one per call would spend
 * a request on authentication for every question asked.
 *
 * Anonymous access also works and is the fallback: without credentials the
 * endpoints still answer at a lower rate limit, so a missing key degrades the
 * feature rather than removing it.
 */
async function accessToken(): Promise<string | null> {
  const key = process.env.GOPLUS_APP_KEY;
  const secret = process.env.GOPLUS_APP_SECRET;
  if (!key || !secret) return null;

  if (authToken && authToken.expiresAt > Date.now() + 60_000) return authToken.token;

  try {
    const time = Math.floor(Date.now() / 1000);
    const sign = createHash("sha1").update(`${key}${time}${secret}`).digest("hex");

    const res = await fetch(`${BASE}/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_key: key, time, sign }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;

    const json = (await res.json()) as {
      code?: number;
      result?: { access_token?: string; expires_in?: number };
    };
    const token = json.result?.access_token;
    if (json.code !== 1 || !token) return null;

    authToken = {
      token,
      expiresAt: Date.now() + (json.result?.expires_in ?? 7200) * 1000,
    };
    return token;
  } catch {
    return null;
  }
}

async function call<T>(path: string): Promise<T | null> {
  try {
    const token = await accessToken();
    const res = await fetch(`${BASE}${path}`, {
      headers: {
        accept: "application/json",
        ...(token ? { Authorization: token } : {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;

    const json = (await res.json()) as { code?: number; message?: string; result?: T };
    // code 1 is success; anything else — including "partial data obtained" — is
    // not something to build a security claim on.
    if (json.code !== 1) return null;
    return json.result ?? null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------- Token security */

/** A flag that was actually returned, versus one this chain does not carry. */
export type Flag = { assessed: true; value: boolean } | { assessed: false };

export const UNASSESSED: Flag = { assessed: false };

const flag = (raw: string | undefined): Flag =>
  raw === undefined || raw === "" ? UNASSESSED : { assessed: true, value: raw === "1" };

const numeric = (raw: string | undefined): number | null => {
  if (raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

export type GoPlusHolder = {
  address: string;
  isContract: boolean;
  percent: number | null;
  tag: string | null;
};

export type TokenSecurity = {
  address: string;
  name: string | null;
  symbol: string | null;

  /** Taxes, as percentages. Null when the chain does not report them. */
  buyTaxPct: number | null;
  sellTaxPct: number | null;
  transferTaxPct: number | null;

  cannotBuy: Flag;
  cannotSellAll: Flag;
  honeypotSameCreator: Flag;
  isOpenSource: Flag;
  isProxy: Flag;
  isInDex: Flag;

  creatorAddress: string | null;
  creatorPercent: number | null;

  holderCount: number | null;
  /** Top holders with their share — better than a raw balance list. */
  holders: GoPlusHolder[];
  lpHolderCount: number | null;
  lpHolders: GoPlusHolder[];
  totalSupply: number | null;

  /**
   * Checks this chain does not answer, named individually.
   *
   * Carried so the surface can say "not assessed on this chain" for each one
   * rather than silently omitting it, which a reader would read as a pass.
   */
  unassessed: string[];
  fetchedAt: string;
};

/** The checks a reader expects, so an absent one can be named rather than skipped. */
export const EXPECTED_CHECKS = [
  "is_honeypot",
  "is_mintable",
  "owner_address",
  "transfer_pausable",
  "selfdestruct",
  "can_take_back_ownership",
  "hidden_owner",
  "is_blacklisted",
  "external_call",
  "slippage_modifiable",
  "trading_cooldown",
  "is_anti_whale",
] as const;

type RawSecurity = Record<string, unknown>;

function shapeHolders(raw: unknown): GoPlusHolder[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((h) => {
      const row = h as Record<string, unknown>;
      const address = String(row.address ?? "").toLowerCase();
      if (!address) return null;
      const percent = numeric(row.percent as string | undefined);
      return {
        address,
        isContract: String(row.is_contract ?? "0") === "1",
        // GoPlus reports a fraction; a share is more useful as a percentage.
        percent: percent === null ? null : percent * 100,
        tag: (row.tag as string) || null,
      };
    })
    .filter((h): h is GoPlusHolder => h !== null);
}

export async function tokenSecurity(address: string): Promise<TokenSecurity | null> {
  return cached(
    `goplus:token:${address.toLowerCase()}`,
    // Contract properties change rarely; the holder list inside moves slowly.
    10 * 60_000,
    async () => {
      const result = await call<Record<string, RawSecurity>>(
        `/token_security/${GOPLUS_CHAIN_ID}?contract_addresses=${address}`
      );
      const raw = result?.[address.toLowerCase()];
      if (!raw) return null;

      const str = (k: string) => (raw[k] === undefined ? undefined : String(raw[k]));

      const unassessed = EXPECTED_CHECKS.filter((c) => raw[c] === undefined || raw[c] === "");

      return {
        address: address.toLowerCase(),
        name: (raw.token_name as string) || null,
        symbol: (raw.token_symbol as string) || null,

        buyTaxPct: numeric(str("buy_tax")),
        sellTaxPct: numeric(str("sell_tax")),
        transferTaxPct: numeric(str("transfer_tax")),

        cannotBuy: flag(str("cannot_buy")),
        cannotSellAll: flag(str("cannot_sell_all")),
        honeypotSameCreator: flag(str("honeypot_with_same_creator")),
        isOpenSource: flag(str("is_open_source")),
        isProxy: flag(str("is_proxy")),
        isInDex: flag(str("is_in_dex")),

        creatorAddress: (raw.creator_address as string) || null,
        creatorPercent: (() => {
          const p = numeric(str("creator_percent"));
          return p === null ? null : p * 100;
        })(),

        holderCount: numeric(str("holder_count")),
        holders: shapeHolders(raw.holders),
        lpHolderCount: numeric(str("lp_holder_count")),
        lpHolders: shapeHolders(raw.lp_holders),
        totalSupply: numeric(str("total_supply")),

        unassessed: [...unassessed],
        fetchedAt: new Date().toISOString(),
      } satisfies TokenSecurity;
    },
    (v) => v !== null
  );
}

/* ------------------------------------------------------ Address security */

export type AddressSecurity = {
  address: string;
  /** Categories GoPlus flagged. Empty means nothing was flagged. */
  flags: string[];
  /** True only when the provider actually answered. */
  assessed: boolean;
  fetchedAt: string;
};

/**
 * Malicious-address screening.
 *
 * Verified to answer on 4663. Every field is "0" or "1", so the useful shape is
 * the list of categories that came back set — an empty list from a successful
 * call means nothing was flagged, which is different from a failed call, and
 * `assessed` is what separates them.
 */
export async function addressSecurity(address: string): Promise<AddressSecurity> {
  return cached(
    `goplus:address:${address.toLowerCase()}`,
    30 * 60_000,
    async () => {
      const result = await call<Record<string, unknown>>(
        `/address_security/${address}?chain_id=${GOPLUS_CHAIN_ID}`
      );

      if (!result) {
        return { address: address.toLowerCase(), flags: [], assessed: false, fetchedAt: new Date().toISOString() };
      }

      const flags = Object.entries(result)
        .filter(([key, value]) => key !== "data_source" && String(value) === "1")
        .map(([key]) => key);

      return {
        address: address.toLowerCase(),
        flags,
        assessed: true,
        fetchedAt: new Date().toISOString(),
      };
    },
    () => true
  );
}
