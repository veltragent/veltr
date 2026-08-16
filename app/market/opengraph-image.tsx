import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { buildPremiumWall } from "@/lib/premium-wall";
import { MAX_PREMIUM_PCT } from "@/lib/watch/settings";

/**
 * The card a shared market link renders as.
 *
 * The site already declared `twitter:card: summary_large_image` and shipped no
 * image, so every link posted anywhere rendered a large empty card — a promise
 * made in metadata and not kept.
 *
 * It is generated rather than static because the interesting thing about this
 * page is a number that moves. A card that says "NVDA is trading 3.6% below the
 * share right now" is a reason to open the link; a logo is not.
 */

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "Every tokenised stock on Robinhood Chain, priced against the real share";

/**
 * Regenerated at most once a minute, matching the page it represents.
 *
 * Crawlers refetch this far more often than a person loads the page, and the
 * underlying wall is cached anyway — this keeps a burst of shares from turning
 * into a burst of chain reads.
 */
export const revalidate = 60;

const INK = "#1f1a14";
const PAPER = "#faf6ee";
const SOFT = "#8b7c68";
const RULE = "#e3d7c1";

/**
 * Turnover below which a price is a quote rather than a market.
 *
 * A token that has not traded meaningfully in a day can show any premium at
 * all; the number is real but it describes nothing anyone could act on.
 */
const MIN_CREDIBLE_VOLUME_USD = 5_000;

/** Read from disk and embedded: ImageResponse has no origin to resolve a path against. */
const markDataUri = `data:image/png;base64,${readFileSync(
  join(process.cwd(), "public/logo-mark.png")
).toString("base64")}`;

function pct(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(2)}%`;
}

export default async function Image() {
  const wall = await buildPremiumWall().catch(() => null);

  /**
   * Widest first — but only among spreads that mean something.
   *
   * Sorting the raw rows by dislocation put CRWD at +291% on this card. That is
   * not a premium; at that distance it is a thin pool, a stale quote or the
   * wrong instrument, and the alert thresholds already refuse to believe
   * anything past MAX_PREMIUM_PCT for exactly that reason.
   *
   * On the page a number like that sits beside liquidity and volume, and a
   * reader can discount it. On a card shared into a group chat there is no such
   * context — it is the only thing anyone sees, and it makes the product look
   * broken while claiming a spread nobody could trade. So the same rule applies
   * here, plus a floor on turnover: a price with no volume behind it is a quote,
   * not a market.
   */
  const rows = (wall?.rows ?? [])
    .filter(
      (r) =>
        r.premiumPct !== null &&
        Math.abs(r.premiumPct) <= MAX_PREMIUM_PCT &&
        (r.volume24hUsd ?? 0) >= MIN_CREDIBLE_VOLUME_USD
    )
    .sort((a, b) => Math.abs(b.premiumPct ?? 0) - Math.abs(a.premiumPct ?? 0))
    .slice(0, 4);

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: PAPER,
          color: INK,
          padding: "64px 72px",
          fontFamily: "Georgia, serif",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column" }}>
          {/* The same lockup as the homepage card and the site header. */}
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={markDataUri} alt="" width={34} height={37} />
            <span style={{ fontSize: 27, letterSpacing: "-0.02em", color: INK }}>Veltr Agent</span>
            <span style={{ fontSize: 20, color: SOFT }}>· Robinhood Chain</span>
          </div>
          <div style={{ fontSize: 56, marginTop: 14, lineHeight: 1.05, maxWidth: 760 }}>
            Two prices for the same company
          </div>
        </div>

        {rows.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 14, margin: "28px 0" }}>
            {rows.map((r) => (
              <div
                key={r.symbol}
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  borderTop: `1px solid ${RULE}`,
                  paddingTop: 10,
                  fontSize: 34,
                }}
              >
                <div style={{ display: "flex", fontFamily: "monospace" }}>{r.symbol}</div>
                <div style={{ display: "flex", color: SOFT, fontSize: 26 }}>
                  ${(r.tokenPriceUsd ?? 0).toFixed(2)} vs ${(r.equityPriceUsd ?? 0).toFixed(2)}
                </div>
                <div style={{ display: "flex", fontFamily: "monospace" }}>{pct(r.premiumPct)}</div>
              </div>
            ))}
          </div>
        ) : (
          // Never a fabricated number: if the sources are down the card says so.
          <div style={{ display: "flex", fontSize: 30, color: SOFT }}>
            Live premiums are unavailable right now.
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 24, color: SOFT }}>
          <div style={{ display: "flex" }}>veltragent.com/market</div>
          <div style={{ display: "flex" }}>
            {wall?.marketOpen ? "US market open · live spread" : "US market closed · drift since the bell"}
          </div>
        </div>
      </div>
    ),
    size
  );
}
