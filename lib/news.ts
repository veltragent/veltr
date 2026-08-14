import { cached } from "./cache";
import { fetchCompanyNews, type NewsItem } from "./stocks";

/**
 * News layer.
 *
 * Built because Finnhub's per-company feed proved unreliable for relevance: a
 * request for NVDA news returned macro headlines about budget deficits and
 * household debt. An agent fed that would confidently explain a stock move using
 * an article that never mentions the company — worse than having no news at all.
 *
 * So per-ticker news comes from Yahoo's per-symbol RSS, which is genuinely
 * company-scoped, and anything from Finnhub must pass a relevance check before
 * it is allowed through.
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** The SEC blocks generic agents and requires a declared identity. */
const SEC_UA = process.env.VELTR_SEC_USER_AGENT || "Veltr veltr-agent@example.com";

/* ------------------------------------------------------------ XML parse */

function decodeEntities(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function tag(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decodeEntities(m[1]) : null;
}

/** Atom puts the URL in an attribute rather than the element body. */
function linkOf(block: string): string | null {
  const href = block.match(/<link[^>]*href=["']([^"']+)["']/i);
  if (href) return href[1];
  return tag(block, "link");
}

type FeedEntry = { title: string; link: string; published: number; summary: string; source: string };

function parseFeed(xml: string, source: string): FeedEntry[] {
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) ?? [];

  return blocks
    .map((block) => {
      const title = tag(block, "title");
      const link = linkOf(block);
      if (!title || !link) return null;

      const dateText =
        tag(block, "pubDate") ?? tag(block, "updated") ?? tag(block, "published") ?? "";
      const parsed = Date.parse(dateText);

      return {
        title,
        link,
        published: Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0,
        summary: tag(block, "description") ?? tag(block, "summary") ?? "",
        source,
      };
    })
    .filter((e): e is FeedEntry => e !== null);
}

async function fetchFeed(url: string, source: string, userAgent = UA): Promise<FeedEntry[]> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": userAgent, Accept: "application/rss+xml, application/atom+xml, */*" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return [];
    return parseFeed(await res.text(), source);
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------ Relevance */

/**
 * Does this item actually concern the company?
 *
 * Requires the ticker as a standalone token, or a distinctive word from the
 * company name. "Apple" must not match "pineapple", and a bare "AI" must not
 * qualify an article as being about a specific chipmaker.
 */
export function isRelevant(text: string, symbol: string, companyName?: string | null): boolean {
  const haystack = text.toLowerCase();

  const tickerPattern = new RegExp(`(^|[^a-z0-9])${symbol.toLowerCase()}([^a-z0-9]|$)`);
  if (tickerPattern.test(haystack)) return true;

  if (companyName) {
    const stopWords = new Set([
      "inc", "corp", "corporation", "company", "co", "ltd", "plc", "holdings",
      "group", "the", "technologies", "technology", "class", "common", "stock",
    ]);
    const words = companyName
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !stopWords.has(w));

    for (const word of words) {
      if (new RegExp(`(^|[^a-z0-9])${word}([^a-z0-9]|$)`).test(haystack)) return true;
    }
  }

  return false;
}

/* ---------------------------------------------------------------- Feeds */

export type Article = {
  id: string;
  headline: string;
  summary: string;
  url: string;
  source: string;
  publishedAt: number;
};

const toArticle = (e: FeedEntry): Article => ({
  id: e.link,
  headline: e.title,
  summary: e.summary.slice(0, 400),
  url: e.link,
  source: e.source,
  publishedAt: e.published,
});

/**
 * Company news: Yahoo's per-symbol feed, topped up with Finnhub items that pass
 * the relevance check.
 */
export async function fetchTickerNews(
  symbol: string,
  companyName?: string | null,
  limit = 12
): Promise<Article[]> {
  return cached(
    `news:${symbol}`,
    10 * 60_000,
    async () => {
      const [yahoo, finnhub] = await Promise.all([
        fetchFeed(
          `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(symbol)}&region=US&lang=en-US`,
          "Yahoo Finance"
        ),
        fetchCompanyNews(symbol).catch((): NewsItem[] => []),
      ]);

      // Yahoo's first entry is the feed's own title card, not an article.
      const yahooArticles = yahoo
        .filter((e) => !/^Yahoo!\s*Finance:/i.test(e.title))
        .map(toArticle);

      const finnhubArticles = finnhub
        .filter((n) => isRelevant(`${n.headline} ${n.summary}`, symbol, companyName))
        .map((n) => ({
          id: n.id,
          headline: n.headline,
          summary: n.summary.slice(0, 400),
          url: n.url,
          source: n.source,
          publishedAt: n.datetime,
        }));

      const seen = new Set<string>();
      return [...yahooArticles, ...finnhubArticles]
        .filter((a) => {
          const key = a.headline.toLowerCase().slice(0, 80);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .sort((a, b) => b.publishedAt - a.publishedAt)
        .slice(0, limit);
    },
    (v) => v.length > 0
  );
}

/**
 * Material-event filings straight from the SEC.
 *
 * The highest-signal source available: an 8-K is the company itself disclosing
 * something material, published before any journalist writes about it.
 */
export async function fetchFilings(symbol: string, limit = 6): Promise<Article[]> {
  return cached(
    `filings:${symbol}`,
    30 * 60_000,
    async () => {
      const entries = await fetchFeed(
        `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(symbol)}&type=8-K&dateb=&owner=include&count=${limit}&output=atom`,
        "SEC EDGAR",
        SEC_UA
      );
      return entries
        .filter((e) => /\d-K|\d{1,2}-[A-Z]/.test(e.title))
        .map(toArticle)
        .slice(0, limit);
    },
    () => true
  );
}

/** Macro backdrop. Deliberately not attributed to any single company. */
export async function fetchMarketHeadlines(limit = 15): Promise<Article[]> {
  return cached(
    "news:market",
    10 * 60_000,
    async () => {
      const entries = await fetchFeed(
        "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20910258",
        "CNBC"
      );
      return entries
        .filter((e) => e.published > 0)
        .map(toArticle)
        .sort((a, b) => b.publishedAt - a.publishedAt)
        .slice(0, limit);
    },
    (v) => v.length > 0
  );
}
