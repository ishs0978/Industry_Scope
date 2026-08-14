import { describe, expect, it } from "vitest";
import { compsRows, type CompsSource } from "./comps";
import type { CompanyFact } from "./types";

const fact = (period: string, metric: string, value: number | null): CompanyFact => ({
  cik: "0000000001", ticker: "TEST", fiscal_period: period, metric, value, filed_date: "2026-01-01",
});

const source = (companyFacts: CompanyFact[]): CompsSource => ({ companyFacts, companyMeta: [] });

describe("comps revenue growth", () => {
  it("returns null when the two periods report different revenue tags", () => {
    const rows = compsRows(source([
      fact("CY2025Q2", "Revenues", 1_200),
      fact("CY2024Q2", "RevenueFromContractWithCustomerExcludingAssessedTax", 1_000),
    ]));
    expect(rows).toHaveLength(1);
    // Pairing the two tags would fabricate +20%.
    expect(rows[0].revenueGrowth).toBeNull();
  });

  it("computes growth when both periods report the same tag", () => {
    const rows = compsRows(source([
      fact("CY2025Q2", "Revenues", 1_200),
      fact("CY2024Q2", "Revenues", 1_000),
    ]));
    expect(rows[0].revenueGrowth).toBeCloseTo(0.2);
  });

  it("prefers the resolved tag over another tag present in the prior period", () => {
    const rows = compsRows(source([
      fact("CY2025Q2", "Revenues", 1_200),
      fact("CY2024Q2", "Revenues", 800),
      fact("CY2024Q2", "RevenueFromContractWithCustomerExcludingAssessedTax", 1_000),
    ]));
    expect(rows[0].revenueGrowth).toBeCloseTo(0.5);
  });

  it("returns null instead of guessing a prior period by index", () => {
    // Five mixed periods with no matching fiscal suffix. The old `?? periods[4]`
    // fallback would have paired CY2025Q3 against whatever sorted fifth.
    const rows = compsRows(source([
      fact("CY2025Q3", "Revenues", 1_500),
      fact("CY2025Q2", "Revenues", 1_400),
      fact("CY2025Q1", "Revenues", 1_300),
      fact("CY2024", "Revenues", 1_200),
      fact("CY2023", "Revenues", 1_100),
    ]));
    expect(rows[0].period).toBe("CY2025Q3");
    expect(rows[0].revenueGrowth).toBeNull();
  });

  it("keeps margins on the resolved revenue tag", () => {
    const rows = compsRows(source([
      fact("CY2025Q2", "Revenues", 1_000),
      fact("CY2025Q2", "GrossProfit", 400),
      fact("CY2025Q2", "NetIncomeLoss", 100),
    ]));
    expect(rows[0].grossMargin).toBeCloseTo(0.4);
    expect(rows[0].netMargin).toBeCloseTo(0.1);
    expect(rows[0].operatingMargin).toBeNull();
  });
});
