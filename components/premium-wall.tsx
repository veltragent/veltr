"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { TokenMark } from "./primitives";
import type { WallRow } from "@/lib/premium-wall";
import { compact, signedPct, usd } from "@/lib/format";

type Sort = "dislocation" | "premium" | "holders" | "volume" | "symbol";

/**
 * The premium wall.
 *
 * A bar sized by |premium| runs behind each row, so the shape of the
 * dislocation is legible without reading a single number — which is what makes
 * the page worth screenshotting.
 */
export function PremiumWall({ rows, marketOpen }: { rows: WallRow[]; marketOpen: boolean }) {
  const [sort, setSort] = useState<Sort>("dislocation");
  const [query, setQuery] = useState("");
  const [onlyPriced, setOnlyPriced] = useState(false);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = rows.filter((r) => {
      if (onlyPriced && r.premiumPct === null) return false;
      if (!q) return true;
      return r.symbol.toLowerCase().includes(q) || r.name.toLowerCase().includes(q);
    });

    const sorted = [...filtered];
    sorted.sort((a, b) => {
      switch (sort) {
        case "premium":
          return (b.premiumPct ?? -Infinity) - (a.premiumPct ?? -Infinity);
        case "holders":
          return b.holders - a.holders;
        case "volume":
          return (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0);
        case "symbol":
          return a.symbol.localeCompare(b.symbol);
        default: {
          if (a.premiumPct === null && b.premiumPct === null) return b.holders - a.holders;
          if (a.premiumPct === null) return 1;
          if (b.premiumPct === null) return -1;
          return Math.abs(b.premiumPct) - Math.abs(a.premiumPct);
        }
      }
    });
    return sorted;
  }, [rows, sort, query, onlyPriced]);

  // Bar scale is set by the widest row on screen, so the shape stays readable
  // whether the market is calm or dislocated.
  const maxAbs = useMemo(
    () => Math.max(0.05, ...visible.map((r) => Math.abs(r.premiumPct ?? 0))),
    [visible]
  );

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search ticker or company"
          className="min-w-[14rem] flex-1 rounded-lg border border-line bg-paper px-3.5 py-2 text-[14px] text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-accent"
        />
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as Sort)}
          className="rounded-lg border border-line bg-paper px-3 py-2 text-[13px] text-ink-soft outline-none focus:border-accent"
        >
          <option value="dislocation">Sort: widest dislocation</option>
          <option value="premium">Sort: premium high to low</option>
          <option value="holders">Sort: holders</option>
          <option value="volume">Sort: 24h volume</option>
          <option value="symbol">Sort: ticker</option>
        </select>
        <button
          onClick={() => setOnlyPriced((v) => !v)}
          className={`rounded-lg border px-3 py-2 text-[13px] font-medium transition-colors ${
            onlyPriced ? "border-ink bg-ink text-paper" : "border-line bg-paper text-ink-soft hover:bg-cream-deep"
          }`}
        >
          Priced only
        </button>
        <span className="tnum text-[12px] text-ink-faint">{visible.length} shown</span>
      </div>

      <div className="mt-5 overflow-hidden rounded-xl border border-line bg-paper">
        <div className="hidden grid-cols-[minmax(9rem,1.4fr)_repeat(4,minmax(5rem,1fr))_minmax(6rem,1.1fr)] gap-4 border-b border-line bg-paper-edge/60 px-5 py-3 lg:grid">
          {["Token", "On-chain", "Exchange", "Premium", "Holders", "Dislocation"].map((h) => (
            <p key={h} className="eyebrow">
              {h}
            </p>
          ))}
        </div>

        {visible.length === 0 && (
          <p className="px-5 py-14 text-center text-[14px] text-ink-muted">Nothing matches.</p>
        )}

        {visible.map((r, i) => {
          const width = r.premiumPct === null ? 0 : (Math.abs(r.premiumPct) / maxAbs) * 100;
          const above = (r.premiumPct ?? 0) >= 0;

          return (
            <div
              key={r.address}
              className={`relative grid grid-cols-2 gap-4 px-5 py-3.5 transition-colors hover:bg-cream/60 lg:grid-cols-[minmax(9rem,1.4fr)_repeat(4,minmax(5rem,1fr))_minmax(6rem,1.1fr)] lg:items-center ${
                i > 0 ? "border-t border-line-soft" : ""
              }`}
            >
              <div className="col-span-2 flex items-center gap-3 lg:col-span-1">
                <TokenMark iconUrl={r.iconUrl} symbol={r.symbol} size={26} />
                <div className="min-w-0">
                  <Link
                    href={`/token/${r.address}`}
                    className="text-[14px] font-medium text-ink underline decoration-transparent underline-offset-2 transition-colors hover:decoration-ink-muted"
                  >
                    {r.symbol}
                  </Link>
                  <p className="truncate text-[11px] text-ink-muted">{r.name}</p>
                </div>
              </div>

              <Cell label="On-chain">{usd(r.tokenPriceUsd)}</Cell>
              <Cell label="Exchange">{r.unlisted ? "not listed" : usd(r.equityPriceUsd)}</Cell>

              <div>
                <p className="eyebrow lg:hidden">Premium</p>
                <p className="tnum text-[13px] font-medium text-ink">
                  {r.premiumPct === null ? "—" : signedPct(r.premiumPct, 3)}
                </p>
              </div>

              <Cell label="Holders">{compact(r.holders)}</Cell>

              <div className="col-span-2 lg:col-span-1">
                <p className="eyebrow lg:hidden">Dislocation</p>
                <div className="mt-1 flex h-[18px] items-center gap-2 lg:mt-0">
                  <div className="relative h-[6px] flex-1 overflow-hidden rounded-full bg-cream-deep">
                    <div
                      className={`absolute inset-y-0 ${above ? "left-1/2" : "right-1/2"} rounded-full ${
                        above ? "bg-ink" : "bg-ink-muted"
                      }`}
                      style={{ width: `${Math.min(width / 2, 50)}%` }}
                    />
                    <div className="absolute inset-y-0 left-1/2 w-px bg-line-strong" />
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <p className="mt-4 text-[13px] leading-relaxed text-ink-muted">
        The centre line is parity. A bar to the right means the token trades above its underlying, to
        the left below.{" "}
        {marketOpen
          ? "The equity market is open, so both prices are live and each premium is a real spread."
          : "The equity market is shut, so the exchange column is the last close and each premium is drift accumulated since the bell — not a tradeable spread."}
      </p>
    </div>
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
