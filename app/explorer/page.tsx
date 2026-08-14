import Link from "next/link";
import { SiteHeader, SiteFooter } from "@/components/site-chrome";
import { Display, Eyebrow, StatTile } from "@/components/primitives";
import { codexTopTokens } from "@/lib/codex";
import { getSnapshot } from "@/lib/snapshot";
import { compact, count, signedPct, usd } from "@/lib/format";

export const revalidate = 120;

export const metadata = {
  title: "Explorer — Veltr",
  description:
    "Every token on Robinhood Chain ranked by volume, liquidity and holders — stock tokens, stablecoins and memecoins alike.",
};

/**
 * Whole-chain view.
 *
 * The rest of the site is about the 95 stock tokens. This page is about
 * everything else too, because the chain's actual activity is dominated by
 * assets the stock-token radar deliberately ignores — and a reader deciding
 * whether this chain is alive needs to see that.
 */
export default async function ExplorerPage() {
  const [byVolume, byLiquidity, snapshot] = await Promise.all([
    codexTopTokens("volume24", 50).catch(() => ({ tokens: [], indexed: 0 })),
    codexTopTokens("liquidity", 20).catch(() => ({ tokens: [], indexed: 0 })),
    getSnapshot(),
  ]);

  const stockSymbols = new Set(
    (snapshot.ok ? snapshot.snapshot.tokens : []).map((t) => t.symbol.toUpperCase())
  );

  const totalVolume = byVolume.tokens.reduce((s, t) => s + (t.volume24Usd ?? 0), 0);
  const totalLiquidity = byLiquidity.tokens.reduce((s, t) => s + (t.liquidityUsd ?? 0), 0);
  const stockVolume = byVolume.tokens
    .filter((t) => stockSymbols.has(t.symbol.toUpperCase()))
    .reduce((s, t) => s + (t.volume24Usd ?? 0), 0);

  const stockShare = totalVolume > 0 ? (stockVolume / totalVolume) * 100 : 0;

  if (byVolume.tokens.length === 0) {
    return (
      <>
        <SiteHeader />
        <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-24">
          <Display className="text-[2.5rem]">Explorer unavailable</Display>
          <p className="mt-4 max-w-xl text-[15px] text-ink-soft">
            The on-chain index is not responding. This page reads live rather than serving figures it
            cannot verify.
          </p>
        </main>
        <SiteFooter />
      </>
    );
  }

  return (
    <>
      <SiteHeader />

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-14">
        <div className="max-w-2xl">
          <Eyebrow>Explorer · every asset on the chain</Eyebrow>
          <Display as="h1" className="mt-4 text-[clamp(2.25rem,4.5vw,3.25rem)]">
            What actually trades here
          </Display>
          <p className="mt-5 text-[15px] leading-relaxed text-ink-soft">
            Robinhood Chain was built for tokenised equities, but equities are not what moves on it.
            This is the whole chain — stablecoins, memecoins and stock tokens together, ranked by
            real activity.
          </p>
        </div>

        <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            tone="accent"
            label="Stock tokens' share of volume"
            value={`${stockShare.toFixed(1)}%`}
            detail="Of the top 50 tokens by 24h volume"
          />
          <StatTile
            label="24h volume, top 50"
            value={usd(totalVolume, { compact: true })}
            detail="Aggregated across every pool"
          />
          <StatTile
            label="Liquidity, top 20"
            value={usd(totalLiquidity, { compact: true })}
            detail="Deepest venues on the chain"
          />
          <StatTile
            label="Stock tokens tracked"
            value={count(stockSymbols.size)}
            detail="ERC-8056 confirmed on-chain"
          />
        </div>

        <section className="mt-12">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <Eyebrow>Ranked by 24h volume</Eyebrow>
              <p className="mt-2 max-w-xl text-[14px] leading-relaxed text-ink-muted">
                Volume far above liquidity is worth noticing: it means the same shallow pool is being
                traded repeatedly, not that there is depth behind the number.
              </p>
            </div>
            <Link href="/market" className="link-underline text-[14px] text-ink-soft">
              Stock tokens only →
            </Link>
          </div>

          <div className="mt-6 overflow-hidden rounded-xl border border-line bg-paper">
            <div className="hidden grid-cols-[2.5rem_minmax(8rem,1.3fr)_repeat(5,minmax(5rem,1fr))] gap-4 border-b border-line bg-paper-edge/60 px-5 py-3 lg:grid">
              {["#", "Token", "Price", "24h", "Volume 24h", "Liquidity", "Holders"].map((h) => (
                <p key={h} className="eyebrow">
                  {h}
                </p>
              ))}
            </div>

            {byVolume.tokens.map((t, i) => {
              const isStock = stockSymbols.has(t.symbol.toUpperCase());
              // Turnover far above 1 signals churn in a thin pool.
              const turnover =
                t.liquidityUsd && t.liquidityUsd > 0 && t.volume24Usd
                  ? t.volume24Usd / t.liquidityUsd
                  : null;

              return (
                <div
                  key={`${t.address}-${i}`}
                  className={`grid grid-cols-2 gap-4 px-5 py-3.5 transition-colors hover:bg-cream/60 lg:grid-cols-[2.5rem_minmax(8rem,1.3fr)_repeat(5,minmax(5rem,1fr))] lg:items-center ${
                    i > 0 ? "border-t border-line-soft" : ""
                  }`}
                >
                  <p className="tnum hidden text-[12px] text-ink-faint lg:block">{i + 1}</p>

                  <div className="col-span-2 lg:col-span-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-[14px] font-medium text-ink">{t.symbol}</span>
                      {isStock && (
                        <span className="rounded-full border border-ink-muted px-1.5 py-0.5 text-[10px] text-ink-soft">
                          stock
                        </span>
                      )}
                    </div>
                    <p className="truncate text-[11px] text-ink-muted">{t.name}</p>
                  </div>

                  <Cell label="Price">{usd(t.priceUsd)}</Cell>

                  <div>
                    <p className="eyebrow lg:hidden">24h</p>
                    <p className="tnum text-[13px] text-ink">{signedPct(t.change24Pct, 2)}</p>
                  </div>

                  <Cell label="Volume 24h">{compact(t.volume24Usd)}</Cell>

                  <div>
                    <p className="eyebrow lg:hidden">Liquidity</p>
                    <p className="tnum text-[13px] text-ink-soft">{compact(t.liquidityUsd)}</p>
                    {turnover !== null && turnover > 50 && (
                      <p className="text-[10px] text-ink-faint">{turnover.toFixed(0)}× turnover</p>
                    )}
                  </div>

                  <Cell label="Holders">{compact(t.holders)}</Cell>
                </div>
              );
            })}
          </div>
        </section>

        <p className="mt-10 rounded-lg border border-line bg-paper-edge/50 px-5 py-4 text-[13px] leading-relaxed text-ink-muted">
          Indexed by Codex across every pool on the chain, which is why liquidity here exceeds what a
          single-pool source reports. Ranked live. Listing an asset is not an endorsement of it —
          several entries below are memecoins with negligible depth.
        </p>
      </main>

      <SiteFooter />
    </>
  );
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="eyebrow lg:hidden">{label}</p>
      <p className="tnum text-[13px] text-ink-soft">{children}</p>
    </div>
  );
}
