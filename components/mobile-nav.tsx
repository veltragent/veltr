"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * The menu on small screens.
 *
 * Replaces a nav that scrolled sideways. Scrolling worked, but it hid most of
 * the site behind a gesture nobody is told about — six of the nine sections
 * were off the edge of the screen with nothing to suggest they existed.
 *
 * Shown below `lg`, matching the header: the full row does not fit until 860px,
 * so tablets get this too.
 *
 * The reason this is a client component rather than a `<details>` element: on a
 * client-side navigation the App Router keeps the DOM, so a disclosure menu
 * stays open behind the page it just took you to. Closing has to be driven by
 * the route actually changing, which needs state.
 *
 * Both closing paths are needed. `usePathname` covers a normal navigation, and
 * the click handler covers tapping the page you are already on — where the
 * pathname never changes and the effect therefore never runs.
 */

export type NavItem = { href: string; label: string };

export function MobileNav({ items }: { items: NavItem[] }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  /**
   * Close when the route changes.
   *
   * Adjusted during render rather than in an effect. React re-runs this
   * component immediately with the corrected state and never commits the
   * intermediate one, so the menu is already closed on the first paint of the
   * new page — where an effect would paint it open and then shut it.
   */
  const [lastPath, setLastPath] = useState(pathname);
  if (pathname !== lastPath) {
    setLastPath(pathname);
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="lg:hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="mobile-nav"
        aria-label={open ? "Close menu" : "Open menu"}
        className="flex h-10 w-10 items-center justify-center rounded-lg border border-line text-ink transition-colors hover:bg-cream-deep"
      >
        {/*
          The three lines become a cross. Drawn with two spans that rotate and
          one that fades, so the control says which state it is in rather than
          showing the same icon either way.
        */}
        <span className="relative block h-[14px] w-[18px]">
          <span
            className={`absolute left-0 block h-[1.5px] w-full bg-current transition-transform duration-200 ${
              open ? "top-[6px] rotate-45" : "top-0"
            }`}
          />
          <span
            className={`absolute left-0 top-[6px] block h-[1.5px] w-full bg-current transition-opacity duration-200 ${
              open ? "opacity-0" : "opacity-100"
            }`}
          />
          <span
            className={`absolute left-0 block h-[1.5px] w-full bg-current transition-transform duration-200 ${
              open ? "top-[6px] -rotate-45" : "top-[12px]"
            }`}
          />
        </span>
      </button>

      {open && (
        <>
          {/*
            Catches the tap that means "not this". Sits under the panel and over
            the page, and is not announced — the button already carries the
            state, and Escape closes it for anyone not using a pointer.
          */}
          <button
            type="button"
            aria-hidden="true"
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className="fixed inset-0 top-16 z-30 cursor-default bg-ink/25"
          />

          <nav
            id="mobile-nav"
            className="absolute inset-x-0 top-16 z-40 border-b border-line bg-cream shadow-[0_18px_40px_-24px_rgba(31,26,20,0.45)]"
          >
            <ul className="mx-auto max-w-6xl px-4 py-3">
              {items.map((item) => {
                const active = pathname === item.href;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={() => setOpen(false)}
                      aria-current={active ? "page" : undefined}
                      className={`block rounded-lg px-3 py-3 text-[15px] font-medium transition-colors ${
                        active ? "bg-cream-deep text-ink" : "text-ink-soft hover:bg-cream-deep hover:text-ink"
                      }`}
                    >
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
        </>
      )}
    </div>
  );
}
