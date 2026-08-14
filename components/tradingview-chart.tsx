"use client";

import { useEffect, useRef } from "react";

/**
 * TradingView widget for the underlying equity.
 *
 * Deliberately scoped to the off-chain side. TradingView carries NASDAQ:NVDA —
 * the real stock — and has no data for the token on Robinhood Chain, so it
 * cannot replace the on-chain chart. Showing both side by side is the point:
 * one price is set by an exchange, the other by liquidity, and the gap between
 * them is what this product is about.
 */
export function TradingViewChart({
  symbol,
  exchange,
  height = 320,
}: {
  symbol: string;
  exchange?: string | null;
  height?: number;
}) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = container.current;
    if (!node) return;

    // Exchange prefixes vary ("NASDAQ NMS - GLOBAL MARKET"); the bare ticker
    // lets TradingView resolve the listing itself, which is more reliable than
    // guessing a prefix and rendering an empty chart.
    const resolved = exchange?.toUpperCase().includes("NYSE")
      ? `NYSE:${symbol}`
      : exchange?.toUpperCase().includes("NASDAQ")
        ? `NASDAQ:${symbol}`
        : symbol;

    const script = document.createElement("script");
    script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.async = true;
    script.innerHTML = JSON.stringify({
      symbol: resolved,
      interval: "60",
      timezone: "America/New_York",
      theme: "light",
      style: "3", // area — quieter than candles beside our own chart
      locale: "en",
      hide_top_toolbar: true,
      hide_legend: false,
      allow_symbol_change: false,
      save_image: false,
      calendar: false,
      backgroundColor: "#fdfbf5",
      gridColor: "rgba(227, 215, 193, 0.6)",
      autosize: true,
    });

    node.appendChild(script);

    return () => {
      // The widget injects an iframe as a sibling; clearing the container
      // removes both so a symbol change cannot stack two charts.
      node.innerHTML = "";
    };
  }, [symbol, exchange]);

  return (
    <div
      className="overflow-hidden rounded-lg border border-line-soft bg-paper"
      style={{ height }}
    >
      <div ref={container} className="tradingview-widget-container h-full w-full">
        <div className="tradingview-widget-container__widget h-full w-full" />
      </div>
    </div>
  );
}
