import { SiteHeader, SiteFooter } from "@/components/site-chrome";
import { Display, Eyebrow, StatTile } from "@/components/primitives";
import { RadarTable } from "@/components/radar-table";
import { AgentPanel } from "@/components/agent-panel";
import { getSnapshot } from "@/lib/snapshot";
import { count, usd } from "@/lib/format";

export const revalidate = 60;

export const metadata = {
  title: "Radar — Veltr",
  description:
    "Live ERC-8056 multiplier state for every stock token on Robinhood Chain, ranked by how far reported balances have drifted from true exposure.",
};

export default async function RadarPage() {
  const result = await getSnapshot();

  if (!result.ok) {
    return (
      <>
        <SiteHeader />
        <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-24">
          <Display className="text-[2.5rem]">Chain read unavailable</Display>
          <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-ink-soft">{result.error}</p>
          <p className="mt-3 max-w-xl text-[14px] text-ink-muted">
            The public Robinhood Chain RPC is rate-limited and documented as unsuitable for
            production. Set <code className="tnum text-accent-deep">VELTR_RPC_URL</code> to a
            dedicated endpoint.
          </p>
        </main>
        <SiteFooter />
      </>
    );
  }

  const { tokens, stats, blockNumber, generatedAt } = result.snapshot;

  return (
    <>
      <SiteHeader />

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-14">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div className="max-w-2xl">
            <Eyebrow>Live · Robinhood Chain mainnet</Eyebrow>
            <Display as="h1" className="mt-4 text-[clamp(2.25rem,4.5vw,3.25rem)]">
              Corporate action radar
            </Display>
            <p className="mt-5 text-[15px] leading-relaxed text-ink-soft">
              Every listed stock token, discovered by probing the ERC-8056 interface rather than
              reading a hardcoded registry. Ranked by the gap between what{" "}
              <code className="tnum text-[0.95em] text-accent-deep">balanceOf</code> reports and what
              a holder actually owns.
            </p>
          </div>
          <p className="tnum text-[12px] text-ink-faint">
            Block {blockNumber ?? "—"}
            <br />
            Read {new Date(generatedAt).toUTCString()}
          </p>
        </div>

        <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile tone="accent" label="Tokens tracked" value={count(stats.tracked)} detail="ERC-8056 confirmed on-chain" />
          <StatTile
            label="Scheduled actions"
            value={count(stats.scheduled)}
            detail="newUIMultiplier differs from current"
          />
          <StatTile
            label="Misreporting now"
            value={count(stats.drifted)}
            detail={`${count(stats.holdersExposed)} holder positions affected`}
          />
          <StatTile
            label="Notional in affected tokens"
            value={usd(stats.notionalAtRisk, { compact: true })}
            detail="Market cap sitting behind a non-unit multiplier"
          />
        </div>

        <div className="mt-12">
          <RadarTable tokens={tokens} />
        </div>

        <div className="mt-12">
          <AgentPanel />
        </div>

        <p className="mt-10 rounded-lg border border-line bg-paper-edge/50 px-5 py-4 text-[13px] leading-relaxed text-ink-muted">
          <span className="font-medium text-ink-soft">Reading this table.</span> A multiplier of
          exactly 1.0 means raw and effective balances agree. Anything else means every interface
          reading the plain ERC-20 balance is reporting a position that is wrong by the stated margin.
          A scheduled action is one that is committed on-chain but has not yet reached its effective
          timestamp — the window in which a position can still be adjusted.
        </p>
      </main>

      <SiteFooter />
    </>
  );
}
