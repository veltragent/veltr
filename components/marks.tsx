/**
 * Brand marks, drawn inline.
 *
 * Inline SVG rather than an icon package or a hosted asset: three glyphs do not
 * justify a dependency, and a remote image would be a third-party request on
 * every page load for something that never changes.
 *
 * Each inherits `currentColor`, so they take the colour of whatever they sit in
 * and follow its hover state without a second rule.
 */

type MarkProps = { className?: string };

const BASE = "h-[18px] w-[18px]";

export function TelegramMark({ className = "" }: MarkProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={`${BASE} ${className}`}>
      <path d="M21.94 4.3 18.9 19.1c-.23 1.02-.84 1.27-1.7.79l-4.7-3.47-2.27 2.19c-.25.25-.46.46-.95.46l.34-4.8 8.73-7.9c.38-.34-.08-.53-.59-.19L6.98 13.1 2.34 11.6c-1-.32-1.02-1 .21-1.49l18.15-7c.84-.31 1.57.2 1.24 1.19Z" />
    </svg>
  );
}

export function GithubMark({ className = "" }: MarkProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={`${BASE} ${className}`}>
      <path d="M12 .5C5.73.5.5 5.73.5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-2.1c-3.2.7-3.88-1.37-3.88-1.37-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.2 1.77 1.2 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.56-.29-5.25-1.28-5.25-5.7 0-1.26.45-2.29 1.19-3.1-.12-.3-.52-1.47.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.79 0c2.2-1.5 3.17-1.18 3.17-1.18.63 1.58.24 2.75.12 3.04.74.82 1.18 1.85 1.18 3.11 0 4.43-2.69 5.41-5.26 5.7.41.35.78 1.05.78 2.12v3.14c0 .31.2.67.8.55A11.5 11.5 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5Z" />
    </svg>
  );
}

export function XMark({ className = "" }: MarkProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={`${BASE} ${className}`}>
      <path d="M18.24 2.25h3.31l-7.23 8.26 8.5 11.24h-6.65l-5.22-6.82-5.96 6.82H1.68l7.73-8.84L1.25 2.25h6.82l4.71 6.23 5.46-6.23Zm-1.16 17.52h1.83L7.01 4.13H5.05l12.03 15.64Z" />
    </svg>
  );
}
