import Link from "next/link";
import { notFound } from "next/navigation";
import { SiteHeader, SiteFooter } from "@/components/site-chrome";
import { Display, Eyebrow, SeverityBadge, StatTile, TokenMark } from "@/components/primitives";
import { getSnapshot } from "@/lib/snapshot";
import { fetchCorporateActions } from "@/lib/events";
import { findLiquidityVenues, arbLossFraction } from "@/lib/lp-risk";
import { fetchCandles, fetchPrimaryPool, readPremium } from "@/lib/market";
import { PriceChart } from "@/components/price-chart";
import { TradingViewChart } from "@/components/tradingview-chart";
import { fetchCompanyProfile } from "@/lib/stocks";
import { explorerTokenUrl } from "@/lib/blockscout";
import { compact, count, multiplier as fmtMultiplier, signedPct, usd } from "@/lib/format";

export const revalidate = 120;

type Params = { params: Promise<{ address: string }> };

export async function generateMetadata({ params }: Params) {
  const { address } = await params;
  const result = await getSnapshot();
  const token = result.ok
    ? result.snapshot.tokens.find((t) => t.address.toLowerCase() === address.toLowerCase())
    : null;

  if (!token) return { title: "Token — Veltr" };

  // The premium is the reason anyone shares one of these links, so it belongs in
  // the preview rather than a generic description.
  const premium = await readPremium(token.symbol, token.address).catch(() => null);
  const gap =
    premium?.premiumPct != null
      ? `${premium.premiumPct >= 0 ? "+" : "-"}${Math.abs(premium.premiumPct).toFixed(3)}% to its listed price`
      : "on Robinhood Chain";

  const title = `${token.symbol} — ${gap}`;
  const description = `${token.name} trades at ${premium?.tokenPriceUsd != null ? `$${premium.tokenPriceUsd.toFixed(2)}` : "an on-chain price"} against ${premium?.equityPriceUsd != null ? `$${premium.equityPriceUsd.toFixed(2)}` : "its exchange price"}. ERC-8056 multiplier ${token.multiplier}, ${token.holders.toLocaleString()} holders.`;

  return {
    title,
    description,
    openGraph: { title, description, type: "website" },
    twitter: { card: "summary", title, description },
  };
}

export default async function TokenPage({ params }: Params) {
  const { address } = await params;
  const result = await getSnapshot();
  if (!result.ok) notFound();

  const token = result.snapshot.tokens.find(
    (t) => t.address.toLowerCase() === address.toLowerCase()
  );
  if (!token) notFound();

  const allActions = await fetchCorporateActions(
    result.snapshot.tokens.map((t) => ({ address: t.address, symbol: t.symbol }))
  ).catch(() => []);
  const actions = allActions.filter((a) => a.token.toLowerCase() === token.address.toLowerCase());

  const [pool, premium, profile] = await Promise.all([
    fetchPrimaryPool(token.address).catch(() => null),
    readPremium(token.symbol, token.address).catch(() => null),
    fetchCompanyProfile(token.symbol).catch(() => null),
  ]);
  const candles = pool ? await fetchCandles(pool, "hour", 96).catch(() => []) : [];

  const venues = await findLiquidityVenues(token.address, token.priceUsd).catch(() => []);
  const pooledTokens = venues.reduce((sum, v) => sum + v.tokenBalance, 0);
  const pooledUsd = token.priceUsd === null ? null : pooledTokens * token.priceUsd;
  const splitLoss = arbLossFraction(4);

  const sampleRaw = 100;

  return (
    <>
      <SiteHeader />

      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-14">
        <Link href="/radar" className="text-[13px] text-ink-muted transition-colors hover:text-ink">
          ← Back to radar
        </Link>

        <div className="mt-6 flex flex-wrap items-start justify-between gap-6">
          <div className="flex items-center gap-4">
            <TokenMark iconUrl={token.iconUrl} symbol={token.symbol} size={52} />
            <div>
              <Display as="h1" className="text-[clamp(2rem,4vw,2.75rem)]">
                {token.symbol}
              </Display>
              <p className="mt-1 text-[14px] text-ink-muted">{token.name}</p>
            </div>
          </div>
          <div className="text-right">
            <SeverityBadge severity={token.severity} />
            <a
              href={explorerTokenUrl(token.address)}
              target="_blank"
              rel="noreferrer"
              className="tnum mt-3 block text-[11px] text-ink-faint transition-colors hover:text-ink"
            >
              {token.address}
            </a>
          </div>
        </div>

        <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            tone="accent"
            label="uiMultiplier"
            value={fmtMultiplier(token.multiplier)}
            detail={
              token.multiplier === 1
                ? "Raw and effective balances agree"
                : "Raw balances understate true exposure"
            }
          />
          <StatTile label="Reporting error" value={signedPct(token.reportingErrorPct)} detail="If read via balanceOf" />
          <StatTile label="Price" value={usd(token.priceUsd)} detail={`${count(token.holders)} holders`} />
          <StatTile label="Market cap" value={compact(token.marketCap)} detail="Per Blockscout" />
        </div>

        {token.severity === "scheduled" && token.pendingMultiplier !== null && (
          <section className="mt-6 rounded-xl bg-ink p-7 text-paper">
            <Eyebrow>
              <span className="text-paper/60">Action scheduled</span>
            </Eyebrow>
            <Display className="mt-3 text-[1.75rem] !text-paper">
              Multiplier will move to {fmtMultiplier(token.pendingMultiplier)}
            </Display>
            <p className="mt-4 max-w-xl text-[14px] leading-relaxed text-paper/75">
              A change of {signedPct(token.actionDeltaPct)} is committed on-chain and has not yet
              taken effect
              {token.hoursUntilEffective !== null &&
                ` — ${
                  token.hoursUntilEffective > 0
                    ? `${token.hoursUntilEffective.toFixed(1)} hours remain`
                    : `the effective timestamp passed ${Math.abs(token.hoursUntilEffective).toFixed(1)} hours ago`
                }`}
              . This is the window to adjust collateral or exit liquidity.
            </p>
          </section>
        )}

        {/* ------------------------------------------- Price vs underlying */}
        <section className="mt-12 rounded-xl border border-line bg-paper p-7">
          <div className="flex flex-wrap items-start justify-between gap-6">
            <div>
              <h2 className="font-[family-name:var(--font-display)] text-[1.35rem] tracking-[-0.01em] text-ink">
                On-chain price
              </h2>
              <p className="mt-2 max-w-xl text-[13px] leading-relaxed text-ink-muted">
                Candles from the deepest pool. The token trades continuously; the underlying equity
                does not.
              </p>
            </div>

            {premium && (
              <dl className="grid grid-cols-3 gap-6 text-right">
                <div>
                  <dt className="eyebrow">Token</dt>
                  <dd className="tnum mt-1.5 text-[15px] text-ink">{usd(premium.tokenPriceUsd)}</dd>
                </div>
                <div>
                  <dt className="eyebrow">Underlying</dt>
                  <dd className="tnum mt-1.5 text-[15px] text-ink">{usd(premium.equityPriceUsd)}</dd>
                </div>
                <div>
                  <dt className="eyebrow">Premium</dt>
                  <dd className="tnum mt-1.5 text-[15px] font-medium text-ink">
                    {premium.premiumPct === null ? "—" : signedPct(premium.premiumPct, 3)}
                  </dd>
                </div>
              </dl>
            )}
          </div>

          {/* Two venues, two charts. The left is set by pool liquidity and never
              closes; the right is set by an exchange that shuts at 16:00 ET. */}
          <div className="mt-7 grid gap-8 lg:grid-cols-2">
            <div>
              <p className="eyebrow mb-3">On-chain · deepest pool · 24/7</p>
              <PriceChart candles={candles} label={`${token.symbol} hourly`} height={300} />
            </div>
            <div>
              <p className="eyebrow mb-3">
                Underlying equity · {profile?.exchange?.split(" ")[0] ?? "exchange"} · via TradingView
              </p>
              <TradingViewChart symbol={token.symbol} exchange={profile?.exchange} height={330} />
            </div>
          </div>

          {premium && (
            <p className="mt-5 border-t border-line-soft pt-4 text-[13px] leading-relaxed text-ink-muted">
              {premium.marketOpen ? (
                <>US equity market is open, so the reference price is live.</>
              ) : (
                <>
                  US equity market is closed. The reference price is the last close, so the premium
                  shown is drift accumulated since the bell — not a live spread.
                </>
              )}{" "}
              Liquidity {usd(premium.liquidityUsd, { compact: true })} · 24h volume{" "}
              {usd(premium.volume24hUsd, { compact: true })}.
            </p>
          )}
        </section>

        {venues.length > 0 && (
          <section className="mt-12 rounded-xl border border-line bg-paper p-7">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <h2 className="font-[family-name:var(--font-display)] text-[1.35rem] tracking-[-0.01em] text-ink">
                Liquidity exposure
              </h2>
              <p className="text-[12px] text-ink-faint">
                Pools price raw tokens and cannot see the multiplier
              </p>
            </div>

            <p className="mt-3 max-w-3xl text-[14px] leading-relaxed text-ink-soft">
              {compact(pooledTokens)} {token.symbol}
              {pooledUsd !== null && <> — {usd(pooledUsd, { compact: true })}</>} sits in automated
              market makers. The instant a corporate action applies, each raw token in these venues
              is worth more than the pool is quoting, and arbitrageurs take the difference from the
              liquidity providers.
            </p>

            <div className="mt-6 overflow-hidden rounded-lg border border-line-soft">
              {venues.map((v, i) => (
                <div
                  key={v.address}
                  className={`flex flex-wrap items-center gap-4 px-4 py-3 ${i > 0 ? "border-t border-line-soft" : ""}`}
                >
                  <div className="min-w-[12rem] flex-1">
                    <p className="text-[13px] font-medium text-ink">{v.label}</p>
                    <a
                      href={`https://robinhoodchain.blockscout.com/address/${v.address}`}
                      target="_blank"
                      rel="noreferrer"
                      className="tnum text-[11px] text-ink-faint transition-colors hover:text-ink"
                    >
                      {v.address}
                    </a>
                  </div>
                  <p className="tnum text-[13px] text-ink-soft">{compact(v.tokenBalance)}</p>
                  <p className="tnum w-24 text-right text-[13px] text-ink">
                    {usd(v.valueUsd, { compact: true })}
                  </p>
                </div>
              ))}
            </div>

            <div className="mt-6 grid gap-4 border-t border-line-soft pt-5 sm:grid-cols-3">
              <div>
                <p className="eyebrow">A 0.2% distribution</p>
                <p className="tnum mt-2 text-[1.15rem] text-ink">
                  {(arbLossFraction(1.002) * 100).toFixed(5)}%
                </p>
                <p className="mt-1 text-[12px] text-ink-muted">Immaterial to providers</p>
              </div>
              <div>
                <p className="eyebrow">A 4:1 split</p>
                <p className="tnum mt-2 text-[1.15rem] text-ink">
                  {(splitLoss * 100).toFixed(2)}%
                </p>
                <p className="mt-1 text-[12px] text-ink-muted">Of all pooled value, extracted</p>
              </div>
              <div>
                <p className="eyebrow">On this token today</p>
                <p className="tnum mt-2 text-[1.15rem] text-ink">
                  {pooledUsd === null ? "—" : usd(pooledUsd * splitLoss, { compact: true })}
                </p>
                <p className="mt-1 text-[12px] text-ink-muted">If a 4:1 split applied now</p>
              </div>
            </div>

            <p className="mt-5 text-[13px] leading-relaxed text-ink-muted">
              Figures are the constant-product floor. Concentrated-liquidity positions sit in a
              bounded range; a move large enough to leave that range converts the position entirely
              into the cheaper side, which is strictly worse than shown. Distributions are harmless
              to providers — only whole-ratio splits carry this risk.
            </p>
          </section>
        )}

        <section className="mt-12 grid gap-6 lg:grid-cols-2">
          <div className="rounded-xl border border-line bg-paper p-6">
            <h2 className="font-[family-name:var(--font-display)] text-[1.35rem] tracking-[-0.01em] text-ink">
              The arithmetic
            </h2>
            <p className="mt-2 text-[13px] text-ink-muted">
              What a holder of {sampleRaw} raw tokens actually owns.
            </p>
            <dl className="mt-5 space-y-3 text-[14px]">
              {[
                ["Reported by balanceOf", sampleRaw.toFixed(6)],
                ["uiMultiplier", fmtMultiplier(token.multiplier)],
                ["True exposure (balanceOfUI)", (sampleRaw * token.multiplier).toFixed(6)],
                [
                  "Unaccounted exposure",
                  `${(sampleRaw * token.multiplier - sampleRaw).toFixed(6)}`,
                ],
              ].map(([label, value], i, arr) => (
                <div
                  key={label}
                  className={`flex items-baseline justify-between gap-4 ${
                    i < arr.length - 1 ? "border-b border-line-soft pb-3" : "pt-1"
                  }`}
                >
                  <dt className={i === arr.length - 1 ? "font-medium text-ink" : "text-ink-muted"}>
                    {label}
                  </dt>
                  <dd className={`tnum ${i === arr.length - 1 ? "font-medium text-ink" : "text-ink-soft"}`}>
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
            {token.priceUsd !== null && token.multiplier !== 1 && (
              <p className="mt-5 border-t border-line-soft pt-4 text-[13px] text-ink-soft">
                At {usd(token.priceUsd)}, that unaccounted exposure is worth{" "}
                <span className="tnum font-medium text-ink">
                  {usd((sampleRaw * token.multiplier - sampleRaw) * token.priceUsd)}
                </span>{" "}
                per {sampleRaw} raw tokens held.
              </p>
            )}
          </div>

          <div className="rounded-xl border border-line bg-paper p-6">
            <h2 className="font-[family-name:var(--font-display)] text-[1.35rem] tracking-[-0.01em] text-ink">
              Action history
            </h2>
            <p className="mt-2 text-[13px] text-ink-muted">
              {actions.length === 0
                ? "No corporate action has been applied to this token."
                : `${count(actions.length)} recorded on-chain.`}
            </p>

            {actions.length > 0 && (
              <ol className="mt-5 space-y-4">
                {actions.map((a) => (
                  <li key={a.id} className="border-b border-line-soft pb-4 last:border-0 last:pb-0">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="tnum text-[14px] text-ink">
                        {fmtMultiplier(a.oldMultiplier)} → {fmtMultiplier(a.newMultiplier)}
                      </span>
                      <span className="tnum text-[13px] font-medium text-ink">
                        {signedPct(a.deltaPct)}
                      </span>
                    </div>
                    <p className="tnum mt-1.5 text-[12px] text-ink-muted">
                      Effective {new Date(a.effectiveAt * 1000).toUTCString().replace(" GMT", " UTC")}
                    </p>
                    <p className="tnum mt-1 text-[11px] text-ink-faint">
                      Block {a.blockNumber} ·{" "}
                      {a.committedAt
                        ? `${a.leadTimeHours >= 0 ? a.leadTimeHours.toFixed(1) : Math.abs(a.leadTimeHours).toFixed(1)}h ${a.leadTimeHours >= 0 ? "warning" : "late"}`
                        : "commit time unknown"}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </section>
      </main>

      <SiteFooter />
    </>
  );
}
