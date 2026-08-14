import { cached } from "./cache";

/**
 * Equity data via Finnhub (free tier, 60 calls/min).
 *
 * Yahoo already supplies a price without a credential, so Finnhub is here for
 * what Yahoo cannot give: company news, analyst positioning, peers, the earnings
 * calendar, and an authoritative market-status feed that knows about holidays.
 *
 * `stock/split` is the one endpoint the free tier withholds — which is why the
 * splits calendar still comes from Nasdaq's public API.
 */
const BASE = "https://finnhub.io/api/v1";

const key = () => process.env.FINNHUB_API_KEY;

async function call<T>(path: string, ttlMs: number): Promise<T | null> {
  const token = key();
  if (!token) return null;

  return cached(
    `fh:${path}`,
    ttlMs,
    async () => {
      try {
        const separator = path.includes("?") ? "&" : "?";
        const res = await fetch(`${BASE}${path}${separator}token=${token}`, {
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) return null;
        const json = await res.json();
        // Finnhub reports plan restrictions in the body, not the status code.
        if (json && typeof json === "object" && "error" in json) return null;
        return json as T;
      } catch {
        return null;
      }
    },
    (v) => v !== null
  );
}

/* --------------------------------------------------------------- Quotes */

export type StockQuote = {
  symbol: string;
  price: number;
  change: number;
  changePct: number;
  high: number;
  low: number;
  open: number;
  previousClose: number;
  asOf: number;
};

export async function fetchStockQuote(symbol: string): Promise<StockQuote | null> {
  type Raw = { c: number; d: number; dp: number; h: number; l: number; o: number; pc: number; t: number };
  const raw = await call<Raw>(`/quote?symbol=${encodeURIComponent(symbol)}`, 30_000);
  if (!raw || !Number.isFinite(raw.c) || raw.c === 0) return null;

  return {
    symbol,
    price: raw.c,
    change: raw.d,
    changePct: raw.dp,
    high: raw.h,
    low: raw.l,
    open: raw.o,
    previousClose: raw.pc,
    asOf: raw.t,
  };
}

/* -------------------------------------------------------- Market status */

export type MarketStatus = {
  isOpen: boolean;
  session: string | null;
  holiday: string | null;
  timezone: string;
};

/**
 * Authoritative session state. Preferred over computing trading hours locally
 * because this knows the exchange holiday calendar — a hand-rolled clock will
 * happily report "open" on Thanksgiving.
 */
export async function fetchMarketStatus(): Promise<MarketStatus | null> {
  type Raw = { isOpen: boolean; session: string | null; holiday: string | null; timezone: string };
  const raw = await call<Raw>("/stock/market-status?exchange=US", 60_000);
  if (!raw || typeof raw.isOpen !== "boolean") return null;

  return {
    isOpen: raw.isOpen,
    session: raw.session,
    holiday: raw.holiday,
    timezone: raw.timezone ?? "America/New_York",
  };
}

/* ----------------------------------------------------------------- News */

export type NewsItem = {
  id: string;
  headline: string;
  summary: string;
  source: string;
  url: string;
  datetime: number;
  image: string | null;
  related: string | null;
};

type RawNews = {
  id?: number;
  headline?: string;
  summary?: string;
  source?: string;
  url?: string;
  datetime?: number;
  image?: string;
  related?: string;
};

const normaliseNews = (items: RawNews[]): NewsItem[] =>
  items
    .filter((n) => n.headline && n.url)
    .map((n) => ({
      id: String(n.id ?? n.url),
      headline: n.headline!,
      summary: n.summary ?? "",
      source: n.source ?? "unknown",
      url: n.url!,
      datetime: n.datetime ?? 0,
      image: n.image || null,
      related: n.related || null,
    }))
    .sort((a, b) => b.datetime - a.datetime);

export async function fetchCompanyNews(symbol: string, days = 7): Promise<NewsItem[]> {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  const raw = await call<RawNews[]>(
    `/company-news?symbol=${encodeURIComponent(symbol)}&from=${fmt(from)}&to=${fmt(to)}`,
    10 * 60_000
  );
  return raw ? normaliseNews(raw) : [];
}

export async function fetchMarketNews(category = "general"): Promise<NewsItem[]> {
  const raw = await call<RawNews[]>(`/news?category=${category}`, 10 * 60_000);
  return raw ? normaliseNews(raw) : [];
}

/* ------------------------------------------------------- Fundamentals */

export type CompanyProfile = {
  ticker: string;
  name: string;
  exchange: string;
  industry: string | null;
  marketCapUsd: number | null;
  shareOutstanding: number | null;
  logo: string | null;
  weburl: string | null;
  ipo: string | null;
};

export async function fetchCompanyProfile(symbol: string): Promise<CompanyProfile | null> {
  type Raw = {
    ticker?: string;
    name?: string;
    exchange?: string;
    finnhubIndustry?: string;
    marketCapitalization?: number;
    shareOutstanding?: number;
    logo?: string;
    weburl?: string;
    ipo?: string;
  };
  const raw = await call<Raw>(`/stock/profile2?symbol=${encodeURIComponent(symbol)}`, 24 * 3600_000);
  if (!raw?.ticker) return null;

  return {
    ticker: raw.ticker,
    name: raw.name ?? symbol,
    exchange: raw.exchange ?? "",
    industry: raw.finnhubIndustry ?? null,
    // Finnhub reports market cap in millions.
    marketCapUsd: raw.marketCapitalization ? raw.marketCapitalization * 1e6 : null,
    shareOutstanding: raw.shareOutstanding ?? null,
    logo: raw.logo || null,
    weburl: raw.weburl || null,
    ipo: raw.ipo || null,
  };
}

export type Recommendation = {
  period: string;
  strongBuy: number;
  buy: number;
  hold: number;
  sell: number;
  strongSell: number;
};

export async function fetchRecommendations(symbol: string): Promise<Recommendation[]> {
  const raw = await call<Recommendation[]>(
    `/stock/recommendation?symbol=${encodeURIComponent(symbol)}`,
    6 * 3600_000
  );
  return raw ?? [];
}

export async function fetchPeers(symbol: string): Promise<string[]> {
  const raw = await call<string[]>(`/stock/peers?symbol=${encodeURIComponent(symbol)}`, 24 * 3600_000);
  return (raw ?? []).filter((s) => s !== symbol);
}

/* ----------------------------------------------------- Earnings dates */

export type EarningsEvent = {
  symbol: string;
  date: string;
  hour: string | null;
  epsEstimate: number | null;
  revenueEstimate: number | null;
};

export async function fetchEarningsCalendar(days = 60): Promise<EarningsEvent[]> {
  const from = new Date();
  const to = new Date(from.getTime() + days * 86_400_000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  type Raw = {
    earningsCalendar?: {
      symbol?: string;
      date?: string;
      hour?: string;
      epsEstimate?: number | null;
      revenueEstimate?: number | null;
    }[];
  };

  const raw = await call<Raw>(`/calendar/earnings?from=${fmt(from)}&to=${fmt(to)}`, 3600_000);
  return (raw?.earningsCalendar ?? [])
    .filter((e) => e.symbol && e.date)
    .map((e) => ({
      symbol: e.symbol!,
      date: e.date!,
      hour: e.hour || null,
      epsEstimate: e.epsEstimate ?? null,
      revenueEstimate: e.revenueEstimate ?? null,
    }));
}

/**
 * Earnings for the tickers that exist as tokens on this chain.
 *
 * Earnings are the other scheduled event that moves a stock token hard, and
 * unlike a corporate action they are known weeks ahead — so this is a warning
 * the chain itself can never provide.
 */
export async function fetchEarningsForTokens(symbols: string[]): Promise<EarningsEvent[]> {
  const calendar = await fetchEarningsCalendar();
  const wanted = new Set(symbols.map((s) => s.toUpperCase()));
  return calendar
    .filter((e) => wanted.has(e.symbol.toUpperCase()))
    .sort((a, b) => a.date.localeCompare(b.date));
}
