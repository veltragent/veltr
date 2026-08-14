import { createHash } from "node:crypto";
import { githubRepo } from "../research";

/**
 * Change detection.
 *
 * The requirement is "notify only when something actually changed", and the
 * tempting way to do that is to run the agent each cycle and ask whether its
 * new summary differs from the last. That does not work: a model phrases the
 * same facts differently every time, so prose comparison reports change
 * constantly — which is indistinguishable from no filter at all.
 *
 * So change is decided deterministically, from a fingerprint of the thing
 * itself. A model is never asked whether something changed; at most it is asked
 * to describe a change that has already been established.
 */

export type TrackKind = "repo" | "page";

export type Signal = {
  /** Stable across polls when nothing changed. The whole mechanism. */
  fingerprint: string;
  /** One line for the user, when this is the first reading. */
  summary: string;
  /** Facts worth diffing against the previous reading. */
  facts: Record<string, string | number | null>;
  /** What changed, filled in by `describeChange`. */
  detail?: string;
};

export type SignalResult = { ok: true; signal: Signal } | { ok: false; error: string };

const hash = (input: string): string => createHash("sha256").update(input).digest("hex").slice(0, 16);

/* --------------------------------------------------------------- Pages */

/**
 * Reduces a page to the text a reader would see.
 *
 * Scripts, styles and markup are removed before hashing because they carry
 * per-request noise — CSRF tokens, cache-busting query strings, build hashes —
 * that changes on every fetch while the page says exactly the same thing. A
 * fingerprint over raw HTML reports a change every single poll.
 */
export function readableText(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Strips the parts of visible text that move on their own.
 *
 * A clock in the footer or a "12 minutes ago" timestamp would otherwise make
 * every page permanently "changed". These are the common shapes; anything
 * subtler will produce a false positive, which is a nuisance rather than a
 * correctness failure.
 */
export function stripVolatile(text: string): string {
  return text
    .replace(/\d{1,2}:\d{2}(:\d{2})?\s*(am|pm)?/gi, " ")
    .replace(/\d{4}-\d{2}-\d{2}T?[\d:.]*Z?/g, " ")
    .replace(/\b\d+\s+(second|minute|hour|day|week|month|year)s?\s+ago\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function fingerprintPage(html: string): { fingerprint: string; length: number } {
  const text = stripVolatile(readableText(html));
  return { fingerprint: hash(text), length: text.length };
}

async function pageSignal(url: string): Promise<SignalResult> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };

    const html = await res.text();
    const { fingerprint, length } = fingerprintPage(html);

    return {
      ok: true,
      signal: {
        fingerprint,
        summary: `${length.toLocaleString()} characters of readable text`,
        facts: { length },
      },
    };
  } catch (error) {
    const timedOut = error instanceof Error && /timeout|abort/i.test(error.name + error.message);
    return { ok: false, error: timedOut ? "timed out" : "unreachable" };
  }
}

/* ------------------------------------------------------------ Repositories */

export type Commit = { sha: string; message: string; author: string | null; at: string | null };

type GhCommit = {
  sha?: string;
  commit?: { message?: string; author?: { name?: string; date?: string } };
  author?: { login?: string };
};

export function parseCommits(json: unknown): Commit[] {
  if (!Array.isArray(json)) return [];
  return json.slice(0, 10).map((raw) => {
    const c = raw as GhCommit;
    return {
      sha: (c.sha ?? "").slice(0, 7),
      // The first line is the subject; the body is usually noise in a notification.
      message: (c.commit?.message ?? "").split("\n")[0].slice(0, 140),
      author: c.author?.login ?? c.commit?.author?.name ?? null,
      at: c.commit?.author?.date ?? null,
    };
  });
}

async function repoSignal(owner: string, repo: string): Promise<SignalResult> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const base = process.env.GITHUB_API_URL || "https://api.github.com";

  try {
    const [meta, commitsRes] = await Promise.all([
      githubRepo(owner, repo).catch(() => null),
      fetch(`${base}/repos/${owner}/${repo}/commits?per_page=10`, {
        headers,
        signal: AbortSignal.timeout(25_000),
      }).catch(() => null),
    ]);

    if (!meta && !commitsRes?.ok) return { ok: false, error: "repository not found or not accessible" };

    const commits = commitsRes?.ok ? parseCommits(await commitsRes.json()) : [];
    const head = commits[0];

    // The head commit is the change signal. Stars and issues move for reasons
    // nobody asked to be told about.
    const fingerprint = hash(head?.sha ?? meta?.pushedAt ?? "unknown");

    return {
      ok: true,
      signal: {
        fingerprint,
        summary: head
          ? `at ${head.sha} — ${head.message}`
          : `last pushed ${meta?.pushedAt ?? "unknown"}`,
        facts: {
          head: head?.sha ?? null,
          stars: meta?.stars ?? null,
          openIssues: meta?.openIssues ?? null,
          pushedAt: meta?.pushedAt ?? null,
        },
        detail: commits
          .slice(0, 5)
          .map((c) => `${c.sha} ${c.message}${c.author ? ` — ${c.author}` : ""}`)
          .join("\n"),
      },
    };
  } catch {
    return { ok: false, error: "lookup failed" };
  }
}

/* ---------------------------------------------------------------- Target */

export type Target = { kind: TrackKind; ref: string };

/** `owner/repo` is a repository; anything with a scheme is a page. */
export function parseTarget(input: string): Target | null {
  const raw = input.trim();
  if (!raw) return null;

  if (/^https?:\/\/\S+$/i.test(raw)) {
    // A GitHub URL is a repository, not a page — the commit feed is a far better
    // signal than the rendered HTML, which changes with every CI badge.
    const gh = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(raw);
    if (gh) return { kind: "repo", ref: `${gh[1]}/${gh[2]}` };
    return { kind: "page", ref: raw };
  }

  if (/^[\w.-]+\/[\w.-]+$/.test(raw)) return { kind: "repo", ref: raw };

  return null;
}

export async function readSignal(target: Target): Promise<SignalResult> {
  if (target.kind === "repo") {
    const [owner, repo] = target.ref.split("/");
    if (!owner || !repo) return { ok: false, error: "expected owner/repo" };
    return repoSignal(owner, repo);
  }
  return pageSignal(target.ref);
}

/**
 * Describes a change from the two readings, without a model.
 *
 * Everything here is something a tool returned. Asking a model to narrate the
 * diff would produce nicer prose and the occasional invented commit, and a
 * notification nobody can trust is worse than a terse one they can.
 */
export function describeChange(target: Target, before: Signal, after: Signal): string {
  if (target.kind === "repo") {
    const lines = [after.detail ?? after.summary];
    const stars = Number(after.facts.stars ?? 0) - Number(before.facts.stars ?? 0);
    if (stars !== 0) lines.push(`Stars ${stars > 0 ? "+" : ""}${stars}`);
    return lines.filter(Boolean).join("\n");
  }

  const delta = Number(after.facts.length ?? 0) - Number(before.facts.length ?? 0);
  const direction = delta === 0 ? "reworded" : delta > 0 ? `grew by ${delta}` : `shrank by ${Math.abs(delta)}`;
  return `Readable content ${direction} character${Math.abs(delta) === 1 ? "" : "s"}.`;
}
