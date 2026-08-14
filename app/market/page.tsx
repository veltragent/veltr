import { SiteHeader, SiteFooter } from "@/components/site-chrome";
import { Display, Eyebrow, StatTile, TokenMark } from "@/components/primitives";
import { PriceChart } from "@/components/price-chart";
import { PremiumWall } from "@/components/premium-wall";
import { buildPremiumWall } from "@/lib/premium-wall";
import { fetchPrimaryPool, fetchCandles, fetchGlobalMarket } from "@/lib/market";
import { fetchMarketStatus, fetchEarningsForTokens } from "@/lib/stocks";
import { count, signedPct, usd } from "@/lib/format";

export const revalidate = 60;

export const metadata = {
  title: "Market — Veltr",
  description:
    "Every tokenised stock on Robinhood Chain priced against its underlying equity. The premium nobody else reports, live.",
};

export default async function MarketPage() {
  const wall = await buildPremiumWall().catch(() => null);

  if (!wall) {
    return (
      <>
        <SiteHeader />
        <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-24">
          <Display className="text-[2.5rem]">Market data unavailable</Display>
          <p className="mt-4 text-[15px] text-ink-soft">
            The chain read or a price source is not responding. This page reads live and does not
            serve cached figures when it cannot verify them.
          </p>
        </main>
        <SiteFooter />
      </>
    );
  }

  const { rows, stats, marketOpen } = wall;

  const [global, status, earnings] = await Promise.all([
    fetchGlobalMarket().catch(() => null),
    fetchMarketStatus().catch(() => null),
    fetchEarningsForTokens(rows.map((r) => r.symbol)).catch(() => []),
  ]);

  const featured = stats.widest;
  const pool = featured ? await fetchPrimaryPool(featured.address).catch(() => null) : null;
  const candles = pool ? await fetchCandles(pool, "hour", 96).catch(() => []) : [];

  return (
    <>
      <SiteHeader />

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-14">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div className="max-w-2xl">
            <Eyebrow>Market · Robinhood Chain</Eyebrow>
            <Display as="h1" className="mt-4 text-[clamp(2.25rem,4.5vw,3.25rem)]">
              Two prices for the same company
            </Display>
            <p className="mt-5 text-[15px] leading-relaxed text-ink-soft">
              Every tokenised stock has an on-chain price set by liquidity and an off-chain price set
              by an exchange. They are never identical. The gap is the premium — and it widens every
              night and weekend, because one of the two markets never closes.
            </p>
          </div>

          <div className="rounded-lg border border-line bg-paper px-4 py-3 text-right">
            <p className="eyebrow">US equity market</p>
            <p className="mt-1.5 text-[15px] font-medium text-ink">{marketOpen ? "Open" : "Closed"}</p>
            <p className="tnum mt-0.5 text-[12px] text-ink-muted">
              {status?.holiday ? status.holiday : (status?.session ?? "—")}
            </p>
          </div>
        </div>

        <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            tone="accent"
            label="Tokens priced"
            value={`${count(stats.priced)} / ${count(stats.tracked)}`}
            detail="Every stock token on the chain, against its real listing"
          />
          <StatTile
            label="Median dislocation"
            value={stats.medianAbsPremiumPct === null ? "—" : `${stats.medianAbsPremiumPct.toFixed(3)}%`}
            detail={`${count(stats.aboveCount)} above parity · ${count(stats.belowCount)} below`}
          />
          <StatTile
            label="Widest"
            value={stats.widest ? signedPct(stats.widest.premiumPct, 2) : "—"}
            detail={
              stats.widest
                ? `${stats.widest.symbol} — ${usd(stats.widest.tokenPriceUsd)} vs ${usd(stats.widest.equityPriceUsd)}`
                : "—"
            }
          />
          <StatTile
            label="Global crypto"
            value={global ? usd(global.totalMarketCapUsd, { compact: true }) : "—"}
            detail={
              global
                ? `${signedPct(global.change24hPct, 2)} 24h · BTC ${global.btcDominance.toFixed(1)}%`
                : "Unavailable"
            }
          />
        </div>

        {featured && candles.length > 1 && (
          <section className="mt-6 rounded-xl border border-line bg-paper p-7">
            <div className="flex flex-wrap items-start justify-between gap-6">
              <div className="flex items-center gap-3">
                <TokenMark iconUrl={featured.iconUrl} symbol={featured.symbol} size={36} />
                <div>
                  <h2 className="font-[family-name:var(--font-display)] text-[1.35rem] tracking-[-0.01em] text-ink">
                    {featured.symbol}
                  </h2>
                  <p className="text-[12px] text-ink-muted">Widest dislocation on the chain</p>
                </div>
              </div>
              <dl className="grid grid-cols-3 gap-6 text-right">
                <div>
                  <dt className="eyebrow">On-chain</dt>
                  <dd className="tnum mt-1.5 text-[15px] text-ink">{usd(featured.tokenPriceUsd)}</dd>
                </div>
                <div>
                  <dt className="eyebrow">Exchange</dt>
                  <dd className="tnum mt-1.5 text-[15px] text-ink">{usd(featured.equityPriceUsd)}</dd>
                </div>
                <div>
                  <dt className="eyebrow">Premium</dt>
                  <dd className="tnum mt-1.5 text-[15px] font-medium text-ink">
                    {signedPct(featured.premiumPct, 3)}
                  </dd>
                </div>
              </dl>
            </div>
            <div className="mt-7">
              <PriceChart candles={candles} label={`${featured.symbol} · hourly · deepest pool`} />
            </div>
          </section>
        )}

        <section className="mt-10">
          <Eyebrow>The premium wall · every stock token</Eyebrow>
          <div className="mt-5">
            <PremiumWall rows={rows} marketOpen={marketOpen} />
          </div>
        </section>

        {earnings.length > 0 && (
          <section className="mt-12">
            <Eyebrow>Upcoming earnings · tokenised names only</Eyebrow>
            <p className="mt-3 max-w-2xl text-[14px] leading-relaxed text-ink-soft">
              The other scheduled event that moves these tokens. Known weeks ahead, and invisible to
              the chain itself.
            </p>
            <div className="mt-5 grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
              {earnings.slice(0, 9).map((e) => (
                <div key={`${e.symbol}-${e.date}`} className="bg-paper p-5">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-[15px] font-medium text-ink">{e.symbol}</span>
                    <span className="tnum text-[12px] text-ink-muted">{e.date}</span>
                  </div>
                  <p className="tnum mt-2 text-[12px] text-ink-soft">
                    {e.epsEstimate !== null ? `EPS est. ${e.epsEstimate}` : "No estimate published"}
                    {e.hour ? ` · ${e.hour}` : ""}
                  </p>
                </div>
              ))}
            </div>
          </section>
        )}

        <p className="mt-10 rounded-lg border border-line bg-paper-edge/50 px-5 py-4 text-[13px] leading-relaxed text-ink-muted">
          On-chain prices from Blockscout and DEX aggregators; exchange prices, session state and
          earnings from Finnhub and Yahoo Finance; global crypto from CoinGecko. All read live.
          Tokens whose underlying is not publicly listed show no premium rather than a fabricated
          one. Informational only — not investment advice.
        </p>
      </main>

      <SiteFooter />
    </>
  );
}
