import type { Candle } from "@/lib/market";

/**
 * Candlestick chart as inline SVG.
 *
 * No charting library: this renders on the server inside a server component,
 * so the chart is in the first paint with no client bundle, no hydration and no
 * loading state. Financial charts are lines and rectangles — the dependency
 * would cost more than it saves.
 */
export function PriceChart({
  candles,
  height = 260,
  label,
}: {
  candles: Candle[];
  height?: number;
  label?: string;
}) {
  if (candles.length < 2) {
    return (
      <div className="flex h-[260px] items-center justify-center rounded-lg border border-line-soft bg-cream text-[13px] text-ink-muted">
        No price history available for this pool.
      </div>
    );
  }

  const width = 900;
  const padTop = 16;
  const padBottom = 28;
  const padRight = 56;
  const plotW = width - padRight;
  const plotH = height - padTop - padBottom;

  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  let max = Math.max(...highs);
  let min = Math.min(...lows);
  // A flat series would divide by zero; give it a visible band instead.
  if (max === min) {
    max += max * 0.001 || 1;
    min -= min * 0.001 || 1;
  }
  const pad = (max - min) * 0.08;
  max += pad;
  min -= pad;

  const x = (i: number) => (i / (candles.length - 1)) * (plotW - 12) + 6;
  const y = (v: number) => padTop + (1 - (v - min) / (max - min)) * plotH;

  const bodyW = Math.max(1.2, Math.min(9, (plotW / candles.length) * 0.62));

  const first = candles[0].close;
  const last = candles[candles.length - 1].close;
  const changePct = first > 0 ? (last / first - 1) * 100 : 0;

  const areaPath = [
    `M ${x(0)} ${y(candles[0].close)}`,
    ...candles.slice(1).map((c, i) => `L ${x(i + 1)} ${y(c.close)}`),
    `L ${x(candles.length - 1)} ${padTop + plotH}`,
    `L ${x(0)} ${padTop + plotH}`,
    "Z",
  ].join(" ");

  const gridLines = 4;
  const ticks = Array.from({ length: gridLines + 1 }, (_, i) => min + ((max - min) * i) / gridLines);

  const fmt = (v: number) => (v >= 1000 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toPrecision(4));

  return (
    <figure className="w-full">
      {label && (
        <figcaption className="mb-3 flex items-baseline justify-between gap-3">
          <span className="text-[13px] text-ink-muted">{label}</span>
          <span className="tnum text-[13px] text-ink">
            {changePct >= 0 ? "+" : "−"}
            {Math.abs(changePct).toFixed(2)}%
          </span>
        </figcaption>
      )}

      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="h-auto w-full min-w-[520px]"
          role="img"
          aria-label={label ?? "Price chart"}
        >
          {ticks.map((t, i) => (
            <g key={i}>
              <line
                x1={0}
                x2={plotW}
                y1={y(t)}
                y2={y(t)}
                stroke="var(--color-line-soft)"
                strokeWidth={1}
              />
              <text
                x={plotW + 8}
                y={y(t) + 4}
                fontSize={11}
                fill="var(--color-ink-faint)"
                fontFamily="var(--font-mono)"
              >
                {fmt(t)}
              </text>
            </g>
          ))}

          <path d={areaPath} fill="var(--color-ink)" opacity={0.05} />

          {candles.map((c, i) => {
            const up = c.close >= c.open;
            const cx = x(i);
            const top = y(Math.max(c.open, c.close));
            const bottom = y(Math.min(c.open, c.close));
            return (
              <g key={c.time}>
                <line
                  x1={cx}
                  x2={cx}
                  y1={y(c.high)}
                  y2={y(c.low)}
                  stroke="var(--color-ink-muted)"
                  strokeWidth={1}
                />
                {/* Hollow bodies rise, filled bodies fall — the monochrome
                    equivalent of green and red. */}
                <rect
                  x={cx - bodyW / 2}
                  y={top}
                  width={bodyW}
                  height={Math.max(1, bottom - top)}
                  fill={up ? "var(--color-paper)" : "var(--color-ink)"}
                  stroke="var(--color-ink)"
                  strokeWidth={1}
                />
              </g>
            );
          })}

          <text
            x={0}
            y={height - 8}
            fontSize={11}
            fill="var(--color-ink-faint)"
            fontFamily="var(--font-mono)"
          >
            {new Date(candles[0].time * 1000).toISOString().slice(0, 16).replace("T", " ")}
          </text>
          <text
            x={plotW}
            y={height - 8}
            fontSize={11}
            textAnchor="end"
            fill="var(--color-ink-faint)"
            fontFamily="var(--font-mono)"
          >
            {new Date(candles[candles.length - 1].time * 1000).toISOString().slice(0, 16).replace("T", " ")}
          </text>
        </svg>
      </div>
    </figure>
  );
}
