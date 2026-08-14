export function usd(value: number | null, opts: { compact?: boolean } = {}): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (opts.compact) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(value);
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function compact(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function count(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US").format(value);
}

/** Multipliers need many decimals — a 0.006% dividend accrual must stay visible. */
export function multiplier(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const decimals = Math.abs(value - 1) < 0.001 ? 8 : 6;
  return value.toFixed(decimals);
}

export function signedPct(value: number | null, decimals = 4): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (Math.abs(value) < 1e-9) return "0.00%";
  const abs = Math.abs(value);
  const d = abs >= 10 ? 2 : abs >= 1 ? 3 : decimals;
  return `${value > 0 ? "+" : "−"}${abs.toFixed(d)}%`;
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function relativeTime(iso: string): string {
  const delta = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.round(delta / 60)}m ago`;
  return `${Math.round(delta / 3600)}h ago`;
}
