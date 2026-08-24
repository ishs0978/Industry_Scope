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
 * EDGAR's own state and country codes, as published by the SEC.
 *
 * Taken verbatim from https://www.sec.gov/Archives/edgar/lookup-data.js, the
 * table EDGAR's own search uses. It replaced a hand-written list of 31 codes,
 * 18 of which were wrong: U0 was labelled United Kingdom and is Singapore, K3
 * was Netherlands and is Hong Kong, D0 was Germany and is Bermuda, Y8 was
 * Bermuda and is Isle of Man. A guessed country name is worse than a raw code,
 * because a reader cannot tell that it is a guess.
 *
 * Two-letter postal abbreviations are passed through by placeName and are not
 * repeated here. 254 codes, covering every value in the Form D data.
 */
const EDGAR_PLACES: Record<string, string> = {
  "1A": "Anguilla", "1B": "Armenia", "1C": "Aruba", "1D": "Azerbaijan",
  "1E": "Bosnia and Herzegovina", "1F": "Belarus", "1G": "Djibouti", "1H": "Estonia",
  "1J": "Eritrea", "1K": "Micronesia, Federated States of",
  "1L": "South Georgia and the South Sandwich Islands", "1M": "Croatia", "1N": "Kyrgyzstan",
  "1P": "Kazakhstan", "1Q": "Lithuania", "1R": "Latvia", "1S": "Moldova, Republic of",
  "1T": "Marshall Islands", "1U": "Macedonia, the Former Yugoslav Republic of",
  "1V": "Northern Mariana Islands", "1W": "New Caledonia", "1X": "Palestinian Territory, Occupied",
  "1Y": "Palau", "1Z": "Russian Federation", "2A": "Slovenia", "2B": "Slovakia",
  "2C": "French Southern Territories", "2D": "Tajikistan", "2E": "Turkmenistan", "2G": "Tuvalu",
  "2H": "Ukraine", "2J": "United States Minor Outlying Islands", "2K": "Uzbekistan",
  "2L": "Vanuatu", "2M": "Germany", "2N": "Czech Republic", "2P": "Mayotte",
  "2Q": "Georgia (country)", "A0": "Alberta, Canada", "A1": "British Columbia, Canada",
  "A2": "Manitoba, Canada", "A3": "New Brunswick, Canada", "A4": "Newfoundland, Canada",
  "A5": "Nova Scotia, Canada", "A6": "Ontario, Canada", "A7": "Prince Edward Island, Canada",
  "A8": "Quebec, Canada", "A9": "Saskatchewan, Canada", "B0": "Yukon, Canada", "B1": "Botswana",
  "B2": "Afghanistan", "B3": "Albania", "B4": "Algeria", "B5": "American Samoa", "B6": "Andorra",
  "B7": "Angola", "B8": "Antarctica", "B9": "Antigua and Barbuda", "C0": "United Arab Emirates",
  "C1": "Argentina", "C3": "Australia", "C4": "Austria", "C5": "Bahamas", "C6": "Bahrain",
  "C7": "Bangladesh", "C8": "Barbados", "C9": "Belgium", "D0": "Bermuda", "D1": "Belize",
  "D2": "Bhutan", "D3": "Bolivia", "D4": "Bouvet Island", "D5": "Brazil",
  "D6": "British Indian Ocean Territory", "D7": "Solomon Islands", "D8": "Virgin Islands, British",
  "D9": "Brunei Darussalam", "E0": "Bulgaria", "E1": "Myanmar", "E2": "Burundi", "E3": "Cambodia",
  "E4": "Cameroon", "E8": "Cape Verde", "E9": "Cayman Islands", "F0": "Central African Republic",
  "F1": "Sri Lanka", "F2": "Chad", "F3": "Chile", "F4": "China", "F5": "Taiwan",
  "F6": "Christmas Island", "F7": "Cocos (Keeling) Islands", "F8": "Colombia", "F9": "Comoros",
  "G0": "Congo", "G1": "Cook Islands", "G2": "Costa Rica", "G3": "Cuba", "G4": "Cyprus",
  "G6": "Benin", "G7": "Denmark", "G8": "Dominican Republic", "G9": "Dominica", "H1": "Ecuador",
  "H2": "Egypt", "H3": "El Salvador", "H4": "Equatorial Guinea", "H5": "Ethiopia",
  "H6": "Faroe Islands", "H7": "Falkland Islands (Malvinas)", "H8": "Fiji", "H9": "Finland",
  "I0": "France", "I3": "French Guiana", "I4": "French Polynesia", "I5": "Gabon", "I6": "Gambia",
  "J0": "Ghana", "J1": "Gibraltar", "J2": "Kiribati", "J3": "Greece", "J4": "Greenland",
  "J5": "Grenada", "J6": "Guadeloupe", "J8": "Guatemala", "J9": "Guinea", "K0": "Guyana",
  "K1": "Haiti", "K2": "Honduras", "K3": "Hong Kong", "K4": "Heard Island and Mcdonald Islands",
  "K5": "Hungary", "K6": "Iceland", "K7": "India", "K8": "Indonesia",
  "K9": "Iran, Islamic Republic of", "L0": "Iraq", "L2": "Ireland", "L3": "Israel", "L6": "Italy",
  "L7": "Cote D'ivoire ", "L8": "Jamaica", "L9": "Svalbard and Jan Mayen", "M0": "Japan",
  "M2": "Jordan", "M3": "Kenya", "M4": "Korea, Democratic People's Republic of ",
  "M5": "Korea, Republic of", "M6": "Kuwait", "M7": "Lao People's Democratic Republic ",
  "M8": "Lebanon", "M9": "Lesotho", "N0": "Liberia", "N1": "Libyan Arab Jamahiriya",
  "N2": "Liechtenstein", "N4": "Luxembourg", "N5": "Macau", "N6": "Madagascar", "N7": "Malawi",
  "N8": "Malaysia", "N9": "Maldives", "O0": "Mali", "O1": "Malta", "O2": "Martinique",
  "O3": "Mauritania", "O4": "Mauritius", "O5": "Mexico", "O9": "Monaco", "P0": "Mongolia",
  "P1": "Montserrat", "P2": "Morocco", "P3": "Mozambique", "P4": "Oman", "P5": "Nauru",
  "P6": "Nepal", "P7": "Netherlands", "P8": "Netherlands Antilles", "Q1": "Viet Nam",
  "Q2": "New Zealand", "Q3": "Nicaragua", "Q4": "Niger", "Q5": "Nigeria", "Q6": "Niue",
  "Q7": "Norfolk Island", "Q8": "Norway", "R0": "Pakistan", "R1": "Panama",
  "R2": "Papua New Guinea", "R4": "Paraguay", "R5": "Peru", "R6": "Philippines", "R8": "Pitcairn",
  "R9": "Poland", "S0": "Guinea-bissau", "S1": "Portugal", "S3": "Qatar", "S4": "Reunion",
  "S5": "Romania", "S6": "Rwanda", "S8": "San Marino", "S9": "Sao Tome and Principe",
  "T0": "Saudi Arabia", "T1": "Senegal", "T2": "Seychelles", "T3": "South Africa", "T6": "Namibia",
  "T7": "Yemen", "T8": "Sierra Leone", "U0": "Singapore", "U1": "Somalia", "U3": "Spain",
  "U5": "Western Sahara", "U7": "Saint Kitts and Nevis", "U8": "Saint Helena", "U9": "Saint Lucia",
  "V0": "Saint Pierre and Miquelon", "V1": "Saint Vincent and the Grenadines", "V2": "Sudan",
  "V3": "Suriname", "V6": "Swaziland", "V7": "Sweden", "V8": "Switzerland",
  "V9": "Syrian Arab Republic", "W0": "Tanzania, United Republic of", "W1": "Thailand",
  "W2": "Togo", "W3": "Tokelau", "W4": "Tonga", "W5": "Trinidad and Tobago", "W6": "Tunisia",
  "W7": "Turks and Caicos Islands", "W8": "Turkey", "W9": "Uganda", "X0": "United Kingdom",
  "X1": "United States", "X2": "Burkina Faso", "X3": "Uruguay",
  "X4": "Holy See (Vatican City State)", "X5": "Venezuela", "X8": "Wallis and Futuna",
  "Y0": "Samoa", "Y3": "Congo, the Democratic Republic of the", "Y4": "Zambia", "Y5": "Zimbabwe",
  "Y6": "Aland Islands", "Y7": "Guernsey", "Y8": "Isle of Man", "Y9": "Jersey",
  "Z0": "Saint Barthelemy", "Z1": "Saint Martin", "Z2": "Serbia", "Z3": "Timor-leste",
  "Z4": "Canada (Federal Level)", "Z5": "Montenegro"
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
