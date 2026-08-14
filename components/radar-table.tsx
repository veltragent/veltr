"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { Severity, StockToken } from "@/lib/tokens";
import { SeverityBadge, TokenMark } from "./primitives";
import { explorerTokenUrl } from "@/lib/blockscout";
import { count, multiplier as fmtMultiplier, signedPct, usd, compact, shortAddress } from "@/lib/format";

type Filter = "all" | "active" | Severity;

const FILTERS: { id: Filter; label: string }[] = [
  { id: "active", label: "Active state" },
  { id: "scheduled", label: "Scheduled" },
  { id: "drifted", label: "Misreported" },
  { id: "all", label: "All tokens" },
];

type SortKey = "risk" | "holders" | "value" | "symbol";

export function RadarTable({ tokens }: { tokens: StockToken[] }) {
  const [filter, setFilter] = useState<Filter>("active");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("risk");

  const counts = useMemo(
    () => ({
      all: tokens.length,
      active: tokens.filter((t) => t.severity !== "clear").length,
      scheduled: tokens.filter((t) => t.severity === "scheduled").length,
      drifted: tokens.filter((t) => t.severity === "drifted").length,
      clear: tokens.filter((t) => t.severity === "clear").length,
    }),
    [tokens]
  );

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();

    const filtered = tokens.filter((t) => {
      if (filter === "active" && t.severity === "clear") return false;
      if (filter !== "all" && filter !== "active" && t.severity !== filter) return false;
      if (!q) return true;
      return (
        t.symbol.toLowerCase().includes(q) ||
        t.name.toLowerCase().includes(q) ||
        t.address.toLowerCase().includes(q)
      );
    });

    const sorted = [...filtered];
    sorted.sort((a, b) => {
      switch (sort) {
        case "holders":
          return b.holders - a.holders;
        case "value":
          return (b.marketCap ?? 0) - (a.marketCap ?? 0);
        case "symbol":
          return a.symbol.localeCompare(b.symbol);
        default:
          return b.riskScore - a.riskScore || b.holders - a.holders;
      }
    });
    return sorted;
  }, [tokens, filter, query, sort]);

  return (
    <div>
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap gap-1 rounded-lg border border-line bg-paper p-1">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors ${
                filter === f.id ? "bg-accent text-paper" : "text-ink-soft hover:bg-cream-deep"
              }`}
            >
              {f.label}
              <span className={`tnum ml-1.5 text-[11px] ${filter === f.id ? "text-accent-tint/75" : "text-ink-faint"}`}>
                {counts[f.id]}
              </span>
            </button>
          ))}
        </div>

        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search ticker, name or address"
          className="min-w-[15rem] flex-1 rounded-lg border border-line bg-paper px-3.5 py-2 text-[14px] text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-accent"
        />

        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          className="rounded-lg border border-line bg-paper px-3 py-2 text-[13px] text-ink-soft outline-none focus:border-accent"
        >
          <option value="risk">Sort: risk</option>
          <option value="holders">Sort: holders</option>
          <option value="value">Sort: market cap</option>
          <option value="symbol">Sort: ticker</option>
        </select>
      </div>

      {/* Table */}
      <div className="mt-5 overflow-hidden rounded-xl border border-line bg-paper">
        <div className="hidden grid-cols-[minmax(11rem,1.6fr)_repeat(5,minmax(5.5rem,1fr))_10rem] gap-4 border-b border-line bg-paper-edge/60 px-5 py-3 lg:grid">
          {["Token", "Price", "uiMultiplier", "Reporting error", "Holders", "Market cap", "Status"].map((h) => (
            <p key={h} className="eyebrow">
              {h}
            </p>
          ))}
        </div>

        {rows.length === 0 && (
          <p className="px-5 py-14 text-center text-[14px] text-ink-muted">
            No tokens match this filter.
          </p>
        )}

        {rows.map((t, i) => (
          <div
            key={t.address}
            id={t.symbol}
            className={`grid grid-cols-2 gap-4 px-5 py-4 transition-colors hover:bg-cream/60 lg:grid-cols-[minmax(11rem,1.6fr)_repeat(5,minmax(5.5rem,1fr))_10rem] lg:items-center ${
              i > 0 ? "border-t border-line-soft" : ""
            }`}
          >
            {/* Token */}
            <div className="col-span-2 flex items-center gap-3 lg:col-span-1">
              <TokenMark iconUrl={t.iconUrl} symbol={t.symbol} />
              <div className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <Link
                    href={`/token/${t.address}`}
                    className="text-[14px] font-medium text-ink underline decoration-transparent underline-offset-2 transition-colors hover:decoration-ink-muted"
                  >
                    {t.symbol}
                  </Link>
                  <a
                    href={explorerTokenUrl(t.address)}
                    target="_blank"
                    rel="noreferrer"
                    className="tnum text-[11px] text-ink-faint transition-colors hover:text-accent"
                  >
                    {shortAddress(t.address)}
                  </a>
                </div>
                <p className="truncate text-[12px] text-ink-muted">{t.name}</p>
              </div>
            </div>

            <Cell label="Price">{usd(t.priceUsd)}</Cell>
            <Cell label="uiMultiplier" mono>
              {fmtMultiplier(t.multiplier)}
            </Cell>

            <div>
              <p className="eyebrow lg:hidden">Reporting error</p>
              <p
                className={`tnum text-[13px] ${
                  Math.abs(t.reportingErrorPct) > 1e-9 ? "text-accent-deep" : "text-ink-faint"
                }`}
              >
                {signedPct(t.reportingErrorPct)}
              </p>
            </div>

            <Cell label="Holders">{count(t.holders)}</Cell>
            <Cell label="Market cap">{compact(t.marketCap)}</Cell>

            <div className="col-span-2 lg:col-span-1">
              <SeverityBadge severity={t.severity} />
              {t.severity === "scheduled" && t.actionDeltaPct !== null && (
                <p className="tnum mt-1.5 text-[11px] text-alert">
                  → {fmtMultiplier(t.pendingMultiplier!)} ({signedPct(t.actionDeltaPct)})
                  {t.hoursUntilEffective !== null && ` · ${t.hoursUntilEffective.toFixed(1)}h`}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Cell({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div>
      <p className="eyebrow lg:hidden">{label}</p>
      <p className={`text-[13px] text-ink-soft ${mono !== false ? "tnum" : ""}`}>{children}</p>
    </div>
  );
}
