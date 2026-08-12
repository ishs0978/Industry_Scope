import { describe, expect, it } from "vitest";
import { formatMoney, formatNumber, formatPercent, formatUnitValue } from "./format";

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
