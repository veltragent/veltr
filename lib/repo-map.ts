import { githubFile, githubRepo, githubTree } from "./research";

/**
 * Repository intelligence.
 *
 * Reading a codebase by listing three hundred paths and hoping the model picks
 * the right ones costs a round per guess and usually guesses wrong — "where is
 * authentication handled" became four `github_read_file` calls on plausible
 * paths that did not exist.
 *
 * This builds the mental model in one step instead: what kind of project it is,
 * where it starts, and which files belong to which concern. The model then reads
 * two files that matter rather than six that might.
 *
 * Classification is pure and deterministic — it is path pattern matching, not
 * inference, so it costs nothing and cannot hallucinate a file.
 */

export type Bucket =
  | "entry"
  | "config"
  | "api"
  | "auth"
  | "data"
  | "services"
  | "ui"
  | "tests"
  | "docs"
  | "other";

/**
 * Ordered: the first match wins.
 *
 * Auth sits above api and services deliberately — `app/api/auth/route.ts` is an
 * auth file first and an API route second, and the whole point of the bucket is
 * to be found when someone asks where authentication lives.
 */
const RULES: [Bucket, RegExp][] = [
  ["tests", /(^|\/)(tests?|__tests__|spec|e2e)\/|\.(test|spec)\.[jt]sx?$|_test\.(go|py|rb)$/i],
  ["config", /(^|\/)(package\.json|tsconfig[^/]*\.json|jsconfig\.json|go\.mod|cargo\.toml|pyproject\.toml|requirements\.txt|gemfile|composer\.json|pom\.xml|build\.gradle|dockerfile|docker-compose[^/]*|makefile|\.env\.example|next\.config\.[a-z]+|vite\.config\.[a-z]+|webpack\.config\.[a-z]+|tailwind\.config\.[a-z]+|eslint\.config\.[a-z]+|\.eslintrc[^/]*|nest-cli\.json|angular\.json|svelte\.config\.[a-z]+|nuxt\.config\.[a-z]+)$/i],
  ["auth", /(^|\/|[-_.])(auth|authentication|authorization|session|login|signin|signup|jwt|oauth|passport|clerk|nextauth|permission|rbac|guard|middleware|credential|token)([-_./]|s?\.[jt]sx?$|$)/i],
  ["api", /(^|\/)(app\/api|pages\/api|api|routes?|controllers?|handlers?|endpoints?|resolvers?|graphql)\//i],
  ["data", /(^|\/)(prisma|migrations?|models?|entities|schema|repositor(y|ies)|db|database|dao|stores?)\/|\.(sql|prisma)$|schema\.[jt]s$/i],
  ["ui", /(^|\/)(components?|views?|pages|screens|widgets|ui|styles?)\/|\.(tsx|jsx|vue|svelte|css|scss)$/i],
  ["services", /(^|\/)(lib|services?|utils?|helpers?|core|domain|usecases?|providers?|adapters?|clients?|hooks?|workers?|jobs?|queues?)\//i],
  ["docs", /\.(md|mdx|rst|txt)$/i],
];

/** Files that are where a project actually begins. */
const ENTRY = /(^|\/)(index|main|app|server|bootstrap|cli|instrumentation|worker)\.(m?[jt]sx?|py|go|rb|rs)$|^(src\/)?(app|pages)\/(layout|page)\.[jt]sx$|(^|\/)cmd\/[^/]+\/main\.go$|(^|\/)manage\.py$/i;

/** Noise that tells nobody anything about how the project works. */
const IGNORED =
  /(^|\/)(node_modules|dist|build|out|\.next|vendor|target|coverage|\.git|__pycache__|\.venv)\/|\.(lock|map|min\.js|png|jpe?g|gif|svg|ico|woff2?|ttf|eot|pdf|zip|gz)$|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock)$/i;

export function classifyPath(path: string): Bucket {
  for (const [bucket, pattern] of RULES) {
    if (pattern.test(path)) return bucket;
  }
  return "other";
}

export function isIgnored(path: string): boolean {
  return IGNORED.test(path);
}

export type Classified = {
  buckets: Record<Bucket, string[]>;
  entryPoints: string[];
  /** Paths kept after ignoring build output and binaries. */
  considered: number;
  ignored: number;
};

export function classifyPaths(paths: string[]): Classified {
  const buckets: Record<Bucket, string[]> = {
    entry: [],
    config: [],
    api: [],
    auth: [],
    data: [],
    services: [],
    ui: [],
    tests: [],
    docs: [],
    other: [],
  };

  const entryPoints: string[] = [];
  let ignored = 0;

  for (const path of paths) {
    if (isIgnored(path)) {
      ignored++;
      continue;
    }
    // Depth is a good proxy for importance in an entry point: `src/index.ts` is
    // one, `src/lib/widgets/internal/index.ts` is a barrel file.
    if (ENTRY.test(path) && path.split("/").length <= 4) entryPoints.push(path);
    buckets[classifyPath(path)].push(path);
  }

  return { buckets, entryPoints, considered: paths.length - ignored, ignored };
}

/** What the config files present say the project is. */
export function detectStack(paths: string[]): { type: string; markers: string[] } {
  const set = new Set(paths.map((p) => p.toLowerCase()));
  const has = (name: string) => set.has(name) || paths.some((p) => p.toLowerCase().endsWith(`/${name}`));

  const markers: string[] = [];
  let type = "unknown";

  if (has("package.json")) {
    type = "javascript/typescript";
    markers.push("package.json");
    if (paths.some((p) => /^next\.config\./i.test(p))) markers.push("next.js");
    if (paths.some((p) => /^(vite|svelte|nuxt|angular)\.config\./i.test(p))) markers.push("bundler config");
    if (paths.some((p) => /^app\/(layout|page)\.[jt]sx$/i.test(p))) markers.push("next app router");
    if (paths.some((p) => /^pages\//i.test(p))) markers.push("next pages router");
  }
  // Later entries win: a repository with both go.mod and package.json is a Go
  // project with a frontend attached, not the other way round.
  const stacks: [string, string, string[]][] = [
    ["go", "go.mod", ["go.mod"]],
    ["ruby", "gemfile", ["Gemfile"]],
    ["jvm", "pom.xml", ["jvm build"]],
    ["jvm", "build.gradle", ["jvm build"]],
    ["python", "requirements.txt", ["python packaging"]],
    ["python", "pyproject.toml", ["python packaging"]],
    ["rust", "cargo.toml", ["Cargo.toml"]],
  ];

  for (const [name, marker, labels] of stacks) {
    if (!has(marker)) continue;
    type = name;
    markers.push(...labels);
  }

  if (has("dockerfile")) markers.push("docker");

  return { type, markers };
}

/**
 * Best guess at a path the user meant.
 *
 * A model asked to read `src/auth.ts` in a repository that has `lib/auth.ts`
 * gets "File not found", burns a round, and often guesses wrong again. Matching
 * on basename first is what makes recovery reliable: the filename is almost
 * always right and the directory almost always wrong.
 */
export function resolvePath(requested: string, paths: string[]): string | null {
  if (!requested) return null;
  const wanted = requested.replace(/^\.?\//, "").toLowerCase();

  const exact = paths.find((p) => p.toLowerCase() === wanted);
  if (exact) return exact;

  const base = wanted.split("/").pop() ?? wanted;

  const sameName = paths.filter((p) => (p.split("/").pop() ?? "").toLowerCase() === base);
  if (sameName.length > 0) {
    // Shallowest wins: the top-level one is the file people mean.
    return sameName.sort((a, b) => a.split("/").length - b.split("/").length)[0];
  }

  const suffix = paths.filter((p) => p.toLowerCase().endsWith(`/${wanted}`));
  if (suffix.length > 0) return suffix.sort((a, b) => a.length - b.length)[0];

  // Same stem, different extension — .ts asked for where .tsx exists.
  const stem = base.replace(/\.[^.]+$/, "");
  if (stem.length >= 3) {
    const related = paths.filter((p) => {
      const candidate = (p.split("/").pop() ?? "").replace(/\.[^.]+$/, "").toLowerCase();
      return candidate === stem;
    });
    if (related.length > 0) return related.sort((a, b) => a.split("/").length - b.split("/").length)[0];
  }

  return null;
}

export type RepoMap = {
  repo: string;
  description: string | null;
  language: string | null;
  stars: number;
  pushedAt: string | null;
  stack: { type: string; markers: string[] };
  fileCount: number;
  considered: number;
  entryPoints: string[];
  buckets: Partial<Record<Bucket, string[]>>;
  /** Content of the manifest, when there is one worth reading. */
  manifest: { path: string; content: string } | null;
  note: string;
};

/** Per bucket, in the summary. Enough to choose from, short enough to read. */
const PER_BUCKET = 14;

/**
 * Builds the map.
 *
 * The repository metadata and the file tree are fetched together — neither
 * depends on the other, and serialising them was a second of latency for no
 * reason. The manifest is read afterwards because which file to read is only
 * known once the tree has arrived.
 */
export async function buildRepoMap(owner: string, repo: string): Promise<RepoMap | null> {
  const [summary, tree] = await Promise.all([
    githubRepo(owner, repo).catch(() => null),
    githubTree(owner, repo, 900).catch(() => [] as string[]),
  ]);

  if (!summary && tree.length === 0) return null;

  const classified = classifyPaths(tree);
  const stack = detectStack(tree);

  // The manifest names the framework, the scripts and the dependencies — more
  // signal per byte than any other file in a repository.
  const manifestPath = classified.buckets.config.find((p) =>
    /(^|\/)(package\.json|go\.mod|cargo\.toml|pyproject\.toml|requirements\.txt)$/i.test(p)
  );

  let manifest: RepoMap["manifest"] = null;
  if (manifestPath) {
    const content = await githubFile(owner, repo, manifestPath).catch(() => null);
    if (content) manifest = { path: manifestPath, content: content.slice(0, 4_000) };
  }

  const buckets: Partial<Record<Bucket, string[]>> = {};
  for (const [name, paths] of Object.entries(classified.buckets) as [Bucket, string[]][]) {
    if (paths.length > 0) buckets[name] = paths.slice(0, PER_BUCKET);
  }

  return {
    repo: summary?.fullName ?? `${owner}/${repo}`,
    description: summary?.description ?? null,
    language: summary?.language ?? null,
    stars: summary?.stars ?? 0,
    pushedAt: summary?.pushedAt ?? null,
    stack,
    fileCount: tree.length,
    considered: classified.considered,
    entryPoints: classified.entryPoints.slice(0, 8),
    buckets,
    manifest,
    note:
      "Each bucket is capped, so this is a map rather than a full listing. Read the specific files you need with github_read_file; call github_files for an exhaustive list.",
  };
}
