import { SiteHeader, SiteFooter } from "@/components/site-chrome";
import { Display, Eyebrow, StatTile } from "@/components/primitives";
import { AlertsPanel } from "@/components/alerts-panel";
import { getSnapshot } from "@/lib/snapshot";
import { fetchCorporateActions, summariseActions } from "@/lib/events";
import { count } from "@/lib/format";

export const revalidate = 300;

export const metadata = {
  title: "The Telegram agent — Veltr",
  description:
    "Ask it anything about Robinhood Chain in plain language. Point it at a token, a repository or a page and it tells you only when something changes. Give it a goal and it works out the steps — then asks before doing anything consequential.",
};

const BOT_USERNAME = process.env.VELTR_TELEGRAM_BOT_USERNAME || "veltragent_bot";

export default async function AlertsPage() {
  const result = await getSnapshot();
  const actions = result.ok
    ? await fetchCorporateActions(
        result.snapshot.tokens.map((t) => ({ address: t.address, symbol: t.symbol }))
      ).catch(() => [])
    : [];
  const stats = summariseActions(actions);
  const medianMinutes =
    stats.medianLeadTimeHours === null ? null : Math.round(stats.medianLeadTimeHours * 60);

  return (
    <>
      <SiteHeader />

      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-14">
        <div className="max-w-2xl">
          <Eyebrow>The Telegram agent</Eyebrow>
          <Display as="h1" className="mt-4 text-[clamp(2.25rem,4.5vw,3.25rem)]">
            It only speaks when something happened
          </Display>
          <p className="mt-5 text-[15px] leading-relaxed text-ink-soft">
            Most bots are a command menu with a language model bolted on. This one decides which of
            its tools a question needs, calls several at once, and acts — sending a chart, watching a
            token, writing a file — instead of telling you which command to type.
          </p>
          <p className="mt-4 text-[15px] leading-relaxed text-ink-soft">
            And it stays quiet. A token that crosses your threshold and keeps climbing gets you one
            message, not one every thirty seconds.
          </p>
        </div>

        <div className="mt-10 grid gap-3 sm:grid-cols-3">
          <StatTile
            tone="accent"
            label="Median warning window"
            value={medianMinutes === null ? "—" : `${medianMinutes} min`}
            detail="Measured across every action this chain has recorded"
          />
          <StatTile
            label="Tokens monitored"
            value={result.ok ? count(result.snapshot.stats.tracked) : "—"}
            detail="Discovered by interface probe"
          />
          <StatTile
            label="Actions recorded"
            value={count(stats.total)}
            detail={`Across ${count(stats.tokensAffected)} tokens`}
          />
        </div>

        <div className="mt-10 grid gap-6 lg:grid-cols-[1.1fr_1fr] lg:items-start">
          <AlertsPanel botUsername={BOT_USERNAME} />

          <div className="rounded-xl bg-ink p-7 text-paper">
            <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-paper/60">
              What an alert looks like
            </p>
            <pre className="mt-5 overflow-x-auto text-[13px] leading-relaxed text-paper/85">
              <code>{`Corporate action scheduled — ORCL

Multiplier will move 1.00000000 →
1.00221091 (+0.2211%).

Effective in 0.2h.

This is the window to adjust collateral
or exit liquidity positions.`}</code>
            </pre>
            <p className="mt-6 border-t border-paper/15 pt-5 text-[13px] leading-relaxed text-paper/70">
              No marketing, no price calls. The change, the timing, and the one thing it affects.
            </p>
          </div>
        </div>

        {/* ------------------------------------------------------- What it does */}
        <section className="mt-16">
          <Eyebrow>Four things, one chat</Eyebrow>
          <Display className="mt-4 max-w-2xl text-[clamp(1.75rem,3.2vw,2.4rem)]">
            Ask, watch, track, delegate
          </Display>

          <div className="mt-10 grid gap-px overflow-hidden rounded-xl border border-line bg-line md:grid-cols-2">
            {[
              {
                head: "Ask anything",
                lead: "why is NVDA above its stock price?",
                body: "Live prices, premiums, liquidity, flow, filings and news — plus any public repository or web page. Send it a file and it reads it; ask for one and it writes it and sends it back as a real document.",
              },
              {
                head: "Watch a token",
                lead: "/watch 0x2e8c31…",
                body: "Any token on the chain, not only tokenised stocks. Alerts on price, market cap, liquidity and 24h volume, at thresholds you set in /settings. It also warns you when a symbol has impostors — six tokens on this chain answer to “NVDA”.",
              },
              {
                head: "Track what changes",
                lead: "/track vercel/next.js",
                body: "A repository, and you hear when a commit lands. A page, and you hear when the words change — clocks, timestamps and “3 minutes ago” do not count. Nothing arrives while nothing has changed.",
              },
              {
                head: "Give it a goal",
                lead: "/mission investigate why the premium went negative",
                body: "It plans what to observe, gathers it, reasons over the evidence and reports with citations. Anything consequential stops and asks you first — and the answer waits, however long you take.",
              },
            ].map((item) => (
              <div key={item.head} className="bg-paper p-8">
                <h3 className="font-[family-name:var(--font-display)] text-[1.35rem] leading-tight tracking-[-0.01em] text-ink">
                  {item.head}
                </h3>
                <p className="tnum mt-3 text-[13px] text-accent-deep">{item.lead}</p>
                <p className="mt-3 text-[14px] leading-relaxed text-ink-soft">{item.body}</p>
              </div>
            ))}
          </div>
        </section>

        <p className="mt-10 rounded-lg border border-line bg-paper-edge/50 px-5 py-4 text-[13px] leading-relaxed text-ink-muted">
          Informational only. Veltr holds no funds and cannot move your assets. It quotes no figure it
          did not fetch, and reports no action it did not verify. Stock tokens on Robinhood Chain are
          debt securities, not equity — holders receive no shareholder rights.
        </p>
      </main>

      <SiteFooter />
    </>
  );
}
