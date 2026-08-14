import Link from "next/link";
import { SiteHeader, SiteFooter } from "@/components/site-chrome";
import { Display, Eyebrow, StatTile } from "@/components/primitives";
import { getSnapshot } from "@/lib/snapshot";
import { fetchCorporateActions, summariseActions, type CorporateAction } from "@/lib/events";
import { count, signedPct, multiplier as fmtMultiplier } from "@/lib/format";

export const revalidate = 300;

export const metadata = {
  title: "History — Veltr",
  description:
    "Every corporate action ever applied to a stock token on Robinhood Chain, read from UIMultiplierUpdated logs.",
};

const KIND_LABEL: Record<CorporateAction["kind"], string> = {
  split: "Split",
  distribution: "Distribution",
  adjustment: "Adjustment",
};

function utc(ts: number): string {
  if (!ts) return "unknown";
  return new Date(ts * 1000).toUTCString().replace(" GMT", " UTC");
}

export default async function HistoryPage() {
  const result = await getSnapshot();

  if (!result.ok) {
    return (
      <>
        <SiteHeader />
        <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-24">
          <Display className="text-[2.5rem]">Chain read unavailable</Display>
          <p className="mt-4 text-[15px] text-ink-soft">{result.error}</p>
        </main>
        <SiteFooter />
      </>
    );
  }

  const actions = await fetchCorporateActions(
    result.snapshot.tokens.map((t) => ({ address: t.address, symbol: t.symbol }))
  ).catch(() => [] as CorporateAction[]);

  const stats = summariseActions(actions);

  return (
    <>
      <SiteHeader />

      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-14">
        <div className="max-w-2xl">
          <Eyebrow>Corporate action ledger</Eyebrow>
          <Display as="h1" className="mt-4 text-[clamp(2.25rem,4.5vw,3.25rem)]">
            Every action the chain has recorded
          </Display>
          <p className="mt-5 text-[15px] leading-relaxed text-ink-soft">
            Read from <code className="tnum text-accent-deep">UIMultiplierUpdated</code> logs across
            all {count(result.snapshot.stats.tracked)} stock tokens, from genesis to head. This is
            the complete history — not a sample, and not sourced from an index.
          </p>
        </div>

        <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            tone="accent"
            label="Actions recorded"
            value={count(stats.total)}
            detail={`Across ${count(stats.tokensAffected)} distinct tokens`}
          />
          <StatTile label="Splits" value={count(stats.splits)} detail="Whole-ratio multiplier changes" />
          <StatTile
            label="Distributions"
            value={count(stats.distributions)}
            detail="Sub-percent accruals, typically reinvested dividends"
          />
          <StatTile
            label="Median warning window"
            value={
              stats.medianLeadTimeHours === null
                ? "—"
                : `${stats.medianLeadTimeHours.toFixed(1)}h`
            }
            detail="Between on-chain commitment and effect"
          />
        </div>

        {actions.length === 0 ? (
          <p className="mt-12 rounded-xl border border-line bg-paper px-6 py-14 text-center text-[15px] text-ink-muted">
            No corporate actions have been recorded on this chain yet.
          </p>
        ) : (
          <div className="mt-12">
            <Eyebrow>Timeline · most recent first</Eyebrow>
            <ol className="mt-6 space-y-px overflow-hidden rounded-xl border border-line bg-line">
              {actions.map((a) => {
                const lead = a.leadTimeHours;
                return (
                  <li key={a.id} className="bg-paper p-6">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-baseline gap-3">
                          <Link
                            href={`/token/${a.token}`}
                            className="font-[family-name:var(--font-display)] text-[1.5rem] tracking-[-0.01em] text-ink transition-opacity hover:opacity-70"
                          >
                            {a.symbol ?? "Unknown"}
                          </Link>
                          <span className="rounded-full border border-ink-muted px-2.5 py-0.5 text-[11px] font-medium text-ink">
                            {KIND_LABEL[a.kind]}
                          </span>
                        </div>
                        <p className="tnum mt-3 text-[14px] text-ink-soft">
                          {fmtMultiplier(a.oldMultiplier)} → {fmtMultiplier(a.newMultiplier)}
                          <span className="ml-3 font-medium text-ink">{signedPct(a.deltaPct)}</span>
                        </p>
                      </div>

                      <dl className="grid shrink-0 gap-3 text-[12px] sm:grid-cols-3 sm:gap-6">
                        <div>
                          <dt className="eyebrow">Committed</dt>
                          <dd className="tnum mt-1 text-ink-soft">
                            {a.committedAt ? utc(a.committedAt) : `block ${a.blockNumber}`}
                          </dd>
                        </div>
                        <div>
                          <dt className="eyebrow">Effective</dt>
                          <dd className="tnum mt-1 text-ink-soft">{utc(a.effectiveAt)}</dd>
                        </div>
                        <div>
                          <dt className="eyebrow">Warning window</dt>
                          <dd className="tnum mt-1 font-medium text-ink">
                            {a.committedAt === 0
                              ? "—"
                              : lead >= 0
                                ? `${lead.toFixed(1)}h ahead`
                                : `${Math.abs(lead).toFixed(1)}h late`}
                          </dd>
                        </div>
                      </dl>
                    </div>

                    <div className="mt-4 flex flex-wrap gap-4 border-t border-line-soft pt-3 text-[11px] text-ink-faint">
                      <span className="tnum">Block {a.blockNumber}</span>
                      <a
                        href={`https://robinhoodchain.blockscout.com/tx/${a.txHash}`}
                        target="_blank"
                        rel="noreferrer"
                        className="tnum transition-colors hover:text-ink"
                      >
                        {a.txHash.slice(0, 14)}…
                      </a>
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
        )}

        <p className="mt-10 rounded-lg border border-line bg-paper-edge/50 px-5 py-4 text-[13px] leading-relaxed text-ink-muted">
          <span className="font-medium text-ink-soft">Warning window</span> is the gap between the
          block that committed the action and the effective timestamp the contract declared. A
          positive window is the period in which a holder could still adjust a position with full
          knowledge of what was coming. A negative one means the log was written after the action
          already applied, leaving no room to react.
        </p>
      </main>

      <SiteFooter />
    </>
  );
}
