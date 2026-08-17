import Link from "next/link";
import { SiteHeader, SiteFooter, GITHUB_URL, TELEGRAM_URL } from "@/components/site-chrome";
import { Display, Eyebrow } from "@/components/primitives";
import { GithubMark, TelegramMark } from "@/components/marks";

export const metadata = {
  title: "Documentation — Veltr Agent",
  description:
    "What Veltr Agent is, why it exists, and every command it answers. A reference for the Telegram agent and the live data behind it.",
};

/**
 * Documentation.
 *
 * Deliberately not a second copy of anything already on the site. The five-step
 * loop is described once, on the homepage, and linked to from here; the chain
 * mechanics live on /method. What was genuinely missing — and what this page is
 * for — is a reference: every command, what it returns, and what the agent will
 * refuse to do.
 *
 * Two explanations of the same thing drift apart, and the one that is wrong is
 * always the one somebody read.
 */

const CONTENTS = [
  { id: "what", label: "What it is" },
  { id: "why", label: "Why it exists" },
  { id: "start", label: "Getting started" },
  { id: "market", label: "Market data" },
  { id: "watch", label: "Watching a token" },
  { id: "tracking", label: "Repositories and pages" },
  { id: "missions", label: "Missions" },
  { id: "files", label: "Files" },
  { id: "limits", label: "What it will not do" },
];

function Section({
  id,
  eyebrow,
  title,
  children,
}: {
  id: string;
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24 border-t border-line py-14 first:border-t-0 first:pt-0">
      <Eyebrow>{eyebrow}</Eyebrow>
      <Display className="mt-4 max-w-2xl text-[clamp(1.6rem,3vw,2.15rem)]">{title}</Display>
      <div className="mt-6 max-w-3xl space-y-4 text-[15px] leading-relaxed text-ink-soft">
        {children}
      </div>
    </section>
  );
}

/**
 * A command and what it answers.
 *
 * A table would be the obvious choice and the wrong one: on a phone it either
 * overflows the page or squeezes the description into a column two words wide.
 * Stacked rows read the same at every width.
 */
function Commands({ items }: { items: { cmd: string; body: string }[] }) {
  return (
    <dl className="mt-6 overflow-hidden rounded-xl border border-line bg-paper">
      {items.map((item, i) => (
        <div
          key={item.cmd}
          className={`flex flex-col gap-1 px-5 py-4 sm:flex-row sm:gap-6 ${
            i > 0 ? "border-t border-line-soft" : ""
          }`}
        >
          <dt className="tnum shrink-0 text-[13px] font-medium text-ink sm:w-52">{item.cmd}</dt>
          <dd className="text-[13px] leading-relaxed text-ink-muted">{item.body}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function DocsPage() {
  return (
    <>
      <SiteHeader />

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-14">
        <div className="max-w-3xl">
          <Eyebrow>Documentation</Eyebrow>
          <Display as="h1" className="mt-4 text-[clamp(2.25rem,4.5vw,3.25rem)]">
            Everything Veltr Agent answers, and what it refuses.
          </Display>
          <p className="mt-5 text-[15px] leading-relaxed text-ink-soft">
            Veltr Agent runs as a Telegram bot backed by the same live data this website reads. This
            page is the reference: what it is for, why it works the way it does, and every command it
            takes.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <a
              href={TELEGRAM_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-2.5 text-[14px] font-medium text-paper transition-colors hover:bg-accent-deep"
            >
              <TelegramMark className="h-4 w-4" />
              Open in Telegram
            </a>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-lg border border-line-strong px-5 py-2.5 text-[14px] font-medium text-ink transition-colors hover:bg-cream-deep"
            >
              <GithubMark className="h-4 w-4" />
              Source
            </a>
          </div>
        </div>

        {/* Contents. A plain list of anchors — no script, works before hydration. */}
        <nav aria-label="Contents" className="mt-12 rounded-xl border border-line bg-paper p-5">
          <p className="eyebrow">On this page</p>
          <ul className="mt-4 grid gap-x-8 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
            {CONTENTS.map((item) => (
              <li key={item.id}>
                <a className="link-underline text-[13px] text-ink-soft" href={`#${item.id}`}>
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="mt-14">
          <Section id="what" eyebrow="01 · Purpose" title="An analyst for a chain where balances lie">
            <p>
              Veltr Agent reads Robinhood Chain directly and answers questions about it in plain
              language. It prices every tokenised stock against the real share behind it, watches
              anything you point it at, and can run an objective on a schedule.
            </p>
            <p>
              It is a reading tool. It holds no funds, needs no wallet connection and asks for no
              signature. Everything it reports came from a call it made, and it can show you which
              one.
            </p>
          </Section>

          <Section id="why" eyebrow="02 · Why" title="A split moves a multiplier, not your balance">
            <p>
              US equities trade on this chain as tokens that never rebase. When a split or a dividend
              lands, an on-chain multiplier moves and every raw balance stays exactly as it was. Any
              wallet, tracker or tax export reading{" "}
              <code className="tnum text-[0.95em] text-accent-deep">balanceOf</code> therefore shows a
              position that is wrong by precisely the size of the corporate action — and shows it
              confidently.
            </p>
            <p>
              The warning window before an action takes effect is about ten minutes on this chain.
              Nobody watches a screen for that, which is why the useful half of Veltr Agent is the
              half that messages you.{" "}
              <Link className="link-underline text-ink" href="/method">
                The mechanism is documented in full on Method
              </Link>
              .
            </p>
          </Section>

          <Section id="start" eyebrow="03 · Getting started" title="Send it a message">
            <p>
              Open the bot and send <code className="tnum text-[0.95em] text-accent-deep">/start</code>.
              There is no account, no key and nothing to install. Ask a question in plain language or
              use any command below — both work, and the commands are simply the fast path.
            </p>
            <p>
              How a question becomes an answer — observe, reason, decide, act, verify — is described
              on{" "}
              <Link className="link-underline text-ink" href="/#how-it-works">
                the homepage
              </Link>
              .
            </p>
          </Section>

          <Section id="market" eyebrow="04 · Market data" title="Two prices for the same company">
            <p>
              Every figure is read live at the moment you ask. The premium is the gap between what a
              tokenised share costs here and what the actual share costs on its exchange.
            </p>
            <Commands
              items={[
                { cmd: "/price SYM", body: "Exchange price, on-chain price and the premium between them." },
                { cmd: "/premium", body: "The premium across every tokenised stock, widest first." },
                { cmd: "/chart SYM", body: "A price chart drawn from the deepest pool." },
                { cmd: "/token SYM", body: "Multiplier, holders, liquidity and analyst coverage." },
                { cmd: "/news SYM", body: "Company headlines and SEC filings." },
                { cmd: "/market", body: "Global crypto, chain state and whether the equity session is open." },
                { cmd: "/splits", body: "Announced splits that will hit tokenised names." },
                { cmd: "/chain", body: "Every token on the chain, by volume." },
                { cmd: "/flow SYM", body: "Live swap flow and trade sizes." },
                {
                  cmd: "/portfolio 0x…",
                  body: "Tokenised shares an address holds, valued at both the token price and the real share price. Reads the effective balance, so it stays correct after a split.",
                },
                {
                  cmd: "/scan SYM",
                  body: "The full read on one token: depth, holders, concentration, flow, contract security and six scores, each carrying the share of its inputs that had data behind it.",
                },
                {
                  cmd: "/why SYM",
                  body: "What is moving it — separating what was measured from what is a statistical signal from what is merely consistent with the data.",
                },
                { cmd: "/pulse", body: "The whole chain: breadth momentum, movers filtered to real depth, and anything behaving unusually against its own history." },
                {
                  cmd: "/smart SYM",
                  body: "Wallets accumulating or distributing right now, ranked on size, conviction and repetition. Current behaviour, not track record — see the limits below.",
                },
                { cmd: "/wallet 0x…", body: "An address: age, activity, holdings, concentration, and buy/sell flow over the trades that were visible." },
                { cmd: "/related SYM", body: "Tokens being traded by the same wallets. Overlap only — it establishes no common ownership." },
              ]}
            />
            <p>
              Two limits worth stating plainly. Wallet <em>track record</em> is not available on this
              chain: the trade feed reaches hours rather than months, so Veltr reports how a wallet is
              behaving now and never claims it has been right before. And nothing on chain records
              what an address paid, so profit and loss is not computed — only the buy and sell flow
              that was actually visible, labelled as covering exactly that.
            </p>
            <p>
              Contract security comes from GoPlus, which supports this chain but answers 21 of its 36
              checks here. The 15 it omits include honeypot, mintable and pausable. Those are reported
              as <em>not checked</em> rather than left out, because a missing warning reads as a pass.
            </p>
          </Section>

          <Section id="watch" eyebrow="05 · Alerts" title="Told once, when it happens">
            <p>
              A watch monitors any contract on this chain. Thresholds are yours alone — two people
              watching the same token get their own, and the token is still only read once.
            </p>
            <p>
              An alert fires when a condition <em>becomes</em> true, not while it stays true. A move
              has to retreat before the same alert can fire again, which is the difference between
              being told something and being told it every thirty seconds.
            </p>
            <Commands
              items={[
                { cmd: "/watch 0x…", body: "Watch a token for price, market cap, liquidity, volume or premium moves." },
                { cmd: "/watch <wallet>", body: "Scope corporate-action alerts to the tokens that wallet holds." },
                { cmd: "/watches", body: "Your watchlist, priced live." },
                { cmd: "/unwatch 0x…", body: "Stop watching that token." },
                { cmd: "/settings", body: "Thresholds, check interval, cooldown and which price sources to use." },
                { cmd: "/signals", body: "Pattern alerts on tokens you watch — accumulation, volume regime changes, whale prints. Off until you turn them on." },
                { cmd: "/alerts", body: "Chain-wide alerts from Veltr. On by default; /alerts off stops them without touching your watches." },
                { cmd: "/status", body: "What Veltr is seeing right now." },
                { cmd: "/stop", body: "Unsubscribe from everything." },
              ]}
            />
            <p>
              Chain-wide alerts are separate from your watchlist and deliberately rare. A watch fires
              at whatever threshold you set; a chain-wide alert has to clear a much higher bar —
              strong, well-evidenced, and unusual against the token&rsquo;s own recorded history —
              then wait out a cooling-off period so one event is never described three times.
            </p>
            <p>
              Premium alerts are the ones unique to this chain: they fire when a token drifts away
              from the share it represents. They stay silent while the equity market is shut, because
              the reference price is then a stale close and the gap is drift rather than a spread
              anyone could trade.
            </p>
          </Section>

          <Section id="tracking" eyebrow="06 · Change tracking" title="Repositories and pages">
            <p>
              The same idea pointed at things that are not tokens. It reports when something actually
              changed and stays quiet otherwise.
            </p>
            <Commands
              items={[
                { cmd: "/track owner/repo", body: "A repository — tells you when a commit lands." },
                { cmd: "/track https://…", body: "A page — tells you when the words on it change." },
                { cmd: "/tracks", body: "What you are tracking." },
                { cmd: "/untrack <target>", body: "Stop." },
              ]}
            />
          </Section>

          <Section id="missions" eyebrow="07 · Missions" title="Give it an objective, not steps">
            <p>
              A mission is a question worth more than one lookup. It decides what to observe, gathers
              it, and asks before doing anything consequential. On a schedule it reports only when the
              figures it observed actually moved — a run that finds the same market as last time says
              nothing at all.
            </p>
            <Commands
              items={[
                { cmd: "/mission …", body: "State an objective. It works out the steps." },
                { cmd: "/missions", body: "Your missions, and anything waiting on your approval." },
                { cmd: "/every 1h …", body: "Run an objective on a schedule. Silent unless the figures move." },
                { cmd: "/schedules", body: "Your recurring missions." },
                { cmd: "/unschedule 1", body: "Stop one." },
                { cmd: "/cancel", body: "Abandon whatever is running." },
              ]}
            />
          </Section>

          <Section id="files" eyebrow="08 · Files" title="Send one, get one back">
            <p>
              Send any text file — code, markdown, HTML, CSV, JSON — and it reads it. Then ask for
              whatever you want done: explain it, clean it up, find the bug, turn it into a page. What
              it writes comes back as a real document, not as a message you have to copy out.
            </p>
            <p>
              If a file could not be produced or sent, it says so. It will not tell you something
              arrived when nothing did.
            </p>
          </Section>

          <Section id="limits" eyebrow="09 · Limits" title="What it will not do">
            <p>
              It does not trade, and there is no code path that could. It holds no funds and takes no
              signature.
            </p>
            <p>
              It does not estimate. Where a figure could not be read it says so rather than filling
              the gap — a missing number is reported as missing.
            </p>
            <p>
              It does not act on anything consequential without asking, and after acting it checks
              independently that the world is in the state it claimed. A step it cannot verify is
              reported as unverified, never as done.
            </p>
            <p>
              Stock tokens on Robinhood Chain are debt securities, not equity — holders receive no
              shareholder rights. This is informational tooling, not investment, tax or legal advice.{" "}
              <Link className="link-underline text-ink" href="/method">
                Sources and further limits
              </Link>
              .
            </p>
          </Section>
        </div>
      </main>

      <SiteFooter />
    </>
  );
}
