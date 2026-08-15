import { describe, expect, it } from "vitest";
import { formatMoney, formatNumber, formatPercent, formatPrice, formatPriceChange, formatSignedPercent, formatUnitValue, isStale, readableError, relativeTime, stamp, stampDate } from "./format";

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
