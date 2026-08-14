import { cached } from "./cache";

/**
 * Research and retrieval.
 *
 * Four providers with genuinely different jobs, so the agent picks by intent
 * rather than habit:
 *
 *  - Tavily     synthesised answers with citations; best for "what happened".
 *  - Exa        neural/semantic search returning full page text; best for
 *               "find me analysis like this".
 *  - Firecrawl  renders JavaScript before extracting; the only one that can read
 *               an app-shell page.
 *  - Jina       fast, cheap URL-to-markdown for a page already known to be static.
 *
 * GitHub sits here too: contract and protocol questions are answered from source
 * far more reliably than from prose about the source.
 */

const timeout = (ms: number) => AbortSignal.timeout(ms);

export type SearchHit = {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string | null;
  score?: number | null;
};

/* --------------------------------------------------------------- Tavily */

export type TavilyResult = { answer: string | null; hits: SearchHit[] };

export async function tavilySearch(query: string, depth: "basic" | "advanced" = "advanced"): Promise<TavilyResult> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return { answer: null, hits: [] };

  return cached(
    `tavily:${depth}:${query}`,
    15 * 60_000,
    async () => {
      try {
        const res = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify({
            query,
            search_depth: depth,
            max_results: 6,
            include_answer: "advanced",
            include_raw_content: false,
          }),
          signal: timeout(45_000),
        });
        if (!res.ok) return { answer: null, hits: [] };

        const j = await res.json();
        return {
          answer: j.answer ?? null,
          hits: (j.results ?? []).map(
            (r: { title?: string; url?: string; content?: string; score?: number; published_date?: string }) => ({
              title: r.title ?? "",
              url: r.url ?? "",
              snippet: (r.content ?? "").slice(0, 500),
              score: r.score ?? null,
              publishedAt: r.published_date ?? null,
            })
          ),
        };
      } catch {
        return { answer: null, hits: [] };
      }
    },
    (v) => v.hits.length > 0 || v.answer !== null
  );
}

/* ------------------------------------------------------------------ Exa */

export async function exaSearch(query: string, numResults = 6): Promise<SearchHit[]> {
  const key = process.env.EXA_API_KEY;
  if (!key) return [];

  return cached(
    `exa:${query}:${numResults}`,
    15 * 60_000,
    async () => {
      try {
        const res = await fetch("https://api.exa.ai/search", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": key },
          body: JSON.stringify({
            query,
            numResults,
            type: "auto",
            contents: { text: { maxCharacters: 1200 } },
          }),
          signal: timeout(45_000),
        });
        if (!res.ok) return [];

        const j = await res.json();
        return (j.results ?? []).map(
          (r: { title?: string; url?: string; text?: string; score?: number; publishedDate?: string }) => ({
            title: r.title ?? "",
            url: r.url ?? "",
            snippet: (r.text ?? "").slice(0, 800),
            score: r.score ?? null,
            publishedAt: r.publishedDate ?? null,
          })
        );
      } catch {
        return [];
      }
    },
    (v) => v.length > 0
  );
}

/* ------------------------------------------------------- Page extraction */

export type PageContent = { url: string; title: string | null; markdown: string; via: string };

/**
 * Reads a page as markdown.
 *
 * Jina is tried first because it is fast and cheap; Firecrawl follows because it
 * executes JavaScript, which is the only way to read a page whose content is
 * rendered client-side.
 */
export async function readPage(url: string, forceRender = false): Promise<PageContent | null> {
  return cached(
    `page:${url}:${forceRender}`,
    30 * 60_000,
    async () => {
      if (!forceRender) {
        const jina = await readWithJina(url);
        // A near-empty result usually means the page needs a browser.
        if (jina && jina.markdown.length > 500) return jina;
      }
      return (await readWithFirecrawl(url)) ?? (forceRender ? await readWithJina(url) : null);
    },
    (v) => v !== null
  );
}

async function readWithJina(url: string): Promise<PageContent | null> {
  const key = process.env.JINA_API_KEY;
  try {
    const res = await fetch(`https://r.jina.ai/${url}`, {
      headers: {
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        "X-Return-Format": "markdown",
      },
      signal: timeout(45_000),
    });
    if (!res.ok) return null;
    const markdown = await res.text();
    const title = markdown.match(/^Title:\s*(.+)$/m)?.[1] ?? null;
    return { url, title, markdown: markdown.slice(0, 20_000), via: "jina" };
  } catch {
    return null;
  }
}

async function readWithFirecrawl(url: string): Promise<PageContent | null> {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) return null;

  try {
    const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
      signal: timeout(60_000),
    });
    if (!res.ok) return null;

    const j = await res.json();
    if (!j.success || !j.data?.markdown) return null;
    return {
      url,
      title: j.data.metadata?.title ?? null,
      markdown: String(j.data.markdown).slice(0, 20_000),
      via: "firecrawl",
    };
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------- GitHub */

const GH = process.env.GITHUB_API_URL || "https://api.github.com";

function ghHeaders() {
  const token = process.env.GITHUB_TOKEN;
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "veltr-agent",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export type RepoSummary = {
  fullName: string;
  description: string | null;
  stars: number;
  forks: number;
  language: string | null;
  topics: string[];
  license: string | null;
  pushedAt: string | null;
  openIssues: number;
  homepage: string | null;
};

export async function githubRepo(owner: string, repo: string): Promise<RepoSummary | null> {
  return cached(
    `gh:repo:${owner}/${repo}`,
    10 * 60_000,
    async () => {
      try {
        const res = await fetch(`${GH}/repos/${owner}/${repo}`, { headers: ghHeaders(), signal: timeout(25_000) });
        if (!res.ok) return null;
        const j = await res.json();
        return {
          fullName: j.full_name,
          description: j.description ?? null,
          stars: j.stargazers_count ?? 0,
          forks: j.forks_count ?? 0,
          language: j.language ?? null,
          topics: j.topics ?? [],
          license: j.license?.spdx_id ?? null,
          pushedAt: j.pushed_at ?? null,
          openIssues: j.open_issues_count ?? 0,
          homepage: j.homepage ?? null,
        };
      } catch {
        return null;
      }
    },
    (v) => v !== null
  );
}

/** Repository file tree, truncated to keep the model's context usable. */
export async function githubTree(owner: string, repo: string, limit = 120): Promise<string[]> {
  return cached(
    `gh:tree:${owner}/${repo}`,
    30 * 60_000,
    async () => {
      try {
        const meta = await fetch(`${GH}/repos/${owner}/${repo}`, { headers: ghHeaders(), signal: timeout(25_000) });
        if (!meta.ok) return [];
        const branch = (await meta.json()).default_branch ?? "main";

        const res = await fetch(`${GH}/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`, {
          headers: ghHeaders(),
          signal: timeout(40_000),
        });
        if (!res.ok) return [];

        const j = await res.json();
        return (j.tree ?? [])
          .filter((n: { type: string }) => n.type === "blob")
          .map((n: { path: string }) => n.path)
          .slice(0, limit);
      } catch {
        return [];
      }
    },
    (v) => v.length > 0
  );
}

export async function githubFile(owner: string, repo: string, path: string): Promise<string | null> {
  return cached(
    `gh:file:${owner}/${repo}/${path}`,
    30 * 60_000,
    async () => {
      try {
        const res = await fetch(`${GH}/repos/${owner}/${repo}/contents/${path}`, {
          headers: { ...ghHeaders(), Accept: "application/vnd.github.raw+json" },
          signal: timeout(30_000),
        });
        if (!res.ok) return null;
        // Truncated deliberately: a 5,000-line contract would crowd out
        // everything else the model needs to reason with.
        return (await res.text()).slice(0, 24_000);
      } catch {
        return null;
      }
    },
    (v) => v !== null
  );
}

export async function githubSearchCode(query: string, limit = 8) {
  try {
    const res = await fetch(`${GH}/search/code?q=${encodeURIComponent(query)}&per_page=${limit}`, {
      headers: ghHeaders(),
      signal: timeout(35_000),
    });
    if (!res.ok) return { total: 0, items: [] as { repo: string; path: string; url: string }[] };

    const j = await res.json();
    return {
      total: j.total_count ?? 0,
      items: (j.items ?? []).map((i: { repository?: { full_name?: string }; path?: string; html_url?: string }) => ({
        repo: i.repository?.full_name ?? "",
        path: i.path ?? "",
        url: i.html_url ?? "",
      })),
    };
  } catch {
    return { total: 0, items: [] };
  }
}
