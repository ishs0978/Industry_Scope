import { describe, expect, it } from "vitest";
import { flatQuartiles, periodEnd } from "../scripts/check-export";

describe("export guards", () => {
  it("reads the end of each fiscal-period label the exports actually carry", () => {
    // The labels are not uniform: CY2026Q2, FY2026FY and a bare CY2019 all
    // appear, and a string sort of them is not a sort by time.
    expect(periodEnd("CY2026Q2")?.toISOString().slice(0, 10)).toBe("2026-06-30");
    expect(periodEnd("FY2026Q4")?.toISOString().slice(0, 10)).toBe("2026-12-31");
    expect(periodEnd("CY2019")?.toISOString().slice(0, 10)).toBe("2019-12-31");
    expect(periodEnd("FY2026FY")?.toISOString().slice(0, 10)).toBe("2026-12-31");
  });

  it("does not invent a date for a label it cannot read", () => {
    // A period shown as filed is a signal; a guessed date would bury it.
    expect(periodEnd("CY2026Q2I")?.toISOString().slice(0, 10)).toBe("2026-06-30");
    expect(periodEnd("whatever")).toBeNull();
    expect(periodEnd(null)).toBeNull();
  });

  it("spots three identical quartiles, which one company guarantees", () => {
    // Utilities showed 15.46% at the 25th, the median and the 75th because
    // exactly one company reported a gross margin.
    expect(flatQuartiles([0.1546, 0.1546, 0.1546])).toBe(true);
    expect(flatQuartiles([0.12, 0.1546, 0.19])).toBe(false);
    expect(flatQuartiles([null, 0.1546, 0.1546])).toBe(false);
  });
});
