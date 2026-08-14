import Link from "next/link";
import { SiteHeader, SiteFooter } from "@/components/site-chrome";
import { Display, Eyebrow, SeverityBadge, StatTile, TokenMark } from "@/components/primitives";
import { getSnapshot } from "@/lib/snapshot";
import { fetchCorporateActions, summariseActions } from "@/lib/events";
import { count, multiplier as fmtMultiplier, signedPct, usd } from "@/lib/format";

export const revalidate = 60;

export default async function HomePage() {
  const result = await getSnapshot();
  const snapshot = result.ok ? result.snapshot : null;
  const stats = snapshot?.stats;

  const actions = snapshot
    ? await fetchCorporateActions(
        snapshot.tokens.map((t) => ({ address: t.address, symbol: t.symbol }))
      ).catch(() => [])
    : [];
  const actionStats = summariseActions(actions);
  const medianLeadMinutes =
    actionStats.medianLeadTimeHours === null ? null : actionStats.medianLeadTimeHours * 60;

  const headline = snapshot?.tokens.find((t) => t.severity === "drifted") ?? null;
  const affected = snapshot?.tokens.filter((t) => t.severity !== "clear").slice(0, 6) ?? [];

  return (
    <>
      <SiteHeader />

      <main className="flex-1">
        {/* ---------------------------------------------------------- Hero */}
        <section className="mx-auto max-w-6xl px-6 pt-20 pb-16">
          <div className="max-w-3xl">
            <Eyebrow>Robinhood Chain · ERC-8056 · Chain ID 4663</Eyebrow>
            <Display as="h1" className="mt-5 text-[clamp(2.75rem,6.5vw,4.5rem)]">
              Your balance is fixed.
              <br />
              Your ownership is not.
            </Display>
            <p className="mt-7 max-w-2xl text-[1.0625rem] leading-relaxed text-ink-soft">
              Stock tokens on Robinhood Chain never rebase. Splits and dividends move an on-chain
              multiplier instead, leaving raw balances untouched. Every wallet, portfolio tracker and
              tax export that reads <code className="tnum text-[0.95em] text-accent-deep">balanceOf</code>{" "}
              therefore reports the wrong position the moment a corporate action lands.
            </p>
            <p className="mt-4 max-w-2xl text-[1.0625rem] leading-relaxed text-ink-soft">
              <strong className="font-medium text-ink">Veltr Agent</strong> is an autonomous analyst
              for this chain. It reads the multiplier straight from mainnet, prices every token
              against the equity behind it, and watches whatever you point it at — a token, a
              repository, a page. Ask it anything in Telegram and it answers from live data.
            </p>
            <p className="mt-4 max-w-2xl text-[1.0625rem] leading-relaxed text-ink-soft">
              It decides which of its tools a question needs, gathers what it is missing, and asks
              before doing anything consequential. It has no path to inventing a number — every
              figure it quotes came from a call it made.
            </p>

            <div className="mt-9 flex flex-wrap items-center gap-3">
              <Link
                href="/radar"
                className="rounded-lg bg-accent px-5 py-2.5 text-[14px] font-medium text-paper transition-colors hover:bg-accent-deep"
              >
                Open the radar
              </Link>
              <Link
                href="/exposure"
                className="rounded-lg border border-line-strong px-5 py-2.5 text-[14px] font-medium text-ink transition-colors hover:bg-cream-deep"
              >
                Audit a wallet
              </Link>
            </div>
          </div>

          {/* Live chain state */}
          <div className="mt-16 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              tone="accent"
              label="Stock tokens tracked"
              value={stats ? count(stats.tracked) : "—"}
              detail="Discovered by ERC-8056 interface probe, not a hardcoded list"
            />
            {/*
              A bare "0" reads as a broken tile rather than as the good news it
              is. The number is real and stays real — only the wording changes,
              so an empty queue states the product's value instead of looking
              like a failed read.
            */}
            <StatTile
              label="Actions scheduled"
              value={stats ? (stats.scheduled === 0 ? "None" : count(stats.scheduled)) : "—"}
              detail={
                stats && stats.scheduled > 0
                  ? "Queued in newUIMultiplier, not yet effective"
                  : "Nothing queued on-chain right now. You would know before one landed."
              }
            />
            <StatTile
              label="Balances misreported"
              value={stats ? count(stats.drifted) : "—"}
              detail="Multiplier already moved away from 1.0"
            />
            <StatTile
              label="Largest reporting error"
              value={stats?.largestErrorSymbol ? `${stats.largestErrorPct.toFixed(1)}%` : "—"}
              detail={
                stats?.largestErrorSymbol
                  ? `${stats.largestErrorSymbol} — raw balance understates true exposure`
                  : "Awaiting chain read"
              }
            />
          </div>

          {!result.ok && (
            <p className="mt-5 rounded-lg border border-alert/20 bg-alert-tint px-4 py-3 text-[13px] text-alert">
              Live chain read unavailable: {result.error}
            </p>
          )}
        </section>

        {/* ------------------------------------------------------- Evidence */}
        {headline && (
          <section className="mx-auto max-w-6xl px-6 pb-20">
            <div className="overflow-hidden rounded-2xl bg-accent">
              <div className="grid gap-10 p-8 sm:p-12 lg:grid-cols-[1.15fr_1fr] lg:items-center">
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-accent-tint/70">
                    Live on mainnet right now
                  </p>
                  <Display className="mt-4 text-[clamp(1.9rem,3.4vw,2.6rem)] !text-paper">
                    {headline.symbol} carries a multiplier of {fmtMultiplier(headline.multiplier)}.
                  </Display>
                  <p className="mt-5 max-w-lg text-[15px] leading-relaxed text-accent-tint/90">
                    A holder&apos;s raw balance has not changed by a single unit. Their actual
                    exposure has moved by {signedPct(headline.reportingErrorPct)}. Any interface
                    reading the raw ERC-20 balance is quoting a number that is wrong by exactly that
                    margin, for all {count(headline.holders)} holders.
                  </p>
                  <Link
                    href={`/radar#${headline.symbol}`}
                    className="mt-7 inline-flex rounded-lg bg-paper px-5 py-2.5 text-[14px] font-medium text-accent-deep transition-opacity hover:opacity-90"
                  >
                    Inspect on the radar
                  </Link>
                </div>

                {/* Lifts off the ink card rather than darkening into it. */}
                <div className="rounded-xl bg-paper/[0.07] p-6 ring-1 ring-paper/15">
                  <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-accent-tint/70">
                    The arithmetic
                  </p>
                  <dl className="mt-5 space-y-4 text-[14px]">
                    {[
                      ["Reported by balanceOf", "100.000000"],
                      ["uiMultiplier", fmtMultiplier(headline.multiplier)],
                      ["True exposure", (100 * headline.multiplier).toFixed(6)],
                    ].map(([label, value]) => (
                      <div key={label} className="flex items-baseline justify-between gap-4 border-b border-paper/15 pb-3">
                        <dt className="text-accent-tint/75">{label}</dt>
                        <dd className="tnum text-paper">{value}</dd>
                      </div>
                    ))}
                    <div className="flex items-baseline justify-between gap-4 pt-1">
                      <dt className="font-medium text-paper">Unaccounted exposure</dt>
                      <dd className="tnum font-medium text-paper">
                        {signedPct(headline.reportingErrorPct)}
                      </dd>
                    </div>
                  </dl>
                </div>
              </div>
            </div>
          </section>
        )}

        {/* ------------------------------------------------- Why it matters */}
        <section className="border-t border-line bg-paper-edge/40">
          <div className="mx-auto max-w-6xl px-6 py-20">
            <Eyebrow>Why this breaks things</Eyebrow>
            <Display className="mt-4 max-w-2xl text-[clamp(1.9rem,3.6vw,2.75rem)]">
              A fixed balance is convenient for contracts and dangerous for people.
            </Display>

            <div className="mt-12 grid gap-px overflow-hidden rounded-xl border border-line bg-line md:grid-cols-3">
              {[
                {
                  n: "01",
                  title: "Collateral is mispriced",
                  body: "Lending markets sizing a position from raw balances value the collateral incorrectly the moment a multiplier moves. The borrower's real headroom and the protocol's assumed headroom stop agreeing.",
                },
                {
                  n: "02",
                  title: "Liquidity pools do not adjust",
                  body: "An AMM holds raw tokens and has no view of the multiplier. When a corporate action changes what each raw token represents, the pool keeps quoting the stale ratio until arbitrage closes it — at the liquidity provider's cost.",
                },
                {
                  n: "03",
                  title: "Cost basis silently breaks",
                  body: "Self-custodied stock tokens produce no broker statement. A tax export built from transfer history and raw balances will not reconcile against true exposure once a split or reinvested dividend has been applied.",
                },
              ].map((item) => (
                <div key={item.n} className="bg-paper p-8">
                  <p className="tnum text-[13px] text-accent">{item.n}</p>
                  <h3 className="mt-4 font-[family-name:var(--font-display)] text-[1.35rem] leading-tight tracking-[-0.01em] text-ink">
                    {item.title}
                  </h3>
                  <p className="mt-3 text-[14px] leading-relaxed text-ink-soft">{item.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ----------------------------------------------- Current watchlist */}
        {affected.length > 0 && (
          <section className="mx-auto max-w-6xl px-6 py-20">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <Eyebrow>Active multiplier state</Eyebrow>
                <Display className="mt-4 text-[clamp(1.75rem,3.2vw,2.4rem)]">
                  Tokens not currently at 1.0
                </Display>
              </div>
              <Link href="/radar" className="link-underline text-[14px] text-ink-soft">
                View all {stats ? count(stats.tracked) : ""} tokens
              </Link>
            </div>

            <div className="mt-8 overflow-hidden rounded-xl border border-line bg-paper">
              {affected.map((t, i) => (
                <div
                  key={t.address}
                  className={`flex flex-wrap items-center gap-4 px-5 py-4 ${i > 0 ? "border-t border-line-soft" : ""}`}
                >
                  <TokenMark iconUrl={t.iconUrl} symbol={t.symbol} />
                  <div className="min-w-[7rem] flex-1">
                    <p className="text-[14px] font-medium text-ink">{t.symbol}</p>
                    <p className="truncate text-[12px] text-ink-muted">{t.name}</p>
                  </div>
                  <div className="text-right">
                    <p className="eyebrow">Multiplier</p>
                    <p className="tnum mt-1 text-[14px] text-ink">{fmtMultiplier(t.multiplier)}</p>
                  </div>
                  <div className="w-28 text-right">
                    <p className="eyebrow">Error</p>
                    <p className="tnum mt-1 text-[14px] text-accent-deep">
                      {signedPct(t.reportingErrorPct)}
                    </p>
                  </div>
                  <div className="w-24 text-right">
                    <p className="eyebrow">Holders</p>
                    <p className="tnum mt-1 text-[14px] text-ink-soft">{count(t.holders)}</p>
                  </div>
                  <SeverityBadge severity={t.severity} />
                </div>
              ))}
            </div>
          </section>
        )}

        {/* --------------------------------------------- The reaction window */}
        {medianLeadMinutes !== null && actionStats.total > 0 && (
          <section className="mx-auto max-w-6xl px-6 pb-20">
            <div className="grid gap-10 rounded-2xl border border-line bg-paper p-8 sm:p-12 lg:grid-cols-[1fr_1.1fr] lg:items-center">
              <div>
                <Eyebrow>Measured, not estimated</Eyebrow>
                <Display className="mt-4 text-[clamp(1.9rem,3.4vw,2.6rem)]">
                  The median warning window is{" "}
                  {medianLeadMinutes < 60
                    ? `${Math.round(medianLeadMinutes)} minutes`
                    : `${(medianLeadMinutes / 60).toFixed(1)} hours`}
                  .
                </Display>
                <p className="mt-5 max-w-lg text-[15px] leading-relaxed text-ink-soft">
                  Across all {count(actionStats.total)} corporate actions this chain has recorded,
                  that is the gap between the block committing the action and the moment it takes
                  effect. It is the entire period in which a holder can respond.
                </p>
                <p className="mt-4 max-w-lg text-[15px] leading-relaxed text-ink-soft">
                  No one watches a screen for that. This is why the response has to be automated —
                  not as a convenience, but because the window closes faster than a person can
                  reach it.
                </p>
                <Link href="/history" className="link-underline mt-6 inline-block text-[14px] text-ink">
                  Read the full action ledger
                </Link>
              </div>

              <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line">
                {[
                  ["Actions recorded", count(actionStats.total)],
                  ["Tokens affected", count(actionStats.tokensAffected)],
                  ["Splits", count(actionStats.splits)],
                  ["Distributions", count(actionStats.distributions)],
                ].map(([label, value]) => (
                  <div key={label} className="bg-paper p-6">
                    <dt className="eyebrow">{label}</dt>
                    <dd className="tnum mt-3 text-[1.75rem] leading-none text-ink">{value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </section>
        )}

        {/* ---------------------------------------------------- How it works */}
        <section className="border-t border-line">
          <div className="mx-auto max-w-6xl px-6 py-20">
            <Eyebrow>What it actually does</Eyebrow>
            <Display className="mt-4 max-w-2xl text-[clamp(1.9rem,3.6vw,2.75rem)]">
              Ask it. Point it at something. Give it a goal.
            </Display>

            <div className="mt-12 grid gap-4 lg:grid-cols-3">
              {[
                {
                  tier: "Ask",
                  price: "Plain language",
                  body: "Why is NVDA above its stock price? What is actually trading on this chain? Read this repository and tell me where authentication is handled. It works out which of its tools the question needs, calls several at once, and answers from what came back.",
                  points: [
                    "Live prices, premiums, flow, news",
                    "Reads any public repository or page",
                    "Send it a file — it can send one back",
                  ],
                  tone: "paper" as const,
                },
                {
                  tier: "Watch",
                  price: "Set it once",
                  body: "Any token on the chain — a tokenised stock or a memecoin — on price, market cap, liquidity or volume. Repositories and pages too: it tells you when a commit lands or the words on a page change, and stays silent when they do not.",
                  points: [
                    "One alert per move, not one per poll",
                    "Your thresholds, your intervals",
                    "Clocks and timestamps do not count as change",
                  ],
                  tone: "paper" as const,
                },
                {
                  tier: "Act",
                  price: "Only with permission",
                  body: "Give it an objective instead of instructions and it decides what to observe, gathers it, reasons over the evidence, and stops to ask before doing anything consequential. Then it verifies the result before telling you it worked.",
                  points: [
                    "Cites the observation behind every claim",
                    "Consequential actions always ask first",
                    "Never reports an action it did not confirm",
                  ],
                  tone: "accent" as const,
                },
              ].map((tier) => {
                const accent = tier.tone === "accent";
                return (
                  <div
                    key={tier.tier}
                    className={`flex flex-col rounded-xl p-7 ${accent ? "bg-accent" : "border border-line bg-paper"}`}
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <h3
                        className={`font-[family-name:var(--font-display)] text-[1.5rem] tracking-[-0.01em] ${accent ? "text-paper" : "text-ink"}`}
                      >
                        {tier.tier}
                      </h3>
                      <span
                        className={`text-[11px] font-medium uppercase tracking-[0.12em] ${accent ? "text-accent-tint/70" : "text-ink-faint"}`}
                      >
                        {tier.price}
                      </span>
                    </div>
                    <p
                      className={`mt-4 text-[14px] leading-relaxed ${accent ? "text-accent-tint/90" : "text-ink-soft"}`}
                    >
                      {tier.body}
                    </p>
                    <ul className="mt-6 space-y-2.5 border-t pt-5 text-[13px]"
                        style={{ borderColor: accent ? "rgba(253,251,245,0.18)" : "var(--color-line-soft)" }}>
                      {tier.points.map((p) => (
                        <li key={p} className={`flex gap-2.5 ${accent ? "text-accent-tint/85" : "text-ink-soft"}`}>
                          <span className={accent ? "text-paper" : "text-accent"}>—</span>
                          {p}
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>

            <p className="mt-8 max-w-3xl text-[14px] leading-relaxed text-ink-muted">
              The safety property matters more than the automation. Anything that spends, deletes or
              is visible outside your own chat requires you to approve it, in every mode, with no
              override anywhere in the codebase — and a tool nobody has classified is treated as
              consequential by default. A Veltr session key cannot buy, cannot transfer to a third
              party, and cannot increase leverage. Compromised, the worst it reaches is closing a
              position, not draining one.
            </p>
          </div>
        </section>

        {/* ------------------------------------------- Why trust the numbers */}
        <section className="border-t border-line bg-paper-edge/40">
          <div className="mx-auto max-w-6xl px-6 py-20">
            <Eyebrow>The part most of these get wrong</Eyebrow>
            <Display className="mt-4 max-w-3xl text-[clamp(1.9rem,3.6vw,2.75rem)]">
              A confident wrong answer is worse than no answer.
            </Display>
            <p className="mt-6 max-w-2xl text-[15px] leading-relaxed text-ink-soft">
              Anything with a language model behind it can produce a plausible price, a plausible
              source, and a plausible claim that it did something. Veltr is built so that it cannot.
            </p>

            <div className="mt-12 grid gap-px overflow-hidden rounded-xl border border-line bg-line md:grid-cols-3">
              {[
                {
                  title: "Every figure is fetched",
                  body: "No price, percentage, holder count or date reaches you that did not come back from a call. When a source is unavailable it says so — a missing number is never quietly replaced with zero, which is how a data outage becomes a false alert.",
                },
                {
                  title: "Claims must cite evidence",
                  body: "Each observation enters a ledger with an id. A conclusion has to point at ids that exist, and one that cites nothing — or cites something that never happened — is discarded. You get “the evidence is not sufficient” rather than a guess. Links are filtered against what was actually retrieved.",
                },
                {
                  title: "Actions are verified",
                  body: "After acting, a second independent read confirms the world is in the state the action claimed. A step with no way to check it is reported as unverified, never as done. If it says a file was sent, a file was sent.",
                },
              ].map((item) => (
                <div key={item.title} className="bg-paper p-8">
                  <h3 className="font-[family-name:var(--font-display)] text-[1.35rem] leading-tight tracking-[-0.01em] text-ink">
                    {item.title}
                  </h3>
                  <p className="mt-3 text-[14px] leading-relaxed text-ink-soft">{item.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------------ CTA */}
        <section className="border-t border-line">
          <div className="mx-auto max-w-6xl px-6 py-20 text-center">
            <Display className="mx-auto max-w-2xl text-[clamp(1.9rem,4vw,2.9rem)]">
              Find out what your wallet is not telling you.
            </Display>
            <p className="mx-auto mt-5 max-w-xl text-[15px] leading-relaxed text-ink-soft">
              Enter any address. Veltr reads both the raw and the effective balance for every stock
              token it holds and reports the difference. No connection, no signature, no account.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <Link
                href="/exposure"
                className="inline-flex rounded-lg bg-accent px-6 py-3 text-[14px] font-medium text-paper transition-colors hover:bg-accent-deep"
              >
                Run an exposure audit
              </Link>
              <Link
                href="/alerts"
                className="inline-flex rounded-lg border border-line-strong px-6 py-3 text-[14px] font-medium text-ink transition-colors hover:bg-cream-deep"
              >
                Open it in Telegram
              </Link>
            </div>
            {snapshot && (
              <p className="tnum mt-6 text-[12px] text-ink-faint">
                Chain state read at block {snapshot.blockNumber ?? "—"} ·{" "}
                {usd(stats?.notionalAtRisk ?? null, { compact: true })} of tracked market cap sits in
                tokens with active multiplier state
              </p>
            )}
          </div>
        </section>
      </main>

      <SiteFooter />
    </>
  );
}
