"use client";

import { useState } from "react";
import { isAddress } from "viem";
import { TokenMark } from "./primitives";
import { explorerAddressUrl } from "@/lib/blockscout";
import { count, multiplier as fmtMultiplier, usd } from "@/lib/format";

type Position = {
  symbol: string;
  name: string;
  address: string;
  iconUrl: string | null;
  priceUsd: number | null;
  multiplier: number;
  rawBalance: number;
  effectiveBalance: number;
  unreportedShares: number;
  unreportedUsd: number | null;
  valueUsd: number | null;
};

type Result = {
  address: string;
  positions: Position[];
  summary: {
    positionCount: number;
    portfolioUsd: number;
    misreportedCount: number;
    unreportedUsd: number;
    pendingActions: number;
  };
};

export function ExposureAudit({ exampleAddress }: { exampleAddress: string | null }) {
  const [input, setInput] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function audit(address: string) {
    if (!isAddress(address)) {
      setError("That is not a valid EVM address.");
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch(`/api/wallet?address=${address}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Audit failed.");
      setResult(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Audit failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          audit(input.trim());
        }}
        className="flex flex-wrap gap-2"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="0x…"
          spellCheck={false}
          className="tnum min-w-[18rem] flex-1 rounded-lg border border-line bg-paper px-4 py-3 text-[14px] text-ink outline-none transition-colors placeholder:font-sans placeholder:text-ink-faint focus:border-accent"
        />
        <button
          type="submit"
          disabled={loading}
          className="rounded-lg bg-accent px-6 py-3 text-[14px] font-medium text-paper transition-colors hover:bg-accent-deep disabled:opacity-40"
        >
          {loading ? "Reading chain…" : "Audit"}
        </button>
      </form>

      {exampleAddress && (
        <button
          onClick={() => {
            setInput(exampleAddress);
            audit(exampleAddress);
          }}
          disabled={loading}
          className="mt-3 text-[13px] text-ink-muted transition-colors hover:text-accent disabled:opacity-40"
        >
          Try a real holder of a token with an applied multiplier →
        </button>
      )}

      {error && (
        <p className="mt-5 rounded-lg border border-alert/20 bg-alert-tint px-4 py-3 text-[13px] text-alert">
          {error}
        </p>
      )}

      {result && (
        <div className="mt-10">
          {result.positions.length === 0 ? (
            <div className="rounded-xl border border-line bg-paper px-6 py-14 text-center">
              <p className="text-[15px] text-ink-soft">
                This address holds no stock tokens on Robinhood Chain.
              </p>
              <a
                href={explorerAddressUrl(result.address)}
                target="_blank"
                rel="noreferrer"
                className="link-underline mt-3 inline-block text-[13px] text-ink-muted"
              >
                View on Blockscout
              </a>
            </div>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-xl border border-line bg-paper p-5">
                  <p className="eyebrow">Portfolio value</p>
                  <p className="tnum mt-3 text-[1.6rem] leading-none text-ink">
                    {usd(result.summary.portfolioUsd, { compact: true })}
                  </p>
                  <p className="mt-2 text-[13px] text-ink-muted">
                    {count(result.summary.positionCount)} stock token positions
                  </p>
                </div>

                <div
                  className={`rounded-xl p-5 ${
                    result.summary.misreportedCount > 0 ? "bg-accent" : "border border-line bg-paper"
                  }`}
                >
                  <p
                    className={`eyebrow ${result.summary.misreportedCount > 0 ? "!text-accent-tint/75" : ""}`}
                  >
                    Positions misreported
                  </p>
                  <p
                    className={`tnum mt-3 text-[1.6rem] leading-none ${
                      result.summary.misreportedCount > 0 ? "text-paper" : "text-ink"
                    }`}
                  >
                    {count(result.summary.misreportedCount)}
                  </p>
                  <p
                    className={`mt-2 text-[13px] ${
                      result.summary.misreportedCount > 0 ? "text-accent-tint/80" : "text-ink-muted"
                    }`}
                  >
                    Raw balance disagrees with true exposure
                  </p>
                </div>

                <div className="rounded-xl border border-line bg-paper p-5">
                  <p className="eyebrow">Unaccounted value</p>
                  <p className="tnum mt-3 text-[1.6rem] leading-none text-accent-deep">
                    {usd(result.summary.unreportedUsd)}
                  </p>
                  <p className="mt-2 text-[13px] text-ink-muted">
                    Exposure a raw-balance reader would omit
                  </p>
                </div>
              </div>

              <div className="mt-6 overflow-hidden rounded-xl border border-line bg-paper">
                <div className="hidden grid-cols-[minmax(10rem,1.4fr)_repeat(5,minmax(6rem,1fr))] gap-4 border-b border-line bg-paper-edge/60 px-5 py-3 lg:grid">
                  {["Token", "balanceOf", "uiMultiplier", "True exposure", "Unaccounted", "Value"].map((h) => (
                    <p key={h} className="eyebrow">
                      {h}
                    </p>
                  ))}
                </div>

                {result.positions.map((p, i) => {
                  const off = Math.abs(p.unreportedShares) > 1e-12;
                  return (
                    <div
                      key={p.address}
                      className={`grid grid-cols-2 gap-4 px-5 py-4 lg:grid-cols-[minmax(10rem,1.4fr)_repeat(5,minmax(6rem,1fr))] lg:items-center ${
                        i > 0 ? "border-t border-line-soft" : ""
                      }`}
                    >
                      <div className="col-span-2 flex items-center gap-3 lg:col-span-1">
                        <TokenMark iconUrl={p.iconUrl} symbol={p.symbol} size={28} />
                        <div className="min-w-0">
                          <p className="text-[14px] font-medium text-ink">{p.symbol}</p>
                          <p className="truncate text-[12px] text-ink-muted">{p.name}</p>
                        </div>
                      </div>

                      <Field label="balanceOf">{p.rawBalance.toFixed(6)}</Field>
                      <Field label="uiMultiplier">{fmtMultiplier(p.multiplier)}</Field>
                      <Field label="True exposure" strong>
                        {p.effectiveBalance.toFixed(6)}
                      </Field>

                      <div>
                        <p className="eyebrow lg:hidden">Unaccounted</p>
                        <p className={`tnum text-[13px] ${off ? "text-accent-deep" : "text-ink-faint"}`}>
                          {off ? `${p.unreportedShares > 0 ? "+" : "−"}${Math.abs(p.unreportedShares).toFixed(6)}` : "—"}
                        </p>
                        {off && p.unreportedUsd !== null && (
                          <p className="tnum text-[11px] text-ink-faint">{usd(p.unreportedUsd)}</p>
                        )}
                      </div>

                      <Field label="Value">{usd(p.valueUsd, { compact: true })}</Field>
                    </div>
                  );
                })}
              </div>

              <p className="mt-5 text-[13px] leading-relaxed text-ink-muted">
                True exposure is read from{" "}
                <code className="tnum text-accent-deep">balanceOfUI()</code> on each token contract and
                cross-checked against{" "}
                <code className="tnum text-accent-deep">rawBalance × uiMultiplier ÷ 1e18</code>. Use
                these figures — not the raw balance — when sizing collateral or preparing a tax
                report.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, children, strong }: { label: string; children: React.ReactNode; strong?: boolean }) {
  return (
    <div>
      <p className="eyebrow lg:hidden">{label}</p>
      <p className={`tnum text-[13px] ${strong ? "font-medium text-ink" : "text-ink-soft"}`}>{children}</p>
    </div>
  );
}
