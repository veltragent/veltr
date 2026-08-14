import { editMessage, sendPlaceholder, deleteMessage } from "./notify";

/**
 * A status line that updates while the agent works.
 *
 * Rotating generic words would be animation; naming the tool actually running
 * is information. A user watching "Reading your file… / Writing the file…"
 * knows the request was understood, and knows which step is slow when one is.
 *
 * Edits are throttled because Telegram rate-limits them per chat, and an agent
 * calling four tools in a second would otherwise burn that budget on cosmetics.
 */

const MIN_EDIT_INTERVAL_MS = 1800;

/** What each tool is doing, in words a user would recognise. */
const TOOL_LABELS: Record<string, string> = {
  get_price: "Checking prices",
  get_token: "Reading on-chain state",
  search_tokens: "Searching tokens",
  get_news: "Reading the news",
  get_market: "Checking the market",
  compare_premiums: "Comparing premiums",
  get_wallet_exposure: "Auditing the wallet",
  get_corporate_actions: "Reading corporate actions",
  get_announced_splits: "Checking announced splits",
  get_analyst_view: "Reading analyst coverage",
  get_onchain_detail: "Reading liquidity and flow",
  list_chain_tokens: "Scanning the chain",
  get_recent_trades: "Reading recent trades",
  get_global_crypto: "Checking global crypto",
  get_crypto_asset: "Looking up the asset",
  web_search: "Searching the web",
  deep_search: "Researching",
  read_url: "Reading the page",
  github_repo: "Reading the repository",
  github_files: "Listing the files",
  github_read_file: "Reading the source",
  github_search_code: "Searching code",
  get_delegation_status: "Checking delegation",
  read_attached_file: "Reading your file",
  write_code: "Writing",
  create_file: "Preparing the file",
  defend_position: "Acting on the position",
  list_owned_positions: "Reading your positions",
  send_chart: "Drawing the chart",
  set_alert_scope: "Updating your alerts",
  get_alert_status: "Checking your alerts",
  /** Emitted between rounds, when the model is deciding what to do next. */
  __thinking__: "Thinking",
};

export type Progress = {
  /** Announce the tool now running. */
  tool: (name: string) => void;
  /** Replace the status with arbitrary text. */
  say: (text: string) => void;
  /** Message id, so the caller can edit it into the final answer. */
  messageId: number | null;
  /** Remove the status line when it will not become the answer. */
  discard: () => Promise<void>;
  /** Stop updating, so a pending edit cannot overwrite the final answer. */
  finish: () => void;
};

/**
 * Phrases a long single tool passes through.
 *
 * Not decoration: a tool like write_code runs for tens of seconds as one call,
 * so without this the line freezes on "Writing" and the chat looks dead. The
 * phases are keyed to elapsed time, which is something actually known, rather
 * than pretending to observe the model's internals.
 */
const SUSTAINED_PHASES: Record<string, { after: number; text: string }[]> = {
  write_code: [
    { after: 0, text: "Reading the request" },
    { after: 4, text: "Writing" },
    { after: 14, text: "Still writing" },
    { after: 30, text: "Finishing the file" },
  ],
  create_file: [
    { after: 0, text: "Preparing the file" },
    { after: 5, text: "Sending it over" },
  ],
  read_attached_file: [{ after: 0, text: "Reading your file" }],
  deep_search: [
    { after: 0, text: "Researching" },
    { after: 8, text: "Reading the results" },
  ],
  web_search: [
    { after: 0, text: "Searching the web" },
    { after: 8, text: "Reading the sources" },
  ],
  read_url: [
    { after: 0, text: "Fetching the page" },
    { after: 8, text: "Reading it" },
  ],
  defend_position: [
    { after: 0, text: "Simulating the transaction" },
    { after: 6, text: "Broadcasting" },
    { after: 20, text: "Waiting for the block" },
  ],
  compare_premiums: [
    { after: 0, text: "Comparing premiums" },
    { after: 10, text: "Still comparing" },
  ],
  __thinking__: [
    { after: 0, text: "Thinking" },
    { after: 10, text: "Still thinking" },
  ],
};

export async function startProgress(chatId: string, initial = "Thinking…"): Promise<Progress> {
  const messageId = await sendPlaceholder(chatId, initial);

  let lastEditAt = 0;
  let pending: string | null = null;
  let timer: NodeJS.Timeout | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let current = initial;
  const startedAt = Date.now();

  const flush = () => {
    if (!messageId || pending === null) return;

    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    // The elapsed count is what tells a user a long step is progressing rather
    // than stuck, which a changing verb alone does not.
    const rendered = elapsed >= 5 ? `${pending}…  ${elapsed}s` : `${pending}…`;
    pending = null;

    // Compared on the rendered string, not the label: the heartbeat repeats the
    // same phase deliberately, and only the seconds change. Deduplicating on the
    // label alone would freeze the counter — the exact failure this exists to
    // prevent. Telegram rejects an edit whose text is identical, so comparing
    // the full string also avoids a wasted call.
    if (rendered === current) return;

    current = rendered;
    lastEditAt = Date.now();
    void editMessage(chatId, messageId, rendered);
  };

  const schedule = (text: string) => {
    if (!messageId) return;
    pending = text;

    const since = Date.now() - lastEditAt;
    if (since >= MIN_EDIT_INTERVAL_MS) {
      flush();
      return;
    }
    if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        flush();
      }, MIN_EDIT_INTERVAL_MS - since);
    }
  };

  /**
   * Keeps the line moving while one long tool runs.
   *
   * A frozen status is the thing that makes a working bot look broken, so the
   * heartbeat advances through the tool's phases and refreshes the elapsed
   * count even when nothing new has started.
   */
  const sustain = (toolName: string) => {
    if (heartbeat) clearInterval(heartbeat);

    const phases = SUSTAINED_PHASES[toolName];
    const base = TOOL_LABELS[toolName] ?? "Working";
    const toolStartedAt = Date.now();

    schedule(phases?.[0]?.text ?? base);
    if (!phases || phases.length < 2) {
      // No phases to walk, but the seconds still need to tick over.
      heartbeat = setInterval(() => schedule(base), 4000);
      return;
    }

    heartbeat = setInterval(() => {
      const seconds = (Date.now() - toolStartedAt) / 1000;
      const phase = [...phases].reverse().find((p) => seconds >= p.after);
      schedule(phase?.text ?? base);
    }, 3500);
  };

  const stopHeartbeat = () => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
  };

  return {
    messageId,
    tool: (name) => sustain(name),
    say: (text) => {
      stopHeartbeat();
      schedule(text);
    },
    discard: async () => {
      stopHeartbeat();
      if (timer) clearTimeout(timer);
      if (messageId) await deleteMessage(chatId, messageId);
    },
    finish: () => {
      stopHeartbeat();
      if (timer) clearTimeout(timer);
    },
  };
}
