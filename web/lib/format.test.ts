import { describe, expect, it } from "vitest";
import { formatMoney, formatNumber, formatPercent, formatPrice, formatPriceChange, formatUnitValue, isStale, relativeTime, stamp, stampDate } from "./format";

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
