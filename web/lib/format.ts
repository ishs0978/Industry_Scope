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

/**
 * The one timestamp format. Always prints the zone: a bare time with no zone is
 * not a timestamp, and every date on this site is meaningful only in market
 * time.
 */
export function stamp(value: string | null | undefined): string {
  if (!value) return "unavailable";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "unavailable";
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric", month: "short", year: "numeric",
    hour: "numeric", minute: "2-digit",
    timeZone: "America/New_York", timeZoneName: "short",
  }).format(parsed);
}

/** Date only, for series observations that carry no time of day. */
export function stampDate(value: string | null | undefined): string {
  if (!value) return "unavailable";
  const parsed = new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return "unavailable";
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
  }).format(parsed);
}

const HOUR = 3_600_000;

/** "3 hours ago" for anything inside 48 hours, otherwise null. */
export function relativeTime(value: string | null | undefined, now = Date.now()): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  const elapsed = now - parsed;
  if (elapsed < 0 || elapsed > 48 * HOUR) return null;
  const hours = Math.floor(elapsed / HOUR);
  if (hours < 1) return "less than an hour ago";
  if (hours === 1) return "1 hour ago";
  return `${hours} hours ago`;
}

export function isStale(value: string | null | undefined, hours = 48, now = Date.now()): boolean {
  if (!value) return true;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) || now - parsed > hours * HOUR;
}

export function formatUnitValue(value: number, units?: string | null): string {
  if (!Number.isFinite(value)) return "—";
  const label = units?.trim();
  if (!label) return formatNumber(value);
  if (/percent/i.test(label)) return `${value.toFixed(2)}%`;
  if (/\b(?:usd|dollars?)\b/i.test(label)) return `$${formatNumber(value)}`;
  return `${formatNumber(value)} ${label}`;
}
