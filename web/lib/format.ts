const compactUsd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatMoney(value: number): string {
  return Number.isFinite(value) ? compactUsd.format(value) : "—";
}

/**
 * Share prices, not fund assets. formatMoney uses compact notation and would
 * render a four-figure price as $1.23K, which is right for AUM and wrong for a
 * quote a reader will check against a broker.
 */
export function formatPrice(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "—" : `$${value.toFixed(2)}`;
}

/** Signed to the cent, for a day-over-day move. */
export function formatPriceChange(value: number | null): string {
  return value === null || !Number.isFinite(value)
    ? "—"
    : `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(2)}`;
}

export function formatPercent(value: number | null, digits = 2): string {
  return value === null || !Number.isFinite(value) ? "—" : `${(value * 100).toFixed(digits)}%`;
}

export function formatNumber(value: number | null): string {
  return value === null || !Number.isFinite(value)
    ? "—"
    : value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatUnitValue(value: number, units?: string | null): string {
  if (!Number.isFinite(value)) return "—";
  const label = units?.trim();
  if (!label) return formatNumber(value);
  if (/percent/i.test(label)) return `${value.toFixed(2)}%`;
  if (/\b(?:usd|dollars?)\b/i.test(label)) return `$${formatNumber(value)}`;
  return `${formatNumber(value)} ${label}`;
}
