import Image from "next/image";
import type { Severity } from "@/lib/tokens";

export function Eyebrow({ children }: { children: React.ReactNode }) {
  return <p className="eyebrow">{children}</p>;
}

/** Section heading: editorial serif, tight tracking, generous leading. */
export function Display({
  children,
  className = "",
  as: Tag = "h2",
}: {
  children: React.ReactNode;
  className?: string;
  as?: "h1" | "h2" | "h3";
}) {
  return (
    <Tag
      className={`font-[family-name:var(--font-display)] tracking-[-0.02em] leading-[1.05] text-ink ${className}`}
    >
      {children}
    </Tag>
  );
}

/**
 * Monochrome severity scale. With no hue available, rank is carried by fill:
 * solid ink reads loudest, outlined sits mid, faint recedes.
 */
const SEVERITY_STYLES: Record<Severity, { label: string; className: string }> = {
  scheduled: {
    label: "Action scheduled",
    className: "bg-ink text-paper border-ink",
  },
  drifted: {
    label: "Balance misreported",
    className: "bg-paper text-ink border-ink-muted",
  },
  clear: {
    label: "Clear",
    className: "bg-cream-deep/60 text-ink-faint border-line",
  },
};

export function SeverityBadge({ severity, className = "" }: { severity: Severity; className?: string }) {
  const s = SEVERITY_STYLES[severity];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium whitespace-nowrap ${s.className} ${className}`}
    >
      <span className="size-1.5 rounded-full bg-current opacity-70" />
      {s.label}
    </span>
  );
}

export function TokenMark({
  iconUrl,
  symbol,
  size = 32,
}: {
  iconUrl: string | null;
  symbol: string;
  size?: number;
}) {
  if (!iconUrl) {
    return (
      <div
        style={{ width: size, height: size }}
        className="flex shrink-0 items-center justify-center rounded-full bg-cream-deep text-[10px] font-semibold text-ink-muted"
      >
        {symbol.slice(0, 3)}
      </div>
    );
  }
  return (
    <Image
      src={iconUrl}
      alt=""
      width={size}
      height={size}
      className="shrink-0 rounded-full bg-cream-deep ring-1 ring-line-soft"
      unoptimized
    />
  );
}

/** Metric tile. `tone="accent"` renders the orange accent block. */
export function StatTile({
  label,
  value,
  detail,
  tone = "paper",
}: {
  label: string;
  value: React.ReactNode;
  detail?: React.ReactNode;
  tone?: "paper" | "accent";
}) {
  const isFlame = tone === "accent";
  return (
    <div
      className={`flex flex-col justify-between gap-6 rounded-xl p-5 ${
        isFlame ? "bg-accent" : "border border-line bg-paper"
      }`}
    >
      <p
        className={`text-[11px] font-medium uppercase tracking-[0.14em] ${
          isFlame ? "text-accent-tint/75" : "text-ink-muted"
        }`}
      >
        {label}
      </p>
      <div>
        <p
          className={`tnum text-[1.75rem] leading-none font-medium ${
            isFlame ? "text-paper" : "text-ink"
          }`}
        >
          {value}
        </p>
        {detail && (
          <p className={`mt-2 text-[13px] leading-snug ${isFlame ? "text-accent-tint/80" : "text-ink-muted"}`}>
            {detail}
          </p>
        )}
      </div>
    </div>
  );
}
