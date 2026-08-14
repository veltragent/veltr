import Link from "next/link";

function Wordmark() {
  return (
    <Link href="/" className="group flex items-baseline gap-2">
      <span className="font-[family-name:var(--font-display)] text-[1.6rem] leading-none tracking-[-0.03em] text-ink">
        Veltr Agent
      </span>
      <span className="hidden text-[11px] font-medium uppercase tracking-[0.16em] text-ink-faint transition-colors group-hover:text-accent sm:inline">
        Chain 4663
      </span>
    </Link>
  );
}

const NAV = [
  { href: "/market", label: "Market" },
  { href: "/explorer", label: "Explorer" },
  { href: "/radar", label: "Radar" },
  { href: "/history", label: "History" },
  { href: "/exposure", label: "Exposure" },
  { href: "/alerts", label: "Alerts" },
  { href: "/autonomous", label: "Autonomous" },
  { href: "/method", label: "Method" },
];

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-cream/85 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-6 px-6">
        <Wordmark />
        <nav className="flex items-center gap-1">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-lg px-3 py-1.5 text-[13px] font-medium text-ink-soft transition-colors hover:bg-cream-deep hover:text-ink"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="mt-auto border-t border-line">
      <div className="mx-auto max-w-6xl px-6 py-10">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-md">
            <p className="font-[family-name:var(--font-display)] text-lg tracking-[-0.02em] text-ink">
              Veltr Agent
            </p>
            <p className="mt-2 text-[13px] leading-relaxed text-ink-muted">
              An autonomous analyst for Robinhood Chain. Every number here was read from mainnet or a
              named market source at the time shown — nothing is estimated. Informational tooling
              only, not investment, tax, or legal advice.
            </p>
          </div>
          <div className="flex gap-10 text-[13px]">
            <div className="flex flex-col gap-2">
              <p className="eyebrow">Data</p>
              <a className="link-underline text-ink-soft" href="https://robinhoodchain.blockscout.com" target="_blank" rel="noreferrer">
                Blockscout
              </a>
              <a className="link-underline text-ink-soft" href="https://docs.robinhood.com/chain/" target="_blank" rel="noreferrer">
                Chain docs
              </a>
            </div>
            <div className="flex flex-col gap-2">
              <p className="eyebrow">Chain</p>
              <span className="tnum text-ink-soft">ID 4663</span>
              <span className="text-ink-soft">Arbitrum Orbit</span>
            </div>
          </div>
        </div>
        <p className="mt-8 border-t border-line-soft pt-6 text-[12px] text-ink-faint">
          Stock tokens on Robinhood Chain are debt securities, not equity. Holders receive no
          shareholder rights.
        </p>
      </div>
    </footer>
  );
}
