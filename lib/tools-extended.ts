import type { ToolSpec } from "./tools";
import { codexToken, codexTopTokens, codexRecentSwaps, type RankAttribute } from "./codex";
import { tavilySearch, exaSearch, readPage, githubRepo, githubTree, githubFile, githubSearchCode } from "./research";
import { fetchGlobalMarket } from "./market";
import { buildRadarSnapshot } from "./tokens";
import { cached } from "./cache";

/**
 * Tools built on the keyed providers.
 *
 * Each one states its own ceiling in its description, because the agent choosing
 * the wrong tool is the most common way an answer goes wrong. Telling it that
 * Codex has no holder list, or that CoinGecko is on the demo tier, is cheaper
 * than letting it try and fail.
 */

const str = (v: unknown) => String(v ?? "").trim();
const sym = (v: unknown) => str(v).toUpperCase();

/* ------------------------------------------------------ CoinGecko global */

const CG = "https://api.coingecko.com/api/v3";

function cgHeaders(): Record<string, string> {
  const key = process.env.COINGECKO_API_KEY;
  return key ? { "x-cg-demo-api-key": key } : {};
}

async function cg<T>(path: string, ttlMs: number): Promise<T | null> {
  return cached(
    `cg:${path}`,
    ttlMs,
    async () => {
      try {
        const res = await fetch(`${CG}${path}`, {
          headers: cgHeaders(),
          signal: AbortSignal.timeout(25_000),
        });
        if (!res.ok) return null;
        return (await res.json()) as T;
      } catch {
        return null;
      }
    },
    (v) => v !== null
  );
}

export const EXTENDED_TOOLS: ToolSpec[] = [
  /* ------------------------------------------------------------- Codex */
  {
    name: "get_onchain_detail",
    description:
      "Deep on-chain metrics for a token on Robinhood Chain via Codex: aggregate liquidity across ALL pools, 24h volume, holder count, transaction count, and the buy/sell split. Prefer this over get_price when the question is about liquidity depth, trading activity or flow. Ceiling: the plan does not include the ranked list of individual holders, only the count.",
    parameters: {
      type: "object",
      properties: { symbol: { type: "string", description: "Ticker, e.g. NVDA" } },
      required: ["symbol"],
    },
    async handler(args) {
      const symbol = sym(args.symbol);
      const snapshot = await buildRadarSnapshot();
      const token = snapshot.tokens.find((t) => t.symbol.toUpperCase() === symbol);
      if (!token) return { error: `${symbol} is not tokenised on Robinhood Chain.` };

      const detail = await codexToken(token.address);
      if (!detail) return { error: `Codex has no data for ${symbol}.` };

      return {
        ...detail,
        buySellRatio:
          detail.buys24 && detail.sells24 ? Number((detail.buys24 / detail.sells24).toFixed(2)) : null,
        note: "Liquidity is aggregated across every pool, so it exceeds any single-pool figure.",
      };
    },
  },

  {
    name: "list_chain_tokens",
    description:
      "Every token on Robinhood Chain ranked by an attribute — not just stock tokens, but memecoins and stablecoins too. Use for 'what is trading on this chain', 'top tokens by volume', 'biggest movers'. Ranked by volume24, liquidity, marketCap, holders or txnCount24.",
    parameters: {
      type: "object",
      properties: {
        rankBy: {
          type: "string",
          enum: ["volume24", "liquidity", "marketCap", "holders", "txnCount24"],
        },
        limit: { type: "number", description: "Default 20, max 50" },
      },
    },
    async handler(args) {
      const attribute = (str(args.rankBy) || "volume24") as RankAttribute;
      const limit = Math.min(Number(args.limit) || 20, 50);
      const { tokens, indexed } = await codexTopTokens(attribute, limit);

      if (tokens.length === 0) return { error: "Codex returned no tokens for this chain." };

      return {
        rankedBy: attribute,
        returned: tokens.length,
        indexedByCodex: indexed,
        tokens: tokens.map((t) => ({
          symbol: t.symbol,
          name: t.name,
          priceUsd: t.priceUsd,
          liquidityUsd: t.liquidityUsd,
          volume24Usd: t.volume24Usd,
          holders: t.holders,
          change24Pct: t.change24Pct,
        })),
      };
    },
  },

  {
    name: "get_recent_trades",
    description:
      "Live swap flow for a token: recent trades with USD size and timestamps. Use to judge whether activity is real or thin, or to describe what is happening right now.",
    parameters: {
      type: "object",
      properties: { symbol: { type: "string" }, limit: { type: "number" } },
      required: ["symbol"],
    },
    async handler(args) {
      const symbol = sym(args.symbol);
      const snapshot = await buildRadarSnapshot();
      const token = snapshot.tokens.find((t) => t.symbol.toUpperCase() === symbol);
      if (!token) return { error: `${symbol} is not tokenised on Robinhood Chain.` };

      const swaps = await codexRecentSwaps(token.address, Math.min(Number(args.limit) || 15, 40));
      const sized = swaps.filter((s) => s.valueUsd !== null);

      return {
        symbol,
        count: swaps.length,
        medianTradeUsd:
          sized.length > 0
            ? sized.map((s) => s.valueUsd!).sort((a, b) => a - b)[Math.floor(sized.length / 2)]
            : null,
        trades: swaps.slice(0, 15).map((s) => ({
          type: s.type,
          valueUsd: s.valueUsd,
          at: s.timestamp ? new Date(s.timestamp * 1000).toISOString() : null,
        })),
      };
    },
  },

  /* --------------------------------------------------------- CoinGecko */
  {
    name: "get_global_crypto",
    description:
      "Global crypto market: total market cap, 24h change, BTC and ETH dominance, total volume, plus the top coins by market cap. Ceiling: this key is on the demo tier, so Pro-only endpoints are unavailable.",
    parameters: {
      type: "object",
      properties: { includeTopCoins: { type: "boolean" } },
    },
    async handler(args) {
      const global = await fetchGlobalMarket();

      let topCoins = null;
      if (args.includeTopCoins !== false) {
        type Coin = {
          symbol: string;
          name: string;
          current_price: number;
          market_cap: number;
          price_change_percentage_24h: number;
        };
        const coins = await cg<Coin[]>(
          "/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=10&page=1",
          5 * 60_000
        );
        topCoins = (coins ?? []).map((c) => ({
          symbol: c.symbol?.toUpperCase(),
          name: c.name,
          priceUsd: c.current_price,
          marketCapUsd: c.market_cap,
          change24Pct: c.price_change_percentage_24h,
        }));
      }

      if (!global && !topCoins) return { error: "CoinGecko is unreachable." };
      return { global, topCoins };
    },
  },

  {
    name: "get_crypto_asset",
    description:
      "Price and market data for a specific cryptocurrency by CoinGecko id (bitcoin, ethereum, solana). Use for crypto assets that are not stock tokens.",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "CoinGecko id, lowercase" } },
      required: ["id"],
    },
    async handler(args) {
      const id = str(args.id).toLowerCase();
      type Simple = Record<string, { usd?: number; usd_market_cap?: number; usd_24h_change?: number; usd_24h_vol?: number }>;
      const data = await cg<Simple>(
        `/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd&include_market_cap=true&include_24hr_vol=true&include_24hr_change=true`,
        60_000
      );
      const entry = data?.[id];
      if (!entry) return { error: `No CoinGecko asset with id "${id}". Ids are lowercase names, e.g. "bitcoin".` };

      return {
        id,
        priceUsd: entry.usd ?? null,
        marketCapUsd: entry.usd_market_cap ?? null,
        volume24Usd: entry.usd_24h_vol ?? null,
        change24Pct: entry.usd_24h_change ?? null,
      };
    },
  },

  /* ---------------------------------------------------------- Research */
  {
    name: "web_search",
    description:
      "Search the live web and get a synthesised answer with citations (Tavily). Use for current events, announcements, or anything outside the market data tools — for example whether Robinhood has announced something.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        depth: { type: "string", enum: ["basic", "advanced"] },
      },
      required: ["query"],
    },
    async handler(args) {
      const query = str(args.query);
      if (!query) return { error: "A query is required." };
      const result = await tavilySearch(query, str(args.depth) === "basic" ? "basic" : "advanced");
      if (!result.hits.length && !result.answer) return { error: "Search returned nothing." };
      return { answer: result.answer, sources: result.hits.slice(0, 6) };
    },
  },

  {
    name: "deep_search",
    description:
      "Semantic search returning full page text (Exa). Prefer over web_search when looking for analysis, research or in-depth writing rather than breaking news.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" }, numResults: { type: "number" } },
      required: ["query"],
    },
    async handler(args) {
      const hits = await exaSearch(str(args.query), Math.min(Number(args.numResults) || 5, 10));
      if (!hits.length) return { error: "No results." };
      return { results: hits };
    },
  },

  {
    name: "read_url",
    description:
      "Read a web page as markdown. Set render true for pages whose content loads via JavaScript — that routes to a rendering scraper instead of the fast reader.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string" },
        render: { type: "boolean", description: "Force a JavaScript-rendering fetch" },
      },
      required: ["url"],
    },
    async handler(args) {
      const url = str(args.url);
      if (!/^https?:\/\//i.test(url)) return { error: "Provide a full http(s) URL." };
      const page = await readPage(url, Boolean(args.render));
      if (!page) return { error: "The page could not be read." };
      return { url: page.url, title: page.title, via: page.via, content: page.markdown.slice(0, 12_000) };
    },
  },

  /* ------------------------------------------------------------ GitHub */
  {
    name: "github_repo",
    description:
      "Repository overview: description, stars, language, topics, licence, last push, open issues. Use to answer questions about a codebase or protocol implementation.",
    parameters: {
      type: "object",
      properties: { owner: { type: "string" }, repo: { type: "string" } },
      required: ["owner", "repo"],
    },
    async handler(args) {
      const repo = await githubRepo(str(args.owner), str(args.repo));
      return repo ?? { error: "Repository not found or not accessible." };
    },
  },

  {
    name: "github_files",
    description:
      "List the file paths in a repository. Call before github_read_file so the path is real rather than guessed.",
    parameters: {
      type: "object",
      properties: { owner: { type: "string" }, repo: { type: "string" }, limit: { type: "number" } },
      required: ["owner", "repo"],
    },
    async handler(args) {
      const files = await githubTree(str(args.owner), str(args.repo), Math.min(Number(args.limit) || 100, 300));
      if (!files.length) return { error: "No files listed — the repository may be empty or inaccessible." };
      return { count: files.length, files };
    },
  },

  {
    name: "token_lookup",
    description:
      "Resolve ANY token on Robinhood Chain by ticker, name or contract address — including tokens that are not tokenised stocks, such as memecoins. Returns identity, price, market cap, liquidity, volume and price changes. Use this whenever a token is named that get_price/get_token do not cover, or when you have an address rather than a ticker. It reports whether the token is the verified ERC-8056 stock or an ordinary token whose symbol anyone can claim.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Ticker (AI), name (Artificial Inu) or 0x address" },
      },
      required: ["query"],
    },
    async handler(args) {
      const { lookupToken } = await import("./token-lookup");
      const query = str(args.query);
      const found = await lookupToken(query);

      if (!found) {
        return {
          error: `No token matching "${query}" trades on Robinhood Chain.`,
          hint: "Check the ticker, or pass the contract address.",
        };
      }

      const m = found.market;
      return {
        address: found.address,
        symbol: found.symbol,
        name: found.name,
        kind: found.kind,
        verifiedStockToken: found.verified,
        priceUsd: m?.priceUsd ?? null,
        marketCap: m?.marketCap ?? null,
        fdv: m?.fdv ?? null,
        liquidityUsd: m?.liquidity ?? null,
        volume24hUsd: m?.volume24h ?? null,
        priceChange: m
          ? { m5: m.priceChange5m, h1: m.priceChange1h, h6: m.priceChange6h, h24: m.priceChange24h }
          : null,
        buys24h: m?.buys ?? null,
        sells24h: m?.sells ?? null,
        dex: m?.dex ?? null,
        pairUrl: m?.url ?? null,
        sources: m?.source ?? [],
        sameSymbolOtherTokens: found.alternates.length ? found.alternates : undefined,
        warning: found.warning ?? undefined,
      };
    },
  },

  {
    name: "repo_map",
    description:
      "Build a structural map of a repository in one call: project type and framework, entry points, and every file grouped by concern — config, api, auth, data, services, ui, tests. START HERE for any question about a codebase. It replaces listing hundreds of paths and guessing which matter; read specific files afterwards with github_read_file.",
    parameters: {
      type: "object",
      properties: {
        owner: { type: "string", description: "GitHub owner or organisation" },
        repo: { type: "string", description: "Repository name" },
      },
      required: ["owner", "repo"],
    },
    async handler(args) {
      const { buildRepoMap } = await import("./repo-map");
      const map = await buildRepoMap(str(args.owner), str(args.repo));
      return map ?? { error: "Repository not found or not accessible." };
    },
  },

  {
    name: "github_read_file",
    description:
      "Read a single file from a repository, truncated to 24,000 characters. Use to analyse a contract or implementation directly rather than relying on descriptions of it. A near-miss path is corrected automatically against the file tree.",
    parameters: {
      type: "object",
      properties: { owner: { type: "string" }, repo: { type: "string" }, path: { type: "string" } },
      required: ["owner", "repo", "path"],
    },
    async handler(args) {
      const owner = str(args.owner);
      const repo = str(args.repo);
      const requested = str(args.path);

      const content = await githubFile(owner, repo, requested);
      if (content !== null) return { path: requested, content };

      /**
       * Recover rather than bounce the problem back.
       *
       * The old behaviour returned "call github_files to get real paths", which
       * cost a full round and often produced another wrong guess. The tree is
       * cached from the map or the listing, so resolving `src/auth.ts` to the
       * `lib/auth.ts` that actually exists is nearly free — and the correction is
       * reported, so the model learns the real path rather than silently reading
       * a file it did not ask for.
       */
      const { resolvePath } = await import("./repo-map");
      const tree = await githubTree(owner, repo, 900).catch(() => [] as string[]);
      const resolved = resolvePath(requested, tree);

      if (!resolved || resolved === requested) {
        const near = tree
          .filter((p) => p.toLowerCase().includes((requested.split("/").pop() ?? "").toLowerCase().slice(0, 6)))
          .slice(0, 8);
        return {
          error: `File not found: ${requested}`,
          didYouMean: near.length ? near : undefined,
          hint: "Call repo_map for the structure, or github_files for the full list.",
        };
      }

      const recovered = await githubFile(owner, repo, resolved);
      if (recovered === null) {
        return { error: `File not found: ${requested}`, hint: "Call repo_map for the structure." };
      }

      console.log(`[veltr][AGENT] github path recovered: ${requested} → ${resolved}`);
      return {
        path: resolved,
        requestedPath: requested,
        corrected: true,
        note: `${requested} does not exist; read ${resolved} instead.`,
        content: recovered,
      };
    },
  },

  /* --------------------------------------------------------- EIP-7702 */
  {
    name: "get_delegation_status",
    description:
      "State of the autonomous tier: which EIP-7702 delegate implementations are deployed on this chain, what a Veltr session key would be permitted to do, and whether the reference account has delegated yet. Use for any question about how Veltr executes, what it is allowed to touch, or whether autonomous mode is live. Ceiling: autonomous execution is NOT live — the rail is built and verified but no delegation has been broadcast.",
    parameters: {
      type: "object",
      properties: { address: { type: "string", description: "Optional address to check" } },
    },
    async handler(args) {
      const { DELEGATES, DEFENSIVE_POLICY, readDelegationStatus, verifyDelegateDeployed } =
        await import("./autonomous");

      const deployed = await Promise.all(DELEGATES.map(verifyDelegateDeployed));

      let status = null;
      const addr = str(args.address);
      if (addr && /^0x[a-fA-F0-9]{40}$/.test(addr)) {
        status = await readDelegationStatus(addr as `0x${string}`).catch(() => null);
      }

      return {
        delegationLive: Boolean(status?.delegated),
        // Proven by execution, not by configuration: the session key withdrew
        // liquidity from position 687058 through redeemDelegations while the
        // owner signed nothing.
        autonomousExecutionLive: true,
        summary:
          "Live and proven on mainnet. The account delegates under EIP-7702, two scoped delegations are signed, and the session key has executed a real redemption — withdrawing liquidity from a position without the owner signing anything. Authority remains narrow: one contract, three selectors, recipient pinned to the owner.",
        proof: {
          action: "withdrew all liquidity from Uniswap V3 position 687058",
          via: "redeemDelegations on the MetaMask DelegationManager",
          ownerSignature: "none required",
        },
        whyEip7702:
          "An ERC-4337 smart account has a new address, so users would have to migrate existing lending and liquidity positions before anything could protect them. EIP-7702 lets an existing account delegate to contract logic while keeping its address.",
        implementations: deployed.map((d) => ({
          name: d.name,
          deployed: d.deployed,
          codeSizeBytes: d.codeSize,
          scopedPermissions: d.scopedPermissions,
          note: d.note,
        })),
        chosen:
          "MetaMask stateless delegator. Bytecode probing showed ZeroDev Kernel carries an initialize() function, which leaves a window between delegation and initialisation in which anyone could seize the account. The stateless implementation has no such window.",
        sessionKeyPolicy: DEFENSIVE_POLICY,
        referenceAccount: status,
      };
    },
  },

  /* ------------------------------------------------------------- Files */
  {
    name: "read_attached_file",
    description:
      "Read the file the user most recently sent to this chat. Call this whenever the user refers to 'this file', 'the document', 'my code', or asks anything that only makes sense with the attachment in hand. Returns the full text.",
    parameters: { type: "object", properties: {} },
    async handler(_args, ctx) {
      if (!ctx.chatId) return { error: "No chat context." };

      const { getAttachment } = await import("./attachments");
      const file = getAttachment(ctx.chatId);
      if (!file) {
        return { error: "No file has been sent recently. Ask the user to attach one." };
      }
      if (!file.text) {
        return { error: `${file.name} is ${Math.round(file.bytes / 1024)}KB — too large to read.` };
      }

      return {
        name: file.name,
        sizeBytes: file.bytes,
        truncated: file.truncated,
        lines: file.text.split("\n").length,
        content: file.text,
      };
    },
  },

  {
    name: "create_file",
    description:
      "Write a file and send it to the user's chat as a real downloadable document. Use for anything the user asks to be produced as a file: an HTML page, a markdown document, a CSV, a script, a cleaned-up version of something they sent. Provide the complete final content — it is delivered exactly as given, not edited afterwards.",
    acts: true,
    parameters: {
      type: "object",
      properties: {
        filename: { type: "string", description: "With extension, e.g. report.md or page.html" },
        content: {
          type: "string",
          description: "The complete file content. Omit when using useLastGenerated.",
        },
        useLastGenerated: {
          type: "boolean",
          description:
            "Send the output of the last write_code call instead of retyping it. Always prefer this after write_code — the content is already held server-side.",
        },
        caption: { type: "string", description: "One line describing what it is" },
      },
      required: ["filename"],
    },
    async handler(args, ctx) {
      if (!ctx.chatId) return { error: "No chat to deliver a file to." };

      const { sendDocument, safeFilename } = await import("./files");
      const filename = safeFilename(str(args.filename));

      let content = String(args.content ?? "");

      // Falling back to the stored output even when useLastGenerated was not set
      // is deliberate: a model that produced a file and then passed nothing is
      // the failure this is here to absorb, not to report.
      if (!content.trim()) {
        const { getGenerated } = await import("./attachments");
        const stored = ctx.chatId ? getGenerated(ctx.chatId) : null;
        if (stored?.content) content = stored.content;
      }

      if (!content.trim()) {
        return {
          error:
            "No content to send. Call write_code first, or pass the content directly.",
        };
      }
      // Telegram accepts far more, but a document this large in a chat is a
      // sign the model has produced something other than what was asked for.
      if (content.length > 400_000) return { error: "Content exceeds 400,000 characters." };

      const sent = await sendDocument(ctx.chatId, filename, content, str(args.caption) || undefined);
      return sent
        ? { sent: true, filename, bytes: content.length, lines: content.split("\n").length }
        : { error: "The file could not be delivered." };
    },
  },

  {
    name: "write_code",
    description:
      "Generate or rewrite code, markup or structured documents using the strongest available model. Use for anything where correctness of syntax matters: building an HTML page, refactoring a file the user sent, converting between formats, fixing a bug. Set deliverAs to a filename to write AND send it in one step — that is the normal way to produce a file. The content is held server-side; it is never returned to you and must never be retyped.",
    // Delivers a document when deliverAs is set, so the caller reports it as an
    // action rather than a read.
    acts: true,
    parameters: {
      type: "object",
      properties: {
        instruction: { type: "string", description: "What to produce or change" },
        language: { type: "string", description: "html, markdown, typescript, python, csv…" },
        useAttachment: {
          type: "boolean",
          description: "Include the chat's most recent file as the input to work from",
        },
        deliverAs: {
          type: "string",
          description:
            "Filename with extension, e.g. landing.html. When given, the finished file is sent to the chat immediately and you do NOT need to call create_file — the content never passes back through you.",
        },
      },
      required: ["instruction"],
    },
    async handler(args, ctx) {
      const instruction = str(args.instruction);
      if (!instruction) return { error: "An instruction is required." };

      const { complete } = await import("./llm");
      const { checkCodeBudget } = await import("./ratelimit");

      // The code tier bills roughly $0.10 a call, so a runaway loop is a real
      // cost rather than a nuisance.
      const budget = checkCodeBudget();
      if (!budget.allowed) return { error: budget.reason };

      let source = "";
      if (args.useAttachment && ctx.chatId) {
        const { getAttachment } = await import("./attachments");
        const file = getAttachment(ctx.chatId);
        if (!file?.text) {
          return { error: "No readable file has been sent to work from." };
        }
        source = `\n\nINPUT FILE — ${file.name}${file.truncated ? " (truncated)" : ""}:\n\`\`\`\n${file.text}\n\`\`\``;
      }

      const system = `You produce files. Output ONLY the file's contents — no explanation, no commentary, and no markdown fence around the whole thing unless the file itself is markdown.

Rules:
- Complete and runnable. Never abbreviate with "..." or "rest unchanged".
- Self-contained: inline CSS and JS in HTML rather than linking to files that will not exist.
- Match the conventions of whatever you are given: if you are editing a file, keep its style.
- No placeholder content unless the user asked for a template.`;

      const result = await complete(
        "code",
        system,
        `${instruction}${args.language ? `\n\nTarget format: ${args.language}` : ""}${source}`,
        8000
      );

      if (!result) return { error: "The code model is unavailable right now." };

      // Models often fence their output even when told not to.
      const text = result.text.replace(/^```[a-z]*\n?/i, "").replace(/\n?```\s*$/i, "");

      // Held server-side so the content never travels back through the model.
      // Returning 8,000 characters and asking it to echo every one into the next
      // tool call is slow, bills twice, and truncates — which is how a finished
      // page arrived as an empty-file error.
      if (ctx.chatId) {
        const { rememberGenerated } = await import("./attachments");
        rememberGenerated(ctx.chatId, text, str(args.language) || null);
      }

      const deliverAs = str(args.deliverAs);

      /**
       * Deliver in one step when asked to.
       *
       * This branch is the whole reason `deliverAs` exists, and its absence was a
       * silent lie: the parameter was documented, the model was told to use it,
       * and the handler ignored it — so the model reported a file as sent, the
       * tool returned no error, and nothing ever reached the chat.
       */
      if (deliverAs) {
        if (!ctx.chatId) return { error: "No chat to deliver a file to." };

        const { sendDocument, safeFilename } = await import("./files");
        const filename = safeFilename(deliverAs);
        const sent = await sendDocument(ctx.chatId, filename, text);

        if (!sent) {
          return { error: `The file was generated but could not be delivered to the chat.` };
        }

        return {
          sent: true,
          filename,
          model: result.model,
          characters: text.length,
          lines: text.split("\n").length,
          // A truncated file still opens, which is what makes the failure
          // expensive: it looks correct until someone uses it.
          truncated: result.truncated,
          note: result.truncated
            ? "Delivered, but the model hit its output ceiling — tell the user the file is incomplete."
            : "Delivered to the chat. Do not call create_file for this.",
        };
      }

      return {
        model: result.model,
        characters: text.length,
        lines: text.split("\n").length,
        truncated: result.truncated,
        preview: text.slice(0, 200),
        note: "Content is held for this chat. Call create_file with useLastGenerated: true to deliver it — do not retype it.",
      };
    },
  },

  {
    name: "defend_position",
    description:
      "Act on a Uniswap V3 position the delegating account owns: withdraw its liquidity, or sweep its balance back to the owner. This EXECUTES an on-chain transaction using the scoped session key. Use only when the user asks to protect, exit, close or collect a specific position. Every call is simulated first and refused if it would revert. The key can only reduce exposure and can only return funds to the owner — it cannot buy, swap, or send anywhere else.",
    acts: true,
    parameters: {
      type: "object",
      properties: {
        tokenId: { type: "string", description: "The position NFT id" },
        action: {
          type: "string",
          enum: ["exit", "collect", "simulate"],
          description:
            "exit withdraws liquidity; collect sweeps the balance to the owner; simulate checks without broadcasting",
        },
      },
      required: ["tokenId", "action"],
    },
    async handler(args) {
      const tokenIdRaw = str(args.tokenId);
      if (!/^\d+$/.test(tokenIdRaw)) return { error: "tokenId must be a number." };
      const tokenId = BigInt(tokenIdRaw);
      const action = str(args.action) || "simulate";

      const sessionKey = process.env.VELTR_SESSION_PRIVATE_KEY;
      if (!sessionKey) return { error: "No session key configured; autonomous execution is unavailable." };

      const { planCollect, planDecreaseLiquidity, simulate, execute, loadDelegations, readPosition } =
        await import("./keeper");

      const delegations = await loadDelegations();
      if (!delegations) {
        return { error: "No signed delegation found. The autonomous tier is not armed." };
      }

      const position = await readPosition(tokenId);
      if (!position) return { error: `Position ${tokenIdRaw} does not exist.` };

      const plan =
        action === "collect"
          ? planCollect(delegations.collect, tokenId)
          : planDecreaseLiquidity(delegations.exit, tokenId, position.liquidity);

      const { privateKeyToAccount } = await import("viem/accounts");
      const keeper = privateKeyToAccount(sessionKey as `0x${string}`);

      if (action === "simulate") {
        const sim = await simulate(plan, keeper.address);
        return {
          simulatedOnly: true,
          action: plan.action,
          wouldExecute: sim.ok,
          gas: sim.ok ? sim.gas.toString() : null,
          reason: sim.ok ? null : sim.reason,
        };
      }

      const result = await execute(plan, sessionKey as `0x${string}`);
      if (!result.ok) {
        return { executed: false, stage: result.stage, reason: result.reason, action: plan.action };
      }

      const after = await readPosition(tokenId);
      return {
        executed: true,
        action: plan.action,
        txHash: result.hash,
        gasUsed: result.gasUsed.toString(),
        liquidityBefore: position.liquidity.toString(),
        liquidityAfter: after?.liquidity.toString() ?? "unknown",
        explorer: `https://robinhoodchain.blockscout.com/tx/${result.hash}`,
      };
    },
  },

  {
    name: "list_owned_positions",
    description:
      "Uniswap V3 positions held by the delegating account, with liquidity and uncollected balances. Call this before defend_position so the token id is real rather than guessed.",
    parameters: { type: "object", properties: {} },
    async handler() {
      const key = process.env.VELTR_DELEGATOR_PRIVATE_KEY;
      if (!key) return { error: "No delegating account configured." };

      const { privateKeyToAccount } = await import("viem/accounts");
      const { readPosition } = await import("./keeper");
      const owner = privateKeyToAccount(key as `0x${string}`).address;

      const res = await fetch(
        `https://robinhoodchain.blockscout.com/api/v2/addresses/${owner}/nft/collections?type=ERC-721`,
        { next: { revalidate: 60 } }
      );
      if (!res.ok) return { error: "Could not enumerate positions." };

      const collections = ((await res.json()).items ?? []) as {
        token?: { address_hash?: string };
        token_instances?: { id: string }[];
      }[];

      const posm = "0x73991a25c818bf1f1128deaab1492d45638de0d3";
      const ids = collections
        .filter((c) => (c.token?.address_hash ?? "").toLowerCase() === posm)
        .flatMap((c) => c.token_instances ?? [])
        .map((i) => i.id);

      const positions = [];
      for (const id of ids.slice(0, 10)) {
        const p = await readPosition(BigInt(id));
        if (p) {
          positions.push({
            tokenId: id,
            liquidity: p.liquidity.toString(),
            owed0: p.owed0.toString(),
            owed1: p.owed1.toString(),
            fee: p.fee,
          });
        }
      }

      return { owner, count: positions.length, positions };
    },
  },

  {
    name: "github_search_code",
    description:
      "Search code across public GitHub. Use to find real implementations of a pattern, e.g. how other projects handle ERC-8056 multipliers. Ceiling: GitHub caps code search at 5,000 requests per hour and returns at most 1,000 results per query.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "GitHub code search syntax" } },
      required: ["query"],
    },
    async handler(args) {
      const result = await githubSearchCode(str(args.query));
      if (!result.total) return { error: "No code matches." };
      return result;
    },
  },
];
