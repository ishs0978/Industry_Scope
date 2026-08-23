import { describe, expect, it } from "vitest";
import { formatMoney, formatNumber, formatPercent, formatPrice, formatPriceChange, formatSignedPercent, formatUnitValue, isStale, readableError, relativeTime, stamp, stampDate, placeName, plural, verb, distinctMonthTicks } from "./format";

describe("numeric presentation", () => {
  it("limits displayed values to two decimal places", () => {
    expect(formatNumber(12.345678)).toBe("12.35");
    expect(formatPercent(0.123456)).toBe("12.35%");
  });

  it("adds currency signs and source units", () => {
    expect(formatMoney(68_123_456_789)).toBe("$68.12B");
    expect(formatUnitValue(87.654, "Percent")).toBe("87.65%");
    expect(formatUnitValue(1234.567, "Thousand Barrels")).toBe("1,234.57 Thousand Barrels");
  });
});

describe("timestamps", () => {
  const now = Date.parse("2026-08-14T18:00:00Z");

  it("always prints a zone", () => {
    // A bare time with no zone is not a timestamp.
    expect(stamp("2026-08-14T13:31:00Z")).toMatch(/E[SD]T$/);
  });

  it("reports unavailable rather than Invalid Date", () => {
    expect(stamp(null)).toBe("unavailable");
    expect(stamp("not a date")).toBe("unavailable");
    expect(stampDate(undefined)).toBe("unavailable");
  });

  it("labels anything inside 48 hours relatively", () => {
    expect(relativeTime("2026-08-14T15:00:00Z", now)).toBe("3 hours ago");
    expect(relativeTime("2026-08-14T17:40:00Z", now)).toBe("less than an hour ago");
    expect(relativeTime("2026-08-14T17:00:00Z", now)).toBe("1 hour ago");
    expect(relativeTime("2026-08-10T18:00:00Z", now)).toBeNull();
  });

  it("treats a missing or old check as stale", () => {
    expect(isStale(null, 48, now)).toBe(true);
    expect(isStale("2026-08-14T06:00:00Z", 48, now)).toBe(false);
    expect(isStale("2026-08-11T06:00:00Z", 48, now)).toBe(true);
  });
});

describe("prices", () => {
  it("never uses compact notation for a share price", () => {
    // formatMoney would render this as $1.23K, which is right for fund assets
    // and wrong for a quote.
    expect(formatPrice(1234.5)).toBe("$1234.50");
    expect(formatPrice(92.181)).toBe("$92.18");
    expect(formatPrice(null)).toBe("—");
  });

  it("signs a day change", () => {
    expect(formatPriceChange(0.38)).toBe("+0.38");
    expect(formatPriceChange(-0.38)).toBe("−0.38");
    expect(formatPriceChange(null)).toBe("—");
  });
});

describe("date-only helpers tolerate bad input", () => {
  it("does not throw on a non-ISO date string", () => {
    // The postgres driver returns a JS Date for date columns; String() on that
    // gives "Sat Aug 15 2026 …", which slice(0,10) turns into "Sat Aug 15".
    // This crashed the home page with RangeError: Invalid time value.
    expect(() => stampDate("Sat Aug 15 2026 00:00:00 GMT+0000")).not.toThrow();
    expect(stampDate("Sat Aug 15 2026 00:00:00 GMT+0000")).toBe("unavailable");
    expect(stampDate("2026-08-15")).toBe("Aug 15, 2026");
  });
});

describe("signed percent and readable errors", () => {
  it("signs both halves of a change with the same glyph", () => {
    // "+0.85 (1.39%)" read as a typo: dollars signed, percent not.
    expect(formatSignedPercent(0.0139)).toBe("+1.39%");
    expect(formatSignedPercent(-0.0022)).toBe("−0.22%");
    expect(formatSignedPercent(-0.0022)[0]).toBe(formatPriceChange(-1.3)[0]);
    expect(formatSignedPercent(null)).toBe("—");
  });

  it("strips the exception class ingest stores in front of a message", () => {
    // Readers were shown "SourceUnavailable: GDELT failed for 1 sector ranges".
    expect(readableError("SourceUnavailable: could not collect news volume for 1 of 21 sectors"))
      .toBe("could not collect news volume for 1 of 21 sectors");
    expect(readableError("RuntimeError: boom")).toBe("boom");
    expect(readableError("psycopg.OperationalError: timeout")).toBe("timeout");
    // A plain message is left alone, and a missing one still says something.
    expect(readableError("Issuer feed returned HTML")).toBe("Issuer feed returned HTML");
    expect(readableError(null)).toBe("Last ingest failed");
    expect(readableError("SourceUnavailable:")).toBe("Last ingest failed");
  });
});

describe("EDGAR place codes", () => {
  it("names the countries behind the codes the filing carries", () => {
    // The Form D table printed these raw: D0, A8, X0, G7 mean nothing to a
    // reader, and they are not typos.
    expect(placeName("D0")).toBe("Germany");
    expect(placeName("A8")).toBe("Quebec");
    expect(placeName("X0")).toBe("United Kingdom");
    expect(placeName("G7")).toBe("Jersey");
    expect(placeName("F4")).toBe("Ireland");
  });

  it("leaves a real postal abbreviation alone", () => {
    expect(placeName("NY")).toBe("NY");
    expect(placeName("TX")).toBe("TX");
  });

  it("shows an unknown code rather than dropping it", () => {
    expect(placeName("Q9")).toBe("Q9");
    expect(placeName(null)).toBe("—");
    expect(placeName("")).toBe("—");
  });
});

describe("pluralisation", () => {
  it("agrees the noun and the verb", () => {
    // "1 filing restate an offering" and "1 of these have been amended" both
    // shipped.
    expect(plural(1, "filing")).toBe("1 filing");
    expect(plural(2, "filing")).toBe("2 filings");
    expect(`${plural(1, "filing")} ${verb(1, "restates", "restate")}`).toBe("1 filing restates");
    expect(`${plural(3, "filing")} ${verb(3, "restates", "restate")}`).toBe("3 filings restate");
  });
});

describe("axis ticks", () => {
  it("never renders two ticks in the same month", () => {
    // The formatter shows "Sep 25" for any September date, so two ticks a
    // fortnight apart both read the same and the axis looks broken.
    const dates: string[] = [];
    for (let day = 0; day < 400; day += 1) {
      dates.push(new Date(Date.UTC(2025, 8, 1) + day * 86400000).toISOString().slice(0, 10));
    }
    const ticks = distinctMonthTicks(dates);
    const months = ticks.map((tick) => tick.slice(0, 7));
    expect(new Set(months).size).toBe(months.length);
    expect(ticks.at(-1)).toBe(dates.at(-1));
  });

  it("leaves a short series alone", () => {
    const dates = ["2026-01-01", "2026-02-01", "2026-03-01"];
    expect(distinctMonthTicks(dates)).toEqual(dates);
  });
});
