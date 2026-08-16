import Link from "next/link";
import { GithubMark, TelegramMark, XMark } from "./marks";

export const GITHUB_URL = "https://github.com/veltragent/veltr";
export const X_URL = "https://x.com/veltragent";
export const TELEGRAM_URL = "https://t.me/veltragent_bot";

function Wordmark() {
  return (
    <Link href="/" className="group flex shrink-0 items-baseline gap-2">
      <span className="font-[family-name:var(--font-display)] text-[1.6rem] leading-none tracking-[-0.03em] text-ink">
        Veltr Agent
      </span>
    </Link>
  );
}

const NAV = [
  { href: "/docs", label: "Docs" },
  { href: "/market", label: "Market" },
  { href: "/explorer", label: "Explorer" },
  { href: "/radar", label: "Radar" },
  { href: "/history", label: "History" },
  { href: "/exposure", label: "Exposure" },
  { href: "/alerts", label: "Alerts" },
  { href: "/autonomous", label: "Autonomous" },
  { href: "/method", label: "Method" },
];

/**
 * Site header.
 *
 * The nav scrolls inside itself rather than widening the page. Before this it
 * was a plain flex row of nine links, which on a phone is about three hundred
 * pixels wider than the viewport — and because flex items do not shrink below
 * their text, that width propagated to the document. The browser then zoomed
 * out to fit, which is why every page rendered squeezed into two thirds of the
 * screen with the text pushed off the left edge.
 *
 * `min-w-0` is the load-bearing class: a flex child defaults to `min-width:
 * auto`, so without it the nav still refuses to be narrower than its contents
 * and `overflow-x-auto` never engages.
 *
 * No menu button, no JavaScript, no open/closed state to get stuck: on a
 * client-side navigation the DOM persists, so a disclosure menu would stay open
 * behind the page you just moved to.
 */
export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-cream/85 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-6">
        <Wordmark />
        <nav className="scrollbar-none flex min-w-0 flex-1 items-center gap-1 overflow-x-auto md:justify-end">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="shrink-0 rounded-lg px-3 py-1.5 text-[13px] font-medium text-ink-soft transition-colors hover:bg-cream-deep hover:text-ink"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}

/** Where to find the project, and the bot. */
function SocialLinks({ className = "" }: { className?: string }) {
  const items = [
    { href: TELEGRAM_URL, label: "Telegram", mark: <TelegramMark /> },
    { href: GITHUB_URL, label: "GitHub", mark: <GithubMark /> },
    { href: X_URL, label: "X", mark: <XMark /> },
  ];

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      {items.map((item) => (
        <a
          key={item.label}
          href={item.href}
          target="_blank"
          rel="noreferrer"
          aria-label={item.label}
          title={item.label}
          className="flex h-9 w-9 items-center justify-center rounded-lg border border-line text-ink-soft transition-colors hover:border-ink hover:text-ink"
        >
          {item.mark}
        </a>
      ))}
    </div>
  );
}

export function SiteFooter() {
  return (
    <footer className="mt-auto border-t border-line">
      <div className="mx-auto max-w-6xl px-6 py-10">
        <div className="flex flex-col gap-8 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-md">
            <p className="font-[family-name:var(--font-display)] text-lg tracking-[-0.02em] text-ink">
              Veltr Agent
            </p>
            <p className="mt-2 text-[13px] leading-relaxed text-ink-muted">
              An autonomous analyst for Robinhood Chain. Every number here was read from mainnet or a
              named market source at the time shown — nothing is estimated. Informational tooling
              only, not investment, tax, or legal advice.
            </p>
            <SocialLinks className="mt-5" />
          </div>

          <div className="flex gap-10 text-[13px]">
            <div className="flex flex-col gap-2">
              <p className="eyebrow">Product</p>
              <Link className="link-underline text-ink-soft" href="/docs">
                Documentation
              </Link>
              <a className="link-underline text-ink-soft" href={TELEGRAM_URL} target="_blank" rel="noreferrer">
                Telegram bot
              </a>
              <Link className="link-underline text-ink-soft" href="/method">
                Method
              </Link>
            </div>
            <div className="flex flex-col gap-2">
              <p className="eyebrow">Data</p>
              <a
                className="link-underline text-ink-soft"
                href="https://robinhoodchain.blockscout.com"
                target="_blank"
                rel="noreferrer"
              >
                Blockscout
              </a>
              <a
                className="link-underline text-ink-soft"
                href="https://docs.robinhood.com/chain/"
                target="_blank"
                rel="noreferrer"
              >
                Chain docs
              </a>
              <a className="link-underline text-ink-soft" href={GITHUB_URL} target="_blank" rel="noreferrer">
                Source
              </a>
            </div>
          </div>
        </div>

        <p className="mt-8 border-t border-line-soft pt-6 text-[12px] text-ink-faint">
          Stock tokens on Robinhood Chain are debt securities, not equity. Holders receive no
          shareholder rights. · Built on Robinhood Chain.
        </p>
      </div>
    </footer>
  );
}
