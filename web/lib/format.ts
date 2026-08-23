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

/**
 * Signed percent using the same glyphs as formatPriceChange.
 * The pair is always read together ("+0.85 (+1.39%)"), so one half carrying a
 * sign while the other does not, or the two using different minus characters,
 * reads as a typo.
 */
export function formatSignedPercent(value: number | null, digits = 2): string {
  return value === null || !Number.isFinite(value)
    ? "—"
    : `${value >= 0 ? "+" : "−"}${Math.abs(value * 100).toFixed(digits)}%`;
}

/**
 * Strip the exception class name that ingest stores in front of a failure
 * message. `SourceUnavailable: ...` is useful in ingest_runs and meaningless to
 * a reader looking at a panel.
 */
export function readableError(value: string | null | undefined): string {
  if (!value) return "Last ingest failed";
  return value.replace(/^[A-Za-z_][A-Za-z0-9_.]*(?:Error|Exception|Unavailable):\s*/, "").trim()
    || "Last ingest failed";
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


/**
 * US state and country names for the codes EDGAR uses on Form D.
 *
 * The filing carries a two-character code, and the table printed it raw: rows
 * reading D0, A8, X0 and G7, which mean nothing to a reader. The state codes
 * are postal; the letter-digit codes are EDGAR's own country list.
 */
const EDGAR_PLACES: Record<string, string> = {
  A0: "Alberta", A1: "British Columbia", A2: "Manitoba", A3: "New Brunswick",
  A4: "Newfoundland", A5: "Nova Scotia", A6: "Ontario", A7: "Prince Edward Island",
  A8: "Quebec", A9: "Saskatchewan", B0: "Yukon", B2: "Israel", B3: "Australia",
  C3: "China", D0: "Germany", D8: "Guernsey", E9: "France", F4: "Ireland",
  G7: "Jersey", H6: "Luxembourg", K3: "Netherlands", L3: "Singapore",
  L6: "Spain", N4: "Switzerland", U0: "United Kingdom", X0: "United Kingdom",
  Y6: "Cayman Islands", Y7: "British Virgin Islands", Y8: "Bermuda",
  Z4: "Canada", B0X: "Yukon",
};

export function placeName(code: string | null | undefined): string {
  const value = (code ?? "").trim().toUpperCase();
  if (!value) return "—";
  // A real postal abbreviation is two letters; EDGAR's country codes mix a
  // letter with a digit, which is how you can tell them apart.
  if (/^[A-Z]{2}$/.test(value)) return value;
  return EDGAR_PLACES[value] ?? value;
}

/**
 * "1 filing", "2 filings" — agreeing the verb as well as the noun.
 *
 * The generated prose read "1 filing restate an offering" and "1 offering
 * appear here only as amendments, their originals...", which is the kind of
 * thing that makes a careful page look careless.
 */
export function plural(count: number, singular: string, pluralForm?: string): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : (pluralForm ?? `${singular}s`)}`;
}

export function verb(count: number, singular: string, pluralForm: string): string {
  return count === 1 ? singular : pluralForm;
}


/**
 * Ticks that land in distinct months.
 *
 * The axis formatter renders any date in September 2025 as "Sep 25", and the
 * chart library spaces ticks by pixels, so two ticks a fortnight apart both
 * read "Sep 25" and the axis looks broken while the series behind it is fine.
 * Choosing the ticks explicitly, one per month at most, removes the collision
 * rather than papering over it.
 */
export function distinctMonthTicks(dates: string[], target = 8): string[] {
  if (dates.length <= target) return dates;
  const step = Math.max(1, Math.floor(dates.length / target));
  const seen = new Set<string>();
  const picked: string[] = [];
  for (let index = 0; index < dates.length; index += step) {
    const month = dates[index].slice(0, 7);
    if (seen.has(month)) continue;
    seen.add(month);
    picked.push(dates[index]);
  }
  const last = dates.at(-1)!;
  if (!seen.has(last.slice(0, 7))) picked.push(last);
  return picked;
}
